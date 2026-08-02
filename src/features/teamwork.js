// Вдвоём: передача дела партнёру («Подхватишь?») и выравнивание недели («Весы»).
// Идеи 9 и 10 из docs/ideas.md.
//
// Модули берём пространствами имён: так vi.spyOn в тестах реально перехватывает вызовы.
import * as db from '../db.js'
import * as tg from '../telegram.js'
import * as visual from '../visual.js'
import { plural, esc, ASSIGNEE_LABEL } from '../format.js'
import {
  localParts, localDateKey, localToUtcIso, startOfLocalDay, addDays, addMinutes, formatTime,
  formatDateHuman,
} from '../time.js'

const ICON = visual.ASSIGNEE_ICONS
const OPPOSITE = { danya: 'zhenya', zhenya: 'danya' }
const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

// Пара — совы: день начинается в полдень и кончается к десяти вечера.
const DAY_START = 12 * 60
const DAY_END = 22 * 60
// Считаем, что любое дело съедает час. Точных длительностей в базе нет.
const SLOT_MIN = 60

// Дела, которые физически делает только их владелец: чужой на маникюр не сходит.
const PERSONAL = /(маникюр|бров|ресниц|психолог|стоматолог|лазер|загар|стрижк|ботокс)/iu

const HANDOFF_KEY = (who) => `handoffs:${who}`
const TOOK = { danya: 'забрал', zhenya: 'забрала', both: 'забрали' }

const who = (assignee) => `${ICON[assignee] ?? ''} ${ASSIGNEE_LABEL[assignee] ?? assignee}`.trim()
const hhmm = (mins) => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
const isOpen = (t) => !t.status || t.status === 'open'
const shortTitle = (s, n = 22) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s))

/** Личная процедура, которую не передают партнёру. */
export function isPersonal(title) {
  return PERSONAL.test(String(title ?? ''))
}

function chatDefaults(env) {
  return {
    tz: env.DEFAULT_TZ ?? 'Europe/Moscow',
    digestTime: env.DEFAULT_DIGEST_TIME ?? '10:00',
    remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN ?? 30),
  }
}

// ───────────────────────────── 9. «Подхватишь?» ─────────────────────────────

/**
 * Самое длинное свободное окно дня между 12:00 и 22:00.
 * Чистая функция: ни базы, ни сети.
 * @returns {string|null} «с 15:00 до 18:00» либо null, если целого часа не набралось
 */
export function findFreeWindow(tasks, dayIso, tz) {
  const key = localDateKey(dayIso, tz)
  const busy = []

  for (const t of tasks ?? []) {
    if (!t?.due_at || !isOpen(t)) continue
    if (localDateKey(t.due_at, tz) !== key) continue
    const p = localParts(t.due_at, tz)
    const start = p.hour * 60 + p.minute
    const from = Math.max(DAY_START, start)
    const to = Math.min(DAY_END, start + SLOT_MIN)
    if (to > from) busy.push([from, to])
  }

  busy.sort((a, b) => a[0] - b[0])

  const gaps = []
  let cursor = DAY_START
  for (const [from, to] of busy) {
    if (from > cursor) gaps.push([cursor, from])
    cursor = Math.max(cursor, to)
  }
  if (cursor < DAY_END) gaps.push([cursor, DAY_END])

  let best = null
  for (const g of gaps) {
    if (!best || g[1] - g[0] > best[1] - best[0]) best = g
  }
  if (!best || best[1] - best[0] < SLOT_MIN) return null
  return `с ${hhmm(best[0])} до ${hhmm(best[1])}`
}

/**
 * Просьба подхватить дело: контекст плюс две кнопки.
 * @param {object} task — дело владельца (assignee = кто просит)
 * @param {string|null} freeWindow — результат findFreeWindow
 * @param {{tz: string, nowIso: string, partnerTasks?: number|null}} ctx
 *        partnerTasks — сколько дел у партнёра в этот день (необязательно)
 */
export function handoffRequest(task, freeWindow, { tz, nowIso, partnerTasks = null } = {}) {
  const owner = task.assignee
  const partner = OPPOSITE[owner] ?? 'both'

  const lines = [`${who(owner)} просит подхватить`, '']
  lines.push(`📌 <b>${esc(task.title)}</b>`)
  lines.push(task.due_at
    ? `🗓 ${formatDateHuman(task.due_at, tz, nowIso)}, до ${formatTime(task.due_at, tz)}`
    : '🗓 без срока')

  const load = Number.isFinite(partnerTasks) && partnerTasks !== null
    ? (partnerTasks === 0
      ? 'У тебя в этот день пусто'
      : `У тебя в этот день ${plural(partnerTasks, 'дело', 'дела', 'дел')}`)
    : null
  const window = freeWindow ? `окно ${freeWindow} свободно` : 'свободного часа подряд не видно'

  if (load) {
    lines.push('', `${ICON[partner] ?? ''} ${load}, ${window}.`.trim())
  } else if (freeWindow) {
    lines.push('', `${ICON[partner] ?? ''} Окно ${freeWindow} у тебя свободно.`.trim())
  }
  lines.push('', 'Решай спокойно, отказ тоже ответ.')

  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: `Забираю ${ICON[partner] ?? ''}`.trim(), callback_data: `hf:take:${task.id}` },
        { text: 'Не смогу', callback_data: `hf:pass:${task.id}` },
      ]],
    },
  }
}

/** Партнёр забрал дело: меняем исполнителя, помним прежнего, плюсуем счётчик взаимовыручки. */
export async function acceptHandoff(env, task, newAssignee, nowIso) {
  const previous = task.assignee
  await db.updateTask(env.DB, task.id, { assignee: newAssignee, handoff_from: previous })
  await db.bumpStat(env.DB, task.chat_id, HANDOFF_KEY(newAssignee), 1, nowIso)

  const verb = TOOK[newAssignee] ?? 'забрал'
  return {
    ok: true,
    task: { ...task, assignee: newAssignee, handoff_from: previous },
    text: `🤝 ${who(newAssignee)} ${verb} дело на себя: <b>${esc(task.title)}</b>.\n`
      + `${who(previous)}, с тебя снято.`,
  }
}

/**
 * Партнёр отказался: дело возвращается владельцу. Спокойно, без обид.
 * Отказы намеренно нигде не считаются — счётчик отказов работал бы как упрёк.
 * nowIso принимаем ради единообразия с acceptHandoff.
 */
export async function declineHandoff(env, task, nowIso) {
  void nowIso
  const owner = task.handoff_from ?? task.assignee
  const asked = OPPOSITE[owner] ?? 'both'
  await db.updateTask(env.DB, task.id, { assignee: owner, handoff_from: null })

  return {
    ok: true,
    task: { ...task, assignee: owner, handoff_from: null },
    text: `↩️ <b>${esc(task.title)}</b> остаётся на ${who(owner)}.\n`
      + `У ${who(asked)} день и так занят — обычное дело. Спросить стоило.`,
  }
}

/**
 * Строчка про взаимовыручку для дайджеста.
 * @param {Record<string, number>} stats — как отдаёт db.allStats
 * @returns {string|null} null, если подхватов ещё не было
 */
export function handoffSummary(stats) {
  const d = Number(stats?.[HANDOFF_KEY('danya')] ?? 0)
  const z = Number(stats?.[HANDOFF_KEY('zhenya')] ?? 0)
  const total = d + z
  if (!total) return null

  const head = `🤝 В этом месяце вы подхватили друг за друга ${plural(total, 'дело', 'дела', 'дел')}.`
  if (d && z) return `${head}\n${ICON.danya} ${d} · ${ICON.zhenya} ${z}`
  return head
}

// ───────────────────────────── 10. Весы недели ─────────────────────────────

async function loadChat(env, chatId) {
  return db.getChat(env.DB, chatId, chatDefaults(env))
}

/** Раскладка ближайших семи дней: сколько у кого дел в каждый день. */
function weekDays(tasks, tz, nowIso) {
  const start = startOfLocalDay(nowIso, tz)
  const days = []
  for (let i = 0; i < 7; i++) {
    const iso = addDays(start, i)
    const key = localDateKey(iso, tz)
    const p = localParts(iso, tz)
    const items = (tasks ?? []).filter((t) => t.due_at && isOpen(t) && localDateKey(t.due_at, tz) === key)
    const load = (person) => items.filter((t) => t.assignee === person || t.assignee === 'both').length
    days.push({
      iso, key, label: WEEKDAY_SHORT[p.weekday],
      items, danya: load('danya'), zhenya: load('zhenya'),
    })
  }
  return days
}

/** Картинка-весы на неделю вперёд плюс кнопка «Выровнять». */
export async function weeklyBalance(env, chatId, nowIso) {
  const chat = await loadChat(env, chatId)
  const tz = chat.tz
  const from = startOfLocalDay(nowIso, tz)
  const to = addDays(from, 7)
  const tasks = await db.tasksBetween(env.DB, chatId, from, to)

  return {
    text: visual.balanceMap(tasks, { tz, nowIso }),
    reply_markup: {
      inline_keyboard: [[{ text: '⚖️ Выровнять', callback_data: 'tw:balance' }]],
    },
    tasks,
    tz,
  }
}

/** То же самое, но сразу в чат — для воскресного крона. */
export async function sendWeeklyBalance(env, chatId, nowIso) {
  const board = await weeklyBalance(env, chatId, nowIso)
  await tg.sendMessage(env, chatId, board.text, { reply_markup: board.reply_markup })
  return board
}

const AI_SYSTEM = `Ты помогаешь паре выровнять нагрузку на неделю.
Даня (danya) и Женя (zhenya) ведут общий список дел.
Отвечай ТОЛЬКО JSON-массивом без пояснений и без markdown.
Элемент массива: {"task_id": число, "kind": "assignee"|"day", "to": "danya"|"zhenya"|"YYYY-MM-DD"}
kind "assignee" — дело берёт партнёр. kind "day" — дело переезжает на другой день недели.
Личные процедуры (маникюр, брови, ресницы, психолог, стоматолог, лазер, загар, стрижка, ботокс)
остаются на своём владельце всегда.
Дай 2–3 переброса с самого перегруженного дня. Бери только дела из списка, ничего не выдумывай.`

function extractArray(raw) {
  const text = typeof raw === 'string' ? raw : raw?.response ?? ''
  const match = String(text).match(/\[[\s\S]*\]/)
  if (!match) return null
  try {
    const value = JSON.parse(match[0])
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function aiTaskLines(days, tz) {
  const out = []
  for (const d of days) {
    if (!d.items.length) continue
    out.push(`${d.label} ${d.key} — 🐊 ${d.danya} / 🐈‍⬛ ${d.zhenya}`)
    for (const t of d.items) {
      out.push(`  id=${t.id} [${t.assignee}] ${formatTime(t.due_at, tz)} ${t.title}`)
    }
  }
  return out.join('\n')
}

/** Приводим сырое предложение (своё или от нейросети) к общему виду. */
function normalize(raw, byId, days) {
  const task = byId.get(Number(raw?.task_id ?? raw?.taskId))
  if (!task || isPersonal(task.title)) return null

  if (raw.kind === 'assignee') {
    const to = OPPOSITE[task.assignee]
    if (!to || raw.to !== to) return null
    return { taskId: task.id, title: task.title, from: task.assignee, to, kind: 'assignee' }
  }
  if (raw.kind === 'day') {
    const target = days.find((d) => d.key === raw.to)
    if (!target || !task.due_at) return null
    const current = days.find((d) => d.items.some((t) => t.id === task.id))
    if (!current || current.key === target.key) return null
    return { taskId: task.id, title: task.title, from: current.iso, to: target.iso, kind: 'day' }
  }
  return null
}

/** Свободный день для человека: минимум дел, при равенстве — ближайший. */
function freestDay(days, person, excludeKey, currentLoad) {
  let best = null
  for (const d of days) {
    if (d.key === excludeKey) continue
    if (!best || d[person] < best[person]) best = d
  }
  if (!best || best[person] > currentLoad - 2) return null
  return best
}

function fallbackSuggestions(days, limit) {
  const ranked = [...days].sort((a, b) => Math.abs(b.danya - b.zhenya) - Math.abs(a.danya - a.zhenya))
  const out = []

  for (const day of ranked) {
    if (out.length >= limit) break
    const skew = day.danya - day.zhenya
    if (Math.abs(skew) < 2) continue

    const over = skew > 0 ? 'danya' : 'zhenya'
    const under = OPPOSITE[over]
    let overLoad = day[over]
    let underLoad = day[under]

    const candidates = day.items.filter((t) => t.assignee === over && !isPersonal(t.title))
    for (const t of candidates) {
      if (out.length >= limit) break
      if (overLoad - underLoad >= 2) {
        out.push({ taskId: t.id, title: t.title, from: over, to: under, kind: 'assignee' })
        overLoad -= 1
        underLoad += 1
        continue
      }
      const free = freestDay(days, over, day.key, overLoad)
      if (!free) break
      out.push({ taskId: t.id, title: t.title, from: day.iso, to: free.iso, kind: 'day' })
      overLoad -= 1
    }
  }
  return out
}

/**
 * 2–3 конкретных переброса. Сначала спрашиваем нейросеть, на любой осечке —
 * свой алгоритм: самый перекошенный день, дела, которые может сделать второй.
 * @returns {Promise<Array<{taskId: number, title: string, from: string, to: string, kind: 'assignee'|'day'}>>}
 */
export async function suggestRebalance(env, tasks, { tz, nowIso }, limit = 3) {
  const days = weekDays(tasks, tz, nowIso)
  const byId = new Map((tasks ?? []).map((t) => [t.id, t]))

  if (env?.AI_ENABLED === 'true' && env?.AI) {
    try {
      const out = await env.AI.run(env.AI_MODEL, {
        messages: [
          { role: 'system', content: AI_SYSTEM },
          { role: 'user', content: `Сегодня ${localDateKey(nowIso, tz)}.\n${aiTaskLines(days, tz)}` },
        ],
        max_tokens: 400,
        temperature: 0.2,
      })
      const parsed = extractArray(out)
      if (parsed?.length) {
        const seen = new Set()
        const good = []
        for (const raw of parsed) {
          const s = normalize(raw, byId, days)
          if (!s || seen.has(s.taskId)) continue
          seen.add(s.taskId)
          good.push(s)
          if (good.length >= limit) break
        }
        if (good.length) return good
      }
    } catch {
      // Нейросеть отвалилась или ответила ерундой — считаем сами.
    }
  }

  return fallbackSuggestions(days, limit)
}

function suggestionLine(s, { tz, nowIso }) {
  if (s.kind === 'assignee') {
    return `<b>${esc(s.title)}</b> — с ${who(s.from)} на ${who(s.to)}.`
  }
  return `<b>${esc(s.title)}</b> — переезжает на ${formatDateHuman(s.to, tz, nowIso)}, там свободнее.`
}

function suggestionButton(s, i, tz) {
  const tail = s.kind === 'assignee'
    ? (ICON[s.to] ?? '')
    : WEEKDAY_SHORT[localParts(s.to, tz).weekday]
  return {
    text: `${i + 1} · ${shortTitle(s.title)} → ${tail}`.trim(),
    callback_data: `tw:apply:${s.taskId}:${s.kind}`,
  }
}

/** Черновик выравнивания: по кнопке на предложение плюс «Оставить как есть». */
export function rebalancePreview(suggestions, { tz, nowIso }) {
  const list = suggestions ?? []
  const keep = { text: '👌 Оставить как есть', callback_data: 'tw:keep' }

  if (!list.length) {
    return {
      text: '⚖️ <b>Неделя и так ровная</b>\n\nПерекидывать нечего, обе колонки примерно вровень.',
      reply_markup: { inline_keyboard: [[keep]] },
    }
  }

  const lines = [`⚖️ <b>Как выровнять неделю</b> — ${plural(list.length, 'идея', 'идеи', 'идей')}`, '']
  list.forEach((s, i) => lines.push(`${i + 1}. ${suggestionLine(s, { tz, nowIso })}`))
  lines.push('', 'Жми на то, что подходит. Остальное останется как есть.')

  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [...list.map((s, i) => [suggestionButton(s, i, tz)]), [keep]],
    },
  }
}

/**
 * Применить одно предложение.
 * 'assignee' — дело уходит партнёру. 'day' — дело переезжает на ближайший
 * свободный день с сохранением времени.
 */
export async function applyRebalance(env, task, kind, nowIso) {
  const chat = await loadChat(env, task.chat_id)
  const tz = chat.tz

  if (kind === 'assignee') {
    const to = OPPOSITE[task.assignee]
    if (!to) {
      return { ok: false, task, text: `👫 <b>${esc(task.title)}</b> — общее дело, оно и так на двоих.` }
    }
    await db.updateTask(env.DB, task.id, { assignee: to, handoff_from: task.assignee })
    return {
      ok: true,
      kind,
      task: { ...task, assignee: to, handoff_from: task.assignee },
      text: `⚖️ <b>${esc(task.title)}</b> теперь на ${who(to)}.\n${who(task.assignee)}, минус одно дело.`,
    }
  }

  if (!task.due_at) {
    return { ok: false, task, text: `🗓 У дела <b>${esc(task.title)}</b> нет срока, двигать нечего.` }
  }

  const from = startOfLocalDay(nowIso, tz)
  const tasks = await db.tasksBetween(env.DB, task.chat_id, from, addDays(from, 8))
  const person = task.assignee === 'both' ? 'danya' : task.assignee
  const currentKey = localDateKey(task.due_at, tz)

  const start = startOfLocalDay(nowIso, tz)
  const time = localParts(task.due_at, tz)
  const options = []
  for (let i = 0; i < 8; i++) {
    const dayIso = addDays(start, i)
    const key = localDateKey(dayIso, tz)
    if (key === currentKey) continue
    const d = localParts(dayIso, tz)
    const due = localToUtcIso({
      year: d.year, month: d.month, day: d.day, hour: time.hour, minute: time.minute,
    }, tz)
    if (new Date(due) <= new Date(nowIso)) continue
    const load = (tasks ?? []).filter((t) => t.id !== task.id && t.due_at && isOpen(t)
      && localDateKey(t.due_at, tz) === key
      && (t.assignee === person || t.assignee === 'both')).length
    options.push({ key, due, load })
  }

  options.sort((a, b) => a.load - b.load || a.due.localeCompare(b.due))
  const target = options[0]
  if (!target) {
    return { ok: false, task, text: `🗓 <b>${esc(task.title)}</b> двигать некуда, вся неделя занята.` }
  }

  const patch = { due_at: target.due, notified_pre: 0, notified_due: 0 }
  if (task.remind_at) {
    const lead = Math.round((new Date(task.due_at) - new Date(task.remind_at)) / 60000)
    patch.remind_at = addMinutes(target.due, -lead)
  }
  await db.updateTask(env.DB, task.id, patch)

  return {
    ok: true,
    kind,
    task: { ...task, ...patch },
    text: `📦 <b>${esc(task.title)}</b> переезжает на `
      + `${formatDateHuman(target.due, tz, nowIso)}, ${formatTime(target.due, tz)}.\n`
      + `${who(task.assignee)} — там посвободнее.`,
  }
}
