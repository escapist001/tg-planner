// Ритуалы сов: пара живёт с 12:00, поэтому «вечер» у них около 23:30,
// а неделя закрывается воскресным вечером.
// Здесь три вещи: полночная планёрка (идея 11), воскресная сборка (идея 12)
// и чистая полоса без просрочек с месячной карточкой (идея 16).
import * as db from '../db.js'
import * as tg from '../telegram.js'
import { weekMap, streakLine, monthCardHtml } from '../visual.js'
import { esc, plural } from '../format.js'
import {
  localParts, localToUtcIso, localDateKey, startOfLocalDay, addDays,
  formatTime, formatDateHuman,
} from '../time.js'

// Cron бьёт раз в пять минут, поэтому в час ритуала целимся окном такой же ширины:
// точную минуту тик легко проскочит.
export const WINDOW_MIN = 5

export const DEFAULT_REVIEW_TIME = '23:30'
export const DEFAULT_WEEKLY_TIME = '21:00'

export const FLAG_PROTECTED_EVENING = 'protected_evening'
export const FLAG_PROTECTED_SINCE = 'protected_evening_since'
export const FLAG_STREAK_DATE = 'streak_date'

export const STAT_STREAK_CURRENT = 'streak_current'
export const STAT_STREAK_BEST = 'streak_best'
export const STAT_HANDOFFS = 'handoffs'
export const STAT_WALKS = 'walks'

// Свадебные дела и дела с жёстким днём переезжают только на завтра:
// у них нет запаса, чтобы ждать выходных.
export const URGENT_TAG = 'wedding'

// Куда падают несрочные хвосты: суббота, с часу дня и дальше по часу.
const WEEKEND_START_HOUR = 13
const WEEKEND_STEP_HOUR = 1
const WEEKEND_LAST_HOUR = 21

// Дела без срока переезжают на полдень — с этого часа у пары начинается день.
const DAY_START_HOUR = 12

// Вечер считается защищённым с 18:00 и до конца суток.
export const EVENING_FROM_HOUR = 18

const ICON = { danya: '🐊', zhenya: '🐈‍⬛', both: '👫' }
const WEEKDAY_NOM = ['воскресенье', 'понедельник', 'вторник', 'среда',
  'четверг', 'пятница', 'суббота']
const WEEKDAY_ACC = ['воскресенье', 'понедельник', 'вторник', 'среду',
  'четверг', 'пятницу', 'субботу']
const WEEKDAY_PREP = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду',
  'в четверг', 'в пятницу', 'в субботу']
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']

const DEALS = ['дело', 'дела', 'дел']

function chatDefaults(env) {
  return {
    tz: env.DEFAULT_TZ ?? 'Europe/Moscow',
    digestTime: env.DEFAULT_DIGEST_TIME ?? '10:00',
    remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN ?? 30) || 30,
  }
}

const chatOf = (env, chatId) => db.getChat(env.DB, chatId, chatDefaults(env))

const icon = (who) => ICON[who] ?? ''

// Границы местных суток, в которых находится nowIso.
function dayBounds(nowIso, tz) {
  const from = startOfLocalDay(nowIso, tz)
  return { from, to: addDays(from, 1) }
}

// '23:30' → 1410. Мусор на входе превращаем в null, чтобы ритуал просто не сработал.
function minutesOfTime(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

// Попали ли в окно ритуала: от назначенной минуты и WINDOW_MIN вперёд.
function inWindow(nowIso, tz, time) {
  const target = minutesOfTime(time)
  if (target == null) return false
  const { hour, minute } = localParts(nowIso, tz)
  const now = hour * 60 + minute
  return now >= target && now <= target + WINDOW_MIN
}

const isDone = (t) => t.status === 'done'
const isOpen = (t) => t.status !== 'done'
const byTime = (a, b) => String(a.due_at ?? '').localeCompare(String(b.due_at ?? ''))

function line(task, tz) {
  const time = task.due_at ? `${formatTime(task.due_at, tz)} ` : '· '
  return `${time}${esc(task.title)} ${icon(task.assignee)}`.trim()
}

// ───────────────────────── 1. Полночная планёрка ─────────────────────────────

const REVIEW_SYSTEM = `Ты пишешь одну строку итога дня для пары, которая ведёт общий список дел.
Правила: только одна строка, до 160 символов, по-русски, спокойно и по факту.
Опирайся на цифры и названия из сводки, ничего не выдумывай.
Запрещено: похвала, восклицания, эмодзи, обращения, советы, слова «молодец», «отлично», «супер».
Запрещено противопоставлять одно другому через отрицание — пиши простыми утверждениями.
Не начинай со слов «Итог» или «Сегодня».`

// Заготовки на случай, когда нейросеть недоступна. Выбираем по числу закрытых дел,
// без случайностей: одна и та же картина дня даёт одну и ту же строку.
const FALLBACKS = [
  'День прошёл мимо списка. Дела остались там же, где стояли.',
  'Закрыта часть списка. Остальное переезжает — с этим можно жить.',
  'Список ушёл больше чем наполовину. Хвосты видно, они короткие.',
  'Всё, что стояло на сегодня, закрыто. Список пуст.',
]

function fallbackSummary(done, total) {
  if (!done) return FALLBACKS[0]
  if (done >= total) return FALLBACKS[3]
  return done * 2 >= total ? FALLBACKS[2] : FALLBACKS[1]
}

function aiText(raw) {
  if (!raw) return null
  const text = typeof raw === 'string' ? raw : raw.response ?? ''
  const first = String(text).split('\n').map((s) => s.trim()).filter(Boolean)[0]
  if (!first) return null
  const clean = first.replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 200)
  return clean.length >= 10 ? clean : null
}

// Одна живая строка от нейросети. Не получилось — молча берём заготовку.
async function summaryLine(env, { done, left, overdue, tz, nowIso }) {
  const total = done.length + left.length + overdue.length
  const fallback = fallbackSummary(done.length, total)
  if (env.AI_ENABLED !== 'true' || !env.AI) return fallback

  const names = (list) => (list.length
    ? list.slice(0, 5).map((t) => t.title).join('; ')
    : '—')
  const p = localParts(nowIso, tz)
  const user = [
    `Дата: ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}.`,
    `Закрыто ${done.length} из ${total}: ${names(done)}`,
    `Осталось открытым: ${names(left)}`,
    `Просрочено: ${names(overdue)}`,
  ].join('\n')

  try {
    const out = await env.AI.run(env.AI_MODEL, {
      messages: [
        { role: 'system', content: REVIEW_SYSTEM },
        { role: 'user', content: user },
      ],
      max_tokens: 120,
      temperature: 0.4,
    })
    return aiText(out) ?? fallback
  } catch {
    return fallback
  }
}

export function spreadKeyboard() {
  return { inline_keyboard: [[{ text: '🧹 Раскидать хвосты', callback_data: 'rt:spread' }]] }
}

// Разбор прошедшего дня. null означает «день был пустой» — тогда бот молчит,
// потому что сообщение «сегодня ничего не было» перед сном никому не нужно.
export async function dayReview(env, chatId, nowIso) {
  const chat = await chatOf(env, chatId)
  const tz = chat.tz
  const { from, to } = dayBounds(nowIso, tz)

  const tasks = await db.tasksOfDay(env.DB, chatId, from, to)
  if (!tasks.length) return null

  const done = tasks.filter(isDone).sort(byTime)
  const open = tasks.filter(isOpen)
  const overdue = open.filter((t) => t.due_at && t.due_at < nowIso).sort(byTime)
  const left = open.filter((t) => !t.due_at || t.due_at >= nowIso).sort(byTime)

  const out = ['🌙 <b>Разбор дня</b>', '']
  out.push(`Закрыто ${done.length} из ${tasks.length}.`)

  if (done.length) {
    out.push('')
    out.push('<b>Сделано</b>')
    out.push(...done.map((t) => `  ✅ ${line(t, tz)}`))
  }
  if (left.length) {
    out.push('')
    out.push(`<b>Ещё открыто</b> — ${plural(left.length, ...DEALS)}`)
    out.push(...left.map((t) => `  ▫️ ${line(t, tz)}`))
  }
  if (overdue.length) {
    out.push('')
    out.push(`<b>Просрочено</b> — ${plural(overdue.length, ...DEALS)}`)
    out.push(...overdue.map((t) => `  ❗️ ${line(t, tz)}`))
  }

  const summary = await summaryLine(env, { done, left, overdue, tz, nowIso })
  out.push('')
  out.push(`<i>${esc(summary)}</i>`)

  const leftovers = open.length
  return {
    text: out.join('\n'),
    reply_markup: leftovers ? spreadKeyboard() : null,
  }
}

// Разбор шлём только в своё окно и только раз за сутки.
export function shouldRunReview(chat, nowIso) {
  if (!chat?.tz) return false
  if (chat.last_review_date === localDateKey(nowIso, chat.tz)) return false
  return inWindow(nowIso, chat.tz, chat.review_time ?? DEFAULT_REVIEW_TIME)
}

const isUrgent = (t) => t.tag === URGENT_TAG || Number(t.hard_day ?? 0) === 1

// Ближайшая суббота строго после текущих местных суток.
function nextSaturdayParts(nowIso, tz) {
  const { weekday } = localParts(nowIso, tz)
  const ahead = ((6 - weekday + 7) % 7) || 7
  const target = addDays(startOfLocalDay(nowIso, tz), ahead)
  const { year, month, day } = localParts(target, tz)
  return { year, month, day }
}

// Переносим срок, сохраняя зазор до напоминания: если бот напоминал за полчаса,
// он и на новом месте напомнит за полчаса.
function movedFields(task, dueAt) {
  const patch = { due_at: dueAt, notified_pre: 0, notified_due: 0 }
  if (task.due_at && task.remind_at) {
    const gap = new Date(task.due_at).getTime() - new Date(task.remind_at).getTime()
    patch.remind_at = new Date(new Date(dueAt).getTime() - gap).toISOString()
  }
  return patch
}

// Все незакрытые дела дня: срочные — на завтра на то же время,
// остальные — на ближайшую субботу с часу дня, по одному в час.
export async function spreadLeftovers(env, chatId, nowIso, tz) {
  const { from, to } = dayBounds(nowIso, tz)
  const tasks = (await db.tasksOfDay(env.DB, chatId, from, to)).filter(isOpen).sort(byTime)
  if (!tasks.length) return { moved: 0, tomorrow: [], weekend: [] }

  const tomorrowDay = localParts(addDays(from, 1), tz)
  const saturday = nextSaturdayParts(nowIso, tz)

  const tomorrow = []
  const weekend = []
  let slot = 0

  for (const task of tasks) {
    let dueAt
    if (isUrgent(task)) {
      const at = task.due_at ? localParts(task.due_at, tz) : { hour: DAY_START_HOUR, minute: 0 }
      dueAt = localToUtcIso({
        year: tomorrowDay.year, month: tomorrowDay.month, day: tomorrowDay.day,
        hour: at.hour, minute: at.minute,
      }, tz)
    } else {
      // Больше девяти дел на субботу не ставим: дальше идут те же 21:00,
      // иначе хвост уползает в ночь.
      const hour = Math.min(WEEKEND_START_HOUR + slot * WEEKEND_STEP_HOUR, WEEKEND_LAST_HOUR)
      dueAt = localToUtcIso({ ...saturday, hour, minute: 0 }, tz)
      slot++
    }

    await db.updateTask(env.DB, task.id, movedFields(task, dueAt))
    const entry = { id: task.id, title: task.title, due_at: dueAt }
    if (isUrgent(task)) tomorrow.push(entry)
    else weekend.push(entry)
  }

  return { moved: tomorrow.length + weekend.length, tomorrow, weekend }
}

// Текст-подтверждение после раскидывания. Вызывающий код шлёт его сам.
export function spreadSummaryText(result, { tz, nowIso }) {
  if (!result.moved) return 'Хвостов не осталось — раскидывать нечего.'
  const out = [`🧹 Переехало ${plural(result.moved, ...DEALS)}.`]
  if (result.tomorrow.length) {
    out.push('')
    out.push('<b>Завтра</b>')
    out.push(...result.tomorrow.map((t) => `  ${formatTime(t.due_at, tz)} ${esc(t.title)}`))
  }
  if (result.weekend.length) {
    const when = formatDateHuman(result.weekend[0].due_at, tz, nowIso)
    out.push('')
    out.push(`<b>Выходные</b> — ${esc(when)}`)
    out.push(...result.weekend.map((t) => `  ${formatTime(t.due_at, tz)} ${esc(t.title)}`))
  }
  return out.join('\n')
}

// ───────────────────────── 2. Воскресная сборка ──────────────────────────────

// День недели считается перегруженным с этого числа дел.
const OVERLOAD_FROM = 4

// Дело с дедлайном дальше этого горизонта успевает обрасти подготовкой.
const PREP_MIN_DAYS = 2

export const DATE_NIGHT_QUESTION = 'Какой вечер бронируем под свидание?'

// Порядок как в календаре — с понедельника. Индекс варианта опроса → номер дня недели.
export const DATE_NIGHT_DAYS = [
  { label: 'Понедельник', weekday: 1 },
  { label: 'Вторник', weekday: 2 },
  { label: 'Среда', weekday: 3 },
  { label: 'Четверг', weekday: 4 },
  { label: 'Пятница', weekday: 5 },
  { label: 'Суббота', weekday: 6 },
  { label: 'Воскресенье', weekday: 0 },
]

export function dateNightWeekday(optionIndex) {
  return DATE_NIGHT_DAYS[optionIndex]?.weekday ?? null
}

// Дни недели ближайших семи суток с числом дел на каждый.
function weekDays(tasks, nowIso, tz) {
  const start = startOfLocalDay(nowIso, tz)
  const days = []
  for (let i = 0; i < 7; i++) {
    const dayIso = addDays(start, i)
    const key = localDateKey(dayIso, tz)
    const { weekday } = localParts(dayIso, tz)
    days.push({
      key,
      weekday,
      items: tasks.filter((t) => t.due_at && localDateKey(t.due_at, tz) === key),
    })
  }
  return days
}

// Дело с дедлайном, к которому не заведено ни одной подготовки.
// Смотрим только вперёд: то, что через день, готовить уже поздно.
function taskWithoutPrep(tasks, nowIso, tz) {
  const withChildren = new Set(tasks.map((t) => t.parent_id).filter(Boolean).map(Number))
  const horizon = addDays(startOfLocalDay(nowIso, tz), PREP_MIN_DAYS)
  return tasks
    .filter((t) => t.due_at && t.due_at >= horizon && !t.parent_id && !withChildren.has(Number(t.id)))
    .sort(byTime)[0] ?? null
}

// Карта недели плюс до трёх вопросов подряд. Ответы прилетают кнопками.
export async function weeklyAssembly(env, chatId, nowIso) {
  const chat = await chatOf(env, chatId)
  const tz = chat.tz
  const from = startOfLocalDay(nowIso, tz)
  const to = addDays(from, 7)
  const tasks = await db.tasksBetween(env.DB, chatId, from, to)

  const out = [weekMap(tasks, { tz, nowIso }), '']
  const rows = []
  const questions = []

  const days = weekDays(tasks, nowIso, tz)
  const busiest = [...days].sort((a, b) => b.items.length - a.items.length)[0]
  if (busiest && busiest.items.length >= OVERLOAD_FROM) {
    const name = WEEKDAY_NOM[busiest.weekday]
    questions.push(`Плотнее всего ${WEEKDAY_PREP[busiest.weekday]} — ${plural(busiest.items.length, ...DEALS)}. Что подвинуть?`)
    rows.push([{ text: `📦 Разгрузить ${WEEKDAY_ACC[busiest.weekday]}`, callback_data: `rt:unload:${busiest.key}` }])
  }

  const bare = taskWithoutPrep(tasks, nowIso, tz)
  if (bare) {
    const when = formatDateHuman(bare.due_at, tz, nowIso)
    questions.push(`У дела «${esc(bare.title)}» (${esc(when)}) нет ни одного подготовительного шага. Завести?`)
    rows.push([{ text: '🧩 Разбить на шаги', callback_data: `rt:prep:${bare.id}` }])
  }

  const protectedDay = await db.getFlag(env.DB, chatId, FLAG_PROTECTED_EVENING)
  const current = protectedDay == null ? null : Number(protectedDay)
  questions.push(current == null || Number.isNaN(current)
    ? 'Какой вечер на этой неделе бронируем под свидание?'
    : `Свидание пока стоит ${WEEKDAY_PREP[current]}. Оставляем или меняем?`)
  rows.push([{ text: '💛 Выбрать вечер', callback_data: 'rt:date' }])

  out.push('<b>Три вопроса на воскресенье</b>')
  out.push(...questions.map((q, i) => `${i + 1}. ${q}`))

  return { text: out.join('\n'), reply_markup: { inline_keyboard: rows } }
}

export function dateNightPoll(env, chatId) {
  return tg.sendPoll(env, chatId, DATE_NIGHT_QUESTION, DATE_NIGHT_DAYS.map((d) => d.label), {
    is_anonymous: false,
    allows_multiple_answers: false,
  })
}

// Защищённый вечер — единственное «дело», которое бот охраняет сам.
export async function protectEvening(env, chatId, weekday, nowIso) {
  const day = Number(weekday)
  if (!Number.isInteger(day) || day < 0 || day > 6) return null
  await db.setFlag(env.DB, chatId, FLAG_PROTECTED_EVENING, day)
  await db.setFlag(env.DB, chatId, FLAG_PROTECTED_SINCE, nowIso)
  return { weekday: day, label: WEEKDAY_NOM[day] }
}

export async function protectedEvening(env, chatId) {
  const raw = await db.getFlag(env.DB, chatId, FLAG_PROTECTED_EVENING)
  if (raw == null || raw === '') return null
  const day = Number(raw)
  return Number.isInteger(day) && day >= 0 && day <= 6 ? day : null
}

// Правда ли, что дело лезет в защищённый вечер. Проверяется при создании дела.
export async function isProtectedSlot(env, chatId, dueAtIso, tz) {
  if (!dueAtIso) return false
  const day = await protectedEvening(env, chatId)
  if (day == null) return false
  const { weekday, hour } = localParts(dueAtIso, tz)
  return weekday === day && hour >= EVENING_FROM_HOUR
}

// Предупреждение при попытке занять защищённый вечер. Запрета нет, только вопрос.
export function protectedSlotWarning(dueAtIso, tz) {
  const { weekday } = localParts(dueAtIso, tz)
  return `💛 ${WEEKDAY_NOM[weekday][0].toUpperCase()}${WEEKDAY_NOM[weekday].slice(1)} с ${EVENING_FROM_HOUR}:00 занята — `
    + `это ваш вечер вдвоём. Дело сюда всё равно поставить?`
}

// Понедельник текущей местной недели: '2026-08-03'.
function weekStartKey(nowIso, tz) {
  const { weekday } = localParts(nowIso, tz)
  const back = weekday === 0 ? 6 : weekday - 1
  return localDateKey(addDays(startOfLocalDay(nowIso, tz), -back), tz)
}

// Сборка идёт воскресным вечером и один раз за неделю.
export function shouldRunWeekly(chat, nowIso) {
  if (!chat?.tz) return false
  const { weekday } = localParts(nowIso, chat.tz)
  if (weekday !== 0) return false
  if (chat.last_weekly_date && chat.last_weekly_date >= weekStartKey(nowIso, chat.tz)) return false
  return inWindow(nowIso, chat.tz, chat.weekly_time ?? DEFAULT_WEEKLY_TIME)
}

// ───────────────────────── 3. Чистая полоса ──────────────────────────────────

// Раз в сутки: день без просрочек удлиняет полосу, просрочка обнуляет.
// Флаг с датой не даёт посчитать один и тот же день дважды.
export async function updateStreak(env, chatId, nowIso, tz) {
  const today = localDateKey(nowIso, tz)
  const current = Number(await db.getStat(env.DB, chatId, STAT_STREAK_CURRENT)) || 0
  const best = Number(await db.getStat(env.DB, chatId, STAT_STREAK_BEST)) || 0

  if (await db.getFlag(env.DB, chatId, FLAG_STREAK_DATE) === today) {
    return { current, best, broken: false, skipped: true }
  }

  const { from, to } = dayBounds(nowIso, tz)
  const tasks = await db.tasksOfDay(env.DB, chatId, from, to)
  const missed = tasks.some((t) => isOpen(t) && t.due_at && t.due_at < nowIso)

  if (missed) {
    await db.setStat(env.DB, chatId, STAT_STREAK_CURRENT, 0, nowIso)
    await db.setFlag(env.DB, chatId, FLAG_STREAK_DATE, today)
    return { current: 0, best, broken: true, skipped: false }
  }

  await db.bumpStat(env.DB, chatId, STAT_STREAK_CURRENT, 1, nowIso)
  const next = current + 1
  if (next > best) await db.setStat(env.DB, chatId, STAT_STREAK_BEST, next, nowIso)
  await db.setFlag(env.DB, chatId, FLAG_STREAK_DATE, today)

  return { current: next, best: Math.max(best, next), broken: false, skipped: false }
}

// Строка для утреннего дайджеста либо null, если полоса пустая.
export async function streakForDigest(env, chatId) {
  const current = Number(await db.getStat(env.DB, chatId, STAT_STREAK_CURRENT)) || 0
  const best = Number(await db.getStat(env.DB, chatId, STAT_STREAK_BEST)) || 0
  return streakLine(current, best)
}

// Последний день месяца по местному календарю.
function isLastDayOfMonth(nowIso, tz) {
  const { month } = localParts(nowIso, tz)
  const tomorrow = localParts(addDays(startOfLocalDay(nowIso, tz), 1), tz)
  return tomorrow.month !== month
}

function monthBounds(nowIso, tz) {
  const { year, month } = localParts(nowIso, tz)
  const from = localToUtcIso({ year, month, day: 1, hour: 0, minute: 0 }, tz)
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  const to = localToUtcIso({ year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0 }, tz)
  return { from, to, year, month }
}

// Карточка-открытка последним днём месяца. Не последний день — null.
// Файл уходит через tg.sendDocument, здесь только содержимое.
export async function monthlyCard(env, chatId, nowIso, tz) {
  if (!isLastDayOfMonth(nowIso, tz)) return null

  const { from, to, year, month } = monthBounds(nowIso, tz)
  const tasks = await db.tasksOfDay(env.DB, chatId, from, to)
  const stats = await db.allStats(env.DB, chatId)

  const doneTasks = tasks.filter(isDone)
  const forWho = (who) => doneTasks.filter((t) => t.assignee === who || t.assignee === 'both').length
  const byWho = { danya: forWho('danya'), zhenya: forWho('zhenya') }

  const streakBest = Number(stats[STAT_STREAK_BEST] ?? 0) || 0
  const handoffs = Number(stats[STAT_HANDOFFS] ?? 0) || 0
  const walks = Number(stats[STAT_WALKS] ?? 0) || 0
  const monthName = `${MONTHS_NOM[month - 1]} ${year}`

  const html = monthCardHtml({
    month: monthName,
    done: doneTasks.length,
    total: tasks.length,
    streakBest,
    byWho,
    handoffs,
    walks,
  })

  const caption = [
    `📇 <b>${esc(monthName)}</b> — итоги месяца.`,
    `Закрыто ${plural(doneTasks.length, ...DEALS)} из ${tasks.length},`
    + ` лучшая полоса — ${plural(streakBest, 'день', 'дня', 'дней')}.`,
    handoffs ? `Друг за друга подхватили ${plural(handoffs, ...DEALS)}.` : null,
    'Файл открывается в браузере, его удобно переслать.',
  ].filter(Boolean).join('\n')

  return {
    filename: `itogi-${year}-${String(month).padStart(2, '0')}.html`,
    html,
    caption,
  }
}
