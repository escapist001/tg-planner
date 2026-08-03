import * as db from './db.js'
import * as tg from './telegram.js'
import * as wedding from './features/wedding.js'
import * as pets from './features/pets.js'
import * as rituals from './features/rituals.js'
import * as teamwork from './features/teamwork.js'
import { reminderText, digest, taskKeyboard } from './format.js'
import { localParts, localDateKey, startOfLocalDay, addDays, addMinutes } from './time.js'

// Если тик пропустил час дайджеста (сбой платформы), догоняем в пределах полутора часов.
// Шире делать нельзя: дайджест, пришедший к обеду, уже бесполезен.
const DIGEST_CATCHUP_MIN = 90

async function notify(env, task, nowIso, tz, kind) {
  // Дежурство по питомцу уходит обоим с вопросом «кто идёт», а не именному исполнителю.
  if (pets.isPetDuty(task) && kind === 'due') {
    const duty = pets.dutyMessage(task, { tz, nowIso })
    await tg.sendMessage(env, task.chat_id, duty.text, { reply_markup: duty.reply_markup })
    await db.markNotified(env.DB, task.id, kind)
    return
  }

  const text = reminderText(task, { tz, nowIso, kind })
  await tg.sendMessage(env, task.chat_id, text, { reply_markup: taskKeyboard(task.id) })
  await db.markNotified(env.DB, task.id, kind)
}

export async function runTick(env, nowIso) {
  const stats = { pre: 0, due: 0, digests: 0, rituals: 0 }
  const chatTz = new Map()

  const chats = await db.chatsForDigest(env.DB)
  for (const c of chats) chatTz.set(c.chat_id, c.tz)
  const tzOf = (chatId) => chatTz.get(chatId) ?? env.DEFAULT_TZ ?? 'Europe/Moscow'

  // В день свадьбы обычные напоминания молчат: работает только таймлайн.
  const quiet = new Set()
  for (const c of chats) {
    try {
      if (await wedding.isQuietDay(env, c.chat_id, nowIso)) quiet.add(c.chat_id)
    } catch (e) {
      console.error('проверка тихого дня не удалась', c.chat_id, e.message)
    }
  }

  for (const task of await db.duePre(env.DB, nowIso)) {
    if (quiet.has(task.chat_id)) continue
    try {
      await notify(env, task, nowIso, tzOf(task.chat_id), 'pre')
      stats.pre++
    } catch (e) {
      console.error('pre-напоминание не ушло', task.id, e.message)
    }
  }

  for (const task of await db.dueNow(env.DB, nowIso)) {
    if (quiet.has(task.chat_id)) continue
    try {
      await notify(env, task, nowIso, tzOf(task.chat_id), 'due')
      stats.due++
    } catch (e) {
      console.error('напоминание не ушло', task.id, e.message)
    }
  }

  for (const chat of chats) {
    try {
      if (!quiet.has(chat.chat_id) && await maybeDigest(env, chat, nowIso)) stats.digests++
    } catch (e) {
      console.error('дайджест не ушёл', chat.chat_id, e.message)
    }
    try {
      stats.rituals += await runRituals(env, chat, nowIso, quiet.has(chat.chat_id))
    } catch (e) {
      console.error('ритуалы не отработали', chat.chat_id, e.message)
    }
  }

  // Раз в сутки убираем старые записи о виденных апдейтах.
  if (nowIso.slice(11, 16) === '04:00') {
    try {
      await db.pruneSeenUpdates(env.DB, addMinutes(nowIso, -60 * 24))
    } catch (e) {
      console.error('уборка seen_updates не прошла', e.message)
    }
  }

  return stats
}

// Ритуалы: таймлайн дня свадьбы, ночной разбор, воскресная сборка, полоса и штаб.
async function runRituals(env, chat, nowIso, isQuiet) {
  const chatId = chat.chat_id
  const tz = chat.tz
  let fired = 0

  if (isQuiet) {
    const sent = await wedding.timelineTick(env, chatId, nowIso)
    fired += sent.length
    const { hour, minute } = localParts(nowIso, tz)
    if (hour === 23 && minute < 5) {
      const res = await wedding.finishWeddingDay(env, chatId, nowIso)
      await tg.sendMessage(env, chatId, res.text)
      fired++
    }
    return fired
  }

  if (rituals.shouldRunReview(chat, nowIso)) {
    const review = await rituals.dayReview(env, chatId, nowIso)
    if (review) {
      await tg.sendMessage(env, chatId, review.text,
        review.reply_markup ? { reply_markup: review.reply_markup } : {})
      fired++
    }
    await env.DB.prepare('UPDATE chats SET last_review_date = ? WHERE chat_id = ?')
      .bind(localDateKey(nowIso, tz), chatId).run()

    // Полосу считаем сразу после разбора: день уже закончился.
    await rituals.updateStreak(env, chatId, nowIso, tz)
  }

  if (rituals.shouldRunWeekly(chat, nowIso)) {
    const assembly = await rituals.weeklyAssembly(env, chatId, nowIso)
    await tg.sendMessage(env, chatId, assembly.text,
      assembly.reply_markup ? { reply_markup: assembly.reply_markup } : {})
    const balance = await teamwork.weeklyBalance(env, chatId, nowIso)
    await tg.sendMessage(env, chatId, balance.text, { reply_markup: balance.reply_markup })
    await env.DB.prepare('UPDATE chats SET last_weekly_date = ? WHERE chat_id = ?')
      .bind(localDateKey(nowIso, tz), chatId).run()
    fired += 2
  }

  // Штаб свадьбы трогаем раз в сутки, вместе с дайджестом. Ежечасное обновление
  // засоряет чат ради одной изменившейся цифры.
  const { hour, minute } = localParts(nowIso, tz)
  if (hour === 12 && minute < 5) {
    try {
      await wedding.refreshWeddingBoard(env, chatId, nowIso)
    } catch (e) {
      console.error('штаб не обновился', e.message)
    }
  }

  return fired
}

async function maybeDigest(env, chat, nowIso) {
  const tz = chat.tz
  const today = localDateKey(nowIso, tz)
  if (chat.last_digest_date === today) return false

  const { hour, minute } = localParts(nowIso, tz)
  const [dh, dm] = String(chat.digest_time).split(':').map(Number)
  const nowMin = hour * 60 + minute
  const targetMin = dh * 60 + dm
  if (nowMin < targetMin || nowMin > targetMin + DIGEST_CATCHUP_MIN) return false

  const from = startOfLocalDay(nowIso, tz)
  const to = addDays(from, 1)
  const todayTasks = await db.tasksBetween(env.DB, chat.chat_id, from, to)
  const overdue = await db.overdueTasks(env.DB, chat.chat_id, from)

  let text = digest(todayTasks, overdue, { tz, nowIso })

  // Полоса без просрочек и счёт взаимовыручки — по строке, без салютов.
  try {
    const streak = await rituals.streakForDigest(env, chat.chat_id)
    if (streak) text += `\n\n${streak}`
    const stats = await db.allStats(env.DB, chat.chat_id)
    const help = teamwork.handoffSummary(stats)
    if (help) text += `\n${help}`
    const duty = pets.dutyBalance(stats)
    if (duty) text += `\n${duty}`
  } catch (e) {
    console.error('строки статистики не собрались', e.message)
  }

  await tg.sendMessage(env, chat.chat_id, text)
  await db.markDigestSent(env.DB, chat.chat_id, today)

  // В последний день месяца — карточка-открытка отдельным файлом.
  try {
    const card = await rituals.monthlyCard(env, chat.chat_id, nowIso, tz)
    if (card) {
      await tg.sendDocument(env, chat.chat_id, {
        filename: card.filename, content: card.html, caption: card.caption, mime: 'text/html',
      })
    }
  } catch (e) {
    console.error('месячная карточка не ушла', e.message)
  }

  return true
}
