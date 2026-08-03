// Свадебный блок: штаб «15 августа», прогон по делам и режим «День X».
// Всё живёт на существующих таблицах: tasks (тег 'wedding'), chat_flags, pinned, timeline.
import * as db from '../db.js'
import * as tg from '../telegram.js'
import { eventBoard } from '../visual.js'
import { esc, plural, ASSIGNEE_LABEL } from '../format.js'
import {
  localParts, localToUtcIso, localDateKey, startOfLocalDay, addDays, addMinutes,
  formatTime, formatDateHuman,
} from '../time.js'

export const WEDDING_TAG = 'wedding'
export const DEFAULT_WEDDING_DATE = '2026-08-15'
export const PINNED_KIND = 'wedding'
export const FLAG_WEDDING_DATE = 'wedding_date'
export const FLAG_QUIET_DAY = 'quiet_day'
export const FLAG_CHECKUP_QUEUE = 'checkup_queue'

// За сколько минут до пункта таймлайна бот подаёт голос.
export const TIMELINE_AHEAD_MIN = 40

// Куда переезжают хвосты вечером дня свадьбы.
const AFTER_DAY = 17

const ICON = { danya: '🐊', zhenya: '🐈‍⬛', both: '👫' }
const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

export const WEDDING_DAY_CHECKLIST = [
  'Кольца',
  'Паспорта',
  'Зарядки и павербанк',
  'Наличные',
  'Номера подрядчиков в телефоне',
  'Сменная обувь',
  'Набор для макияжа',
  'Вода',
]

function chatDefaults(env) {
  return {
    tz: env.DEFAULT_TZ ?? 'Europe/Moscow',
    digestTime: env.DEFAULT_DIGEST_TIME ?? '10:00',
    remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN ?? 30) || 30,
  }
}

const chatOf = (env, chatId) => db.getChat(env.DB, chatId, chatDefaults(env))

const remindOffset = (chat) => Number(chat?.remind_before_min ?? 30) || 30

// '2026-08-15' → UTC ISO полуночи этого дня по местному времени.
function dateKeyToIso(key, tz) {
  const m = DATE_KEY.exec(String(key ?? ''))
  const [year, month, day] = m
    ? [Number(m[1]), Number(m[2]), Number(m[3])]
    : DEFAULT_WEDDING_DATE.split('-').map(Number)
  return localToUtcIso({ year, month, day, hour: 0, minute: 0 }, tz)
}

const icon = (who) => ICON[who] ?? ''

// ─────────────────────────── 1. Штаб «15 августа» ───────────────────────────

export function weddingBoardKeyboard() {
  return { inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'wb:refresh' }]] }
}

export async function renderWeddingBoard(env, chatId, nowIso) {
  const chat = await chatOf(env, chatId)
  const tz = chat.tz
  const dateKey = await db.getFlag(env.DB, chatId, FLAG_WEDDING_DATE)
  const targetIso = dateKeyToIso(dateKey, tz)
  const tasks = await db.tasksByTag(env.DB, chatId, WEDDING_TAG)

  // eventBoard вставляет название дела в HTML как есть, поэтому экранируем заранее.
  const safe = tasks.map((t) => ({ ...t, title: esc(t.title) }))

  const board = eventBoard({
    title: 'Свадьба',
    targetIso,
    tasks: safe,
    nowIso,
    tz,
    emoji: '💍',
  })

  const lines = [board]

  const undated = tasks.filter((t) => t.status === 'open' && !t.due_at)
  if (undated.length) {
    lines.push('')
    lines.push(`Без срока висит ${plural(undated.length, 'дело', 'дела', 'дел')} — им бы дату.`)
  }

  const open = tasks.filter((t) => t.status === 'open')
  const today = localDateKey(nowIso, tz)
  const burning = open.filter((t) => t.due_at && localDateKey(t.due_at, tz) === today)
  if (burning.length) {
    lines.push('')
    lines.push(`🔥 Сегодня горит: ${burning.map((t) => `${esc(t.title)} ${icon(t.assignee)}`.trim()).join(', ')}`)
  }

  return lines.join('\n')
}

// Отправляет штаб первый раз (и закрепляет) либо обновляет уже закреплённое сообщение.
// Если закреп удалили руками — редактирование падает, тогда шлём заново.
export async function refreshWeddingBoard(env, chatId, nowIso) {
  const text = await renderWeddingBoard(env, chatId, nowIso)
  const markup = weddingBoardKeyboard()
  const pinnedId = await db.getPinned(env.DB, chatId, PINNED_KIND)

  if (pinnedId) {
    try {
      await tg.editMessageText(env, chatId, pinnedId, text, { reply_markup: markup })
      return { messageId: pinnedId, created: false, text }
    } catch (e) {
      // «Сообщение не изменилось» — штатный ответ Telegram, когда за сутки ничего не поменялось.
      // Слать из-за него новый штаб означает засорять чат копиями.
      if (/not modified/i.test(e.message)) {
        return { messageId: pinnedId, created: false, text, unchanged: true }
      }
      console.error('штаб не обновился, шлём заново', e.message)
    }
  }

  const msg = await tg.sendMessage(env, chatId, text, { reply_markup: markup })
  const messageId = msg?.message_id
  try {
    await tg.pinMessage(env, chatId, messageId)
  } catch (e) {
    console.error('закрепить штаб не вышло', e.message)
  }
  await db.setPinned(env.DB, chatId, PINNED_KIND, messageId)
  return { messageId, created: true, text }
}

// ─────────────────────────────── 2. Прогон ───────────────────────────────

function checkupKeyboard(taskId) {
  return {
    inline_keyboard: [[
      { text: '✅ Подтверждено', callback_data: `ck:ok:${taskId}` },
      { text: '📞 Напомни завтра', callback_data: `ck:later:${taskId}` },
      { text: '⏭ Пропустить', callback_data: `ck:skip:${taskId}` },
    ]],
  }
}

function checklistKeyboard() {
  return {
    inline_keyboard: [[{ text: '📝 Завести недостающее', callback_data: 'ck:checklist' }]],
  }
}

export function checklistText() {
  const items = WEDDING_DAY_CHECKLIST.map((s) => `· ${esc(s)}`)
  return [
    '🎒 <b>Сумка дня свадьбы</b>',
    '',
    ...items,
    '',
    'Пробегитесь глазами. Чего нет под рукой — заведу делом на 14-е.',
  ].join('\n')
}

function questionText(task, queueLeft, { tz, nowIso }) {
  const head = `🔎 <b>Прогон</b> · осталось ${plural(queueLeft, 'дело', 'дела', 'дел')}`
  const lines = [head, '', `📌 <b>${esc(task.title)}</b>`]

  if (task.status === 'done') {
    lines.push('В списке помечено как закрытое.')
  } else if (task.due_at) {
    lines.push(`Ещё открыто, срок — ${formatDateHuman(task.due_at, tz, nowIso)}, ${formatTime(task.due_at, tz)}.`)
  } else {
    lines.push('Ещё открыто, срока нет.')
  }

  if (task.assignee) lines.push(`${icon(task.assignee)} ${ASSIGNEE_LABEL[task.assignee] ?? task.assignee}`)
  if (task.confirmed) lines.push('Подтверждение уже стоит.')

  lines.push('')
  lines.push('Подрядчик на связи и всё в силе на 15-е?')
  return lines.join('\n')
}

async function readQueue(env, chatId) {
  const raw = await db.getFlag(env.DB, chatId, FLAG_CHECKUP_QUEUE)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(Number).filter((n) => Number.isFinite(n)) : []
  } catch {
    return []
  }
}

const saveQueue = (env, chatId, queue) =>
  db.setFlag(env.DB, chatId, FLAG_CHECKUP_QUEUE, JSON.stringify(queue))

async function finishCheckup(env, chatId) {
  await db.deleteFlag(env.DB, chatId, FLAG_CHECKUP_QUEUE)
  await tg.sendMessage(env, chatId, checklistText(), { reply_markup: checklistKeyboard() })
  return { done: true, remaining: 0, taskId: null }
}

// Показывает первый пункт очереди. Пустая очередь означает конец прогона.
async function askNext(env, chatId, nowIso, queue, chat) {
  while (queue.length) {
    const taskId = queue[0]
    const task = await db.getTask(env.DB, taskId)
    if (!task || task.chat_id !== chatId || task.status === 'cancelled') {
      queue.shift()
      continue
    }
    await saveQueue(env, chatId, queue)
    await tg.sendMessage(env, chatId, questionText(task, queue.length, { tz: chat.tz, nowIso }),
      { reply_markup: checkupKeyboard(taskId) })
    return { done: false, remaining: queue.length, taskId }
  }
  return finishCheckup(env, chatId)
}

export async function startCheckup(env, chatId, nowIso) {
  const chat = await chatOf(env, chatId)
  const tasks = await db.tasksByTag(env.DB, chatId, WEDDING_TAG)

  if (!tasks.length) {
    await tg.sendMessage(env, chatId,
      '🔎 Прогонять нечего: свадебных дел с тегом в списке нет. Помечу их тегом — и повторим.')
    return { started: false, total: 0 }
  }

  const queue = tasks.map((t) => t.id)
  await saveQueue(env, chatId, queue)

  await tg.sendMessage(env, chatId, [
    '🔎 <b>Прогон свадебных дел</b>',
    '',
    `В списке ${plural(queue.length, 'дело', 'дела', 'дел')}. Пройдём по одному, закрытые тоже.`,
    'Смысл простой: подрядчик мог всё перепутать ещё в июле.',
  ].join('\n'))

  const step = await askNext(env, chatId, nowIso, queue, chat)
  return { started: true, total: queue.length, taskId: step.taskId }
}

// answer: { action: 'ok' | 'later' | 'skip', taskId } либо строка 'ck:ok:12' / 'ok:12'.
function parseAnswer(answer) {
  if (answer && typeof answer === 'object') {
    return { action: answer.action, taskId: Number(answer.taskId) }
  }
  const parts = String(answer ?? '').split(':').filter(Boolean)
  if (parts[0] === 'ck') parts.shift()
  return { action: parts[0], taskId: Number(parts[1]) }
}

export async function checkupStep(env, chatId, nowIso, answer) {
  const chat = await chatOf(env, chatId)
  const { action, taskId } = parseAnswer(answer)

  // Кнопка «Завести недостающее»: дальше человек просто перечисляет пункты реплаем,
  // а заводит их обычный разбор текста.
  if (action === 'checklist') {
    await db.deleteFlag(env.DB, chatId, FLAG_CHECKUP_QUEUE)
    await tg.sendMessage(env, chatId, [
      '📝 Перечисли реплаем, чего не хватает — через запятую.',
      'Заведу каждое делом на 14 августа, чтобы собрать сумку заранее.',
    ].join('\n'))
    return { done: true, remaining: 0, taskId: null, awaitingItems: true }
  }

  const task = Number.isFinite(taskId) ? await db.getTask(env.DB, taskId) : null

  if (task && task.chat_id === chatId) {
    if (action === 'ok') {
      await db.updateTask(env.DB, task.id, { confirmed: 1 })
    } else if (action === 'later') {
      await createFollowUp(env, chat, task, nowIso)
    }
  }

  const queue = (await readQueue(env, chatId)).filter((id) => id !== taskId)
  return askNext(env, chatId, nowIso, queue, chat)
}

// «Напомни завтра» — отдельное дело на завтра 13:00 по местному, тем же тегом.
async function createFollowUp(env, chat, task, nowIso) {
  const tomorrow = localParts(addDays(startOfLocalDay(nowIso, chat.tz), 1), chat.tz)
  const dueAt = localToUtcIso({
    year: tomorrow.year, month: tomorrow.month, day: tomorrow.day, hour: 13, minute: 0,
  }, chat.tz)

  return db.createTask(env.DB, {
    chat_id: chat.chat_id ?? task.chat_id,
    title: `Уточнить: ${task.title}`.slice(0, 200),
    due_at: dueAt,
    remind_at: addMinutes(dueAt, -remindOffset(chat)),
    assignee: task.assignee ?? 'both',
    created_by: task.created_by ?? 0,
    created_at: nowIso,
    tag: WEDDING_TAG,
  })
}

// ───────────────────────────── 3. Режим «День X» ─────────────────────────────

export async function isQuietDay(env, chatId, nowIso) {
  const chat = await chatOf(env, chatId)
  const flag = await db.getFlag(env.DB, chatId, FLAG_QUIET_DAY)
  if (!flag) return false
  return String(flag).trim() === localDateKey(nowIso, chat.tz)
}

export async function renderTimeline(env, chatId, nowIso) {
  const chat = await chatOf(env, chatId)
  const items = await db.timelineForChat(env.DB, chatId)

  if (!items.length) {
    return '⏱ <b>Таймлайн дня</b>\n\nПусто. Пунктов пока нет — добавим, и день соберётся по часам.'
  }

  const nowKey = localDateKey(nowIso, chat.tz)
  const rows = []
  for (const it of items) {
    const time = formatTime(it.at, chat.tz)
    const mark = localDateKey(it.at, chat.tz) === nowKey && new Date(it.at) <= new Date(nowIso) ? '·' : ' '
    rows.push(`${time} ${mark} ${esc(it.title)}`)
    if (it.contact) rows.push(`        ☎ ${esc(it.contact)}`)
  }

  return [
    `⏱ <b>Таймлайн дня</b> — ${plural(items.length, 'пункт', 'пункта', 'пунктов')}`,
    '',
    '<pre>',
    ...rows,
    '</pre>',
    'Кнопок переноса тут нет: свадьбу не переносят.',
  ].join('\n')
}

// Пункты, до которых осталось ≤ 40 минут. Шлём по каждому сообщение и помечаем.
export async function timelineTick(env, chatId, nowIso) {
  const chat = await chatOf(env, chatId)
  const aheadIso = addMinutes(nowIso, TIMELINE_AHEAD_MIN)
  const due = await db.timelineDue(env.DB, nowIso, aheadIso)
  const mine = due.filter((it) => Number(it.chat_id) === Number(chatId))
  const sent = []

  for (const it of mine) {
    const mins = Math.max(1, Math.round((new Date(it.at) - new Date(nowIso)) / 60000))
    const lines = [
      `⏳ Через ${plural(mins, 'минуту', 'минуты', 'минут')}: <b>${esc(it.title)}</b>`,
      `Время по плану — ${formatTime(it.at, chat.tz)}.`,
    ]
    if (it.contact) lines.push(`☎ ${esc(it.contact)}`)

    try {
      await tg.sendMessage(env, chatId, lines.join('\n'))
      await db.markTimelineNotified(env.DB, it.id)
      sent.push(it)
    } catch (e) {
      console.error('пункт таймлайна не ушёл', it.id, e.message)
    }
  }

  return sent
}

// Вечер дня свадьбы: поздравление и переезд всех незакрытых дел дня на 17-е.
export async function finishWeddingDay(env, chatId, nowIso) {
  const chat = await chatOf(env, chatId)
  const tz = chat.tz
  const from = startOfLocalDay(nowIso, tz)
  const to = addDays(from, 1)

  const tasks = await db.tasksOfDay(env.DB, chatId, from, to)
  const open = tasks.filter((t) => t.status === 'open')

  const p = localParts(nowIso, tz)
  // Если день свадьбы вдруг позже 17-го, переносим на 17-е следующего месяца:
  // localToUtcIso считает через Date.UTC, поэтому месяц 13 сам станет январём.
  const month = p.day >= AFTER_DAY ? p.month + 1 : p.month

  for (const t of open) {
    const src = t.due_at ? localParts(t.due_at, tz) : { hour: 12, minute: 0 }
    const due = localToUtcIso({
      year: p.year, month, day: AFTER_DAY, hour: src.hour, minute: src.minute,
    }, tz)
    await db.updateTask(env.DB, t.id, {
      due_at: due,
      remind_at: addMinutes(due, -remindOffset(chat)),
      notified_pre: 0,
      notified_due: 0,
    })
  }

  const tail = open.length
    ? `Переехало на 17-е: ${plural(open.length, 'дело', 'дела', 'дел')}. Руками ничего трогать не надо.`
    : 'Хвостов не осталось — всё закрыто.'

  const text = [
    '💍 <b>Ну вот и всё.</b>',
    '',
    'Поздравляю вас двоих. День случился, и он был ваш.',
    tail,
    '',
    'Завтра бот молчит до обеда.',
    '',
    '🐊 ❤️ 🐈‍⬛',
  ].join('\n')

  await tg.sendMessage(env, chatId, text)
  return { moved: open.length, text }
}
