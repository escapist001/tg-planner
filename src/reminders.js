import * as db from './db.js'
import * as tg from './telegram.js'
import { reminderText, digest, taskKeyboard } from './format.js'
import { localParts, localDateKey, startOfLocalDay, addDays } from './time.js'

// Если тик пропустил час дайджеста (сбой платформы), догоняем в пределах полутора часов.
// Шире делать нельзя: дайджест, пришедший к обеду, уже бесполезен.
const DIGEST_CATCHUP_MIN = 90

async function notify(env, task, nowIso, tz, kind) {
  const text = reminderText(task, { tz, nowIso, kind })
  await tg.sendMessage(env, task.chat_id, text, { reply_markup: taskKeyboard(task.id) })
  await db.markNotified(env.DB, task.id, kind)
}

export async function runTick(env, nowIso) {
  const stats = { pre: 0, due: 0, digests: 0 }
  const chatTz = new Map()

  const chats = await db.chatsForDigest(env.DB)
  for (const c of chats) chatTz.set(c.chat_id, c.tz)
  const tzOf = (chatId) => chatTz.get(chatId) ?? env.DEFAULT_TZ ?? 'Europe/Moscow'

  for (const task of await db.duePre(env.DB, nowIso)) {
    try {
      await notify(env, task, nowIso, tzOf(task.chat_id), 'pre')
      stats.pre++
    } catch (e) {
      console.error('pre-напоминание не ушло', task.id, e.message)
    }
  }

  for (const task of await db.dueNow(env.DB, nowIso)) {
    try {
      await notify(env, task, nowIso, tzOf(task.chat_id), 'due')
      stats.due++
    } catch (e) {
      console.error('напоминание не ушло', task.id, e.message)
    }
  }

  for (const chat of chats) {
    try {
      if (await maybeDigest(env, chat, nowIso)) stats.digests++
    } catch (e) {
      console.error('дайджест не ушёл', chat.chat_id, e.message)
    }
  }

  return stats
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

  await tg.sendMessage(env, chat.chat_id, digest(todayTasks, overdue, { tz, nowIso }))
  await db.markDigestSent(env.DB, chat.chat_id, today)
  return true
}
