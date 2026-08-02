// Хвостатые: вахта по Раде (кто сегодня идёт) и ветеринарный горизонт
// (обработки, прививки, груминг, осмотр).
// Всё живёт на существующих таблицах: tasks с тегом 'pets', stats для счётчиков
// дежурств, task_notes для истории по каждому делу.
import * as db from '../db.js'
import * as tg from '../telegram.js'
import { esc, plural } from '../format.js'
import { nextOccurrence } from '../repeat.js'
import {
  localParts, localToUtcIso, addDays, addMinutes, formatTime, formatDateHuman,
} from '../time.js'

export const PETS_TAG = 'pets'
export const PET_NAMES = ['Рада', 'Люся', 'Мася']
export const DUTY_PEOPLE = ['danya', 'zhenya']

const ICON = { danya: '🐊', zhenya: '🐈‍⬛', both: '👫' }
const OTHER_GROUP = 'Общее'

// Сколько дел показываем по каждому питомцу в сводке /pets.
const MAX_PER_PET = 5

// Время суток для ветеринарных дел: полдень по местному, пара живёт с 12:00.
export const VET_HOUR = 12

// ─────────────────────────── Общая мелочь ───────────────────────────

function chatDefaults(env) {
  return {
    tz: env.DEFAULT_TZ ?? 'Europe/Moscow',
    digestTime: env.DEFAULT_DIGEST_TIME ?? '10:00',
    remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN ?? 30) || 30,
  }
}

const chatOf = (env, chatId) => db.getChat(env.DB, chatId, chatDefaults(env))

const remindOffset = (chat) => Number(chat?.remind_before_min ?? 30) || 30

const icon = (who) => ICON[who] ?? ''

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()

// Сдвиг на N месяцев по местному календарю с посадкой на нужный час.
// 31 января + 1 месяц = 28 февраля: день подрезаем, иначе Date.UTC перекинет на март.
function addMonthsLocal(iso, months, tz, hour = VET_HOUR, minute = 0) {
  const p = localParts(iso, tz)
  const total = p.month - 1 + Number(months || 0)
  const year = p.year + Math.floor(total / 12)
  const month = ((total % 12) + 12) % 12 + 1
  const day = Math.min(p.day, daysInMonth(year, month))
  return localToUtcIso({ year, month, day, hour, minute }, tz)
}

// В JavaScript `\b` работает только с латиницей: в «Прогулка» граница найдётся
// после «П», и половина слов начнёт совпадать невпопад. Поэтому границы слова
// собираем вручную через юникодные классы.
const EDGE = '[\\p{L}\\p{N}]'
const bounded = (body) => new RegExp(`(?<!${EDGE})(?:${body})(?!${EDGE})`, 'iu')

// Основы дежурных дел + до трёх букв окончания: «прогулку», «покормить», «лотка».
// Основа «прогулк» намеренно не ловит «прогулочную коляску» — там «прогулоч».
const DUTY_RE = bounded('(?:прогулк|выгул|покорм|корм|лоток|лотк)\\p{L}{0,3}')

// Имена во всех падежах: Раде, Раду, Радой… Лишнее вроде «радости» и «радуги»
// отсекается перебором конкретных окончаний плюс границей справа.
const PET_RE = {
  'Рада': bounded('рад(?:а|ы|е|у|ой|ою)'),
  'Люся': bounded('люс(?:я|и|е|ю|ей|ею)'),
  'Мася': bounded('мас(?:я|и|е|ю|ей|ею)'),
}

// Кому адресовано дело: «Рада» → «Раде».
const dative = (name) => String(name ?? '').replace(/[ая]$/iu, 'е')

// Питомец по названию дела. Ничего не нашли — null.
export function petOf(title) {
  const s = String(title ?? '')
  for (const name of PET_NAMES) if (PET_RE[name].test(s)) return name
  return null
}

// ─────────────────────── 1. Вахта: кто идёт ───────────────────────

export function isPetDuty(task) {
  if (!task) return false
  if (task.tag === PETS_TAG) return true
  return DUTY_RE.test(String(task.title ?? ''))
}

export function dutyKeyboard(taskId) {
  return {
    inline_keyboard: [[
      { text: 'Я 🐊', callback_data: `pt:take:${taskId}:danya` },
      { text: 'Я 🐈‍⬛', callback_data: `pt:take:${taskId}:zhenya` },
    ]],
  }
}

// 'pt:take:12:danya' → { taskId: 12, who: 'danya' }. Чужое и кривое даёт null.
export function parseDutyCallback(data) {
  const parts = String(data ?? '').split(':')
  if (parts[0] !== 'pt' || parts[1] !== 'take') return null
  const taskId = Number(parts[2])
  const who = parts[3]
  if (!Number.isFinite(taskId) || !DUTY_PEOPLE.includes(who)) return null
  return { taskId, who }
}

export function dutyMessage(task, { tz, nowIso }) {
  const when = task.due_at
    ? `${formatDateHuman(task.due_at, tz, nowIso)}, ${formatTime(task.due_at, tz)}`
    : 'прямо сейчас'
  const pet = petOf(task.title)
  const tail = pet === 'Рада'
    ? ' Рада уже поглядывает в сторону двери.'
    : (pet ? ` ${pet} ждёт.` : '')

  const text = [
    `🐾 <b>${esc(task.title)}</b>`,
    `🗓 ${when}`,
    '',
    `Кто идёт?${tail}`,
    'Один тап — и у второго дело пропадает.',
  ].join('\n')

  return { text, reply_markup: dutyKeyboard(task.id) }
}

export async function sendDutyQuestion(env, chatId, task, { tz, nowIso }) {
  const card = dutyMessage(task, { tz, nowIso })
  await tg.sendMessage(env, chatId, card.text, { reply_markup: card.reply_markup })
  return card
}

// Дежурство забрал конкретный человек: дело закрывается на него, счётчик растёт,
// а у повторяющегося сразу заводится следующий раз — иначе вахта оборвётся.
export async function claimDuty(env, task, who, nowIso) {
  const chat = await chatOf(env, task.chat_id)

  await db.updateTask(env.DB, task.id, { assignee: who })
  await db.markDone(env.DB, task.id)
  await db.bumpStat(env.DB, task.chat_id, `duty:${who}`, 1, nowIso)

  if (!task.repeat_rule) return { next: null }

  const next = nextOccurrence(task.due_at, task.repeat_rule, chat.tz)
  if (!next) return { next: null }

  await db.createTask(env.DB, {
    chat_id: task.chat_id,
    title: task.title,
    due_at: next,
    remind_at: addMinutes(next, -remindOffset(chat)),
    // Следующий раз снова достаётся тому, кто был владельцем до перехвата:
    // общее дело остаётся общим и снова уходит с кнопками обоим.
    assignee: task.assignee ?? 'both',
    created_by: task.created_by ?? 0,
    repeat_rule: task.repeat_rule,
    parent_id: task.parent_id ?? task.id,
    created_at: nowIso,
    tag: task.tag ?? PETS_TAG,
  })

  return { next }
}

export function dutyClaimedText(task, who, next, { tz, nowIso }) {
  const lines = [`✅ ${icon(who)} берёт на себя: <b>${esc(task.title)}</b>`]
  if (next) {
    lines.push(`Следующий раз — ${formatDateHuman(next, tz, nowIso)}, ${formatTime(next, tz)}.`)
  }
  return lines.join('\n')
}

// stats — объект из db.allStats: { 'duty:danya': 9, 'duty:zhenya': 5 }.
export function dutyBalance(stats) {
  const d = Number(stats?.['duty:danya'] ?? 0) || 0
  const z = Number(stats?.['duty:zhenya'] ?? 0) || 0
  if (d === 0 && z === 0) return null

  const total = d + z
  const walks = plural(total, 'прогулка', 'прогулки', 'прогулок')
  const head = `🐾 Прогулки: 🐊 ${d}, 🐈‍⬛ ${z}.`

  if (d === z) return `${head} Ровно пополам, ${walks} на двоих — Рада считает, что ей повезло с обоими.`
  return `${head} Всего ${walks}. Рада не в претензии, но заметила.`
}

// ─────────────────────── Сводка /pets ───────────────────────

function petLine(task, tz, nowIso) {
  const when = task.due_at
    ? `${formatDateHuman(task.due_at, tz, nowIso)}, ${formatTime(task.due_at, tz)}`
    : 'без срока'
  return `· ${esc(task.title)} — ${when} ${icon(task.assignee)}`.trimEnd()
}

export async function petsOverview(env, chatId, nowIso, tz) {
  const zone = tz ?? (await chatOf(env, chatId)).tz
  const tasks = await db.tasksByTag(env.DB, chatId, PETS_TAG)
  const open = tasks.filter((t) => t.status === 'open')

  const out = ['🐾 <b>Питомцы</b>']

  if (!open.length) {
    out.push('', 'Открытых дел нет: все накормлены, выгуляны и, судя по тишине, спят.')
  } else {
    const groups = new Map(PET_NAMES.map((n) => [n, []]))
    groups.set(OTHER_GROUP, [])
    for (const t of open) (groups.get(petOf(t.title) ?? OTHER_GROUP)).push(t)

    for (const [name, items] of groups) {
      if (!items.length) continue
      out.push('', `<b>${name}</b> — ${plural(items.length, 'дело', 'дела', 'дел')}`)
      for (const t of items.slice(0, MAX_PER_PET)) out.push(`  ${petLine(t, zone, nowIso)}`)
      const rest = items.length - MAX_PER_PET
      if (rest > 0) out.push(`  и ещё ${plural(rest, 'дело', 'дела', 'дел')} следом`)
    }
  }

  const balance = dutyBalance(await db.allStats(env.DB, chatId))
  if (balance) out.push('', balance)

  return out.join('\n')
}

// ─────────────────────── 2. Ветеринарный горизонт ───────────────────────

// repeat_rule хранится в формате проекта: 'monthly:D', где D подставляется днём
// месяца от даты старта. Длинный интервал (квартал, год) живёт в everyMonths —
// его отрабатывает nextVetDue, набирая нужное число месячных шагов.
export const VET_TEMPLATES = [
  {
    key: 'ticks',
    title: 'обработка от клещей и блох',
    repeat_rule: 'monthly:D',
    everyMonths: 1,
    daysBefore: 7,
    seasonMonths: [4, 10],
    hint: 'С апреля по октябрь это главное дело месяца.',
  },
  {
    key: 'vaccine',
    title: 'прививка',
    repeat_rule: 'monthly:D',
    everyMonths: 12,
    daysBefore: 14,
    hint: 'Возьмите паспорт питомца, туда клеят наклейку от вакцины.',
  },
  {
    key: 'worms',
    title: 'глистогонное',
    repeat_rule: 'monthly:D',
    everyMonths: 3,
    daysBefore: 5,
    hint: 'Перед прививкой дают за десять дней, так что смотрите на обе даты.',
  },
  {
    key: 'grooming',
    title: 'груминг',
    repeat_rule: 'monthly:D',
    everyMonths: 2,
    daysBefore: 3,
    hint: 'Запись занимают за пару недель, лучше звонить сразу.',
  },
  {
    key: 'checkup',
    title: 'осмотр у ветеринара',
    repeat_rule: 'monthly:D',
    everyMonths: 12,
    daysBefore: 14,
    hint: 'Заодно взвесить — вес удобно дописать заметкой.',
  },
]

export const vetTemplate = (key) => VET_TEMPLATES.find((t) => t.key === key) ?? null

// repeat.js умеет только «раз в месяц», поэтому квартал и год набираем шагами.
export function nextVetDue(dueAtIso, everyMonths, repeatRule, tz) {
  const steps = Math.max(1, Number(everyMonths) || 1)
  let iso = dueAtIso
  for (let i = 0; i < steps; i++) {
    const step = nextOccurrence(iso, repeatRule, tz)
    if (!step) return null
    iso = step
  }
  return iso
}

// startIso — точка отсчёта: когда всё это делали в последний раз.
// Первый срок каждого дела = старт плюс его интервал.
export async function setupVetSchedule(env, chatId, petName, startIso, tz) {
  const zone = tz ?? (await chatOf(env, chatId)).tz
  const name = String(petName ?? '').trim() || 'Питомец'
  const startDay = localParts(startIso, zone).day
  const created = []

  for (const tpl of VET_TEMPLATES) {
    const dueAt = addMonthsLocal(startIso, tpl.everyMonths, zone)
    const task = await db.createTask(env.DB, {
      chat_id: chatId,
      title: `${name}: ${tpl.title}`.slice(0, 200),
      due_at: dueAt,
      remind_at: addDays(dueAt, -tpl.daysBefore),
      assignee: 'both',
      created_by: 0,
      repeat_rule: tpl.repeat_rule.replace('D', String(startDay)),
      created_at: startIso,
      tag: PETS_TAG,
    })
    created.push({ ...task, vet: tpl.key, everyMonths: tpl.everyMonths, daysBefore: tpl.daysBefore })
  }

  return created
}

// «Рада: обработка от клещей» → { pet: 'Рада', what: 'обработка от клещей' }
function splitVetTitle(title) {
  const s = String(title ?? '').trim()
  const idx = s.indexOf(':')
  if (idx > 0) {
    const pet = petOf(s.slice(0, idx))
    if (pet) return { pet, what: s.slice(idx + 1).trim() }
  }
  return { pet: null, what: s }
}

// Напоминание за daysBefore дней. Заметки берём либо готовым списком (notes),
// либо из базы, если передали env: подпись «в прошлый раз» экономит звонок в клинику.
export async function vetReminderText(task, daysBefore, { tz, nowIso, env = null, notes = null }) {
  const { pet, what } = splitVetTitle(task.title)
  const days = plural(Math.max(0, Number(daysBefore) || 0), 'день', 'дня', 'дней')

  const lines = [pet
    ? `🩺 ${dative(pet)} через ${days} ${esc(what)}`
    : `🩺 Через ${days}: ${esc(what)}`]

  if (task.due_at) {
    lines.push(`🗓 ${formatDateHuman(task.due_at, tz, nowIso)}, ${formatTime(task.due_at, tz)}`)
  }

  const month = localParts(nowIso, tz).month
  if (/клещ/iu.test(String(task.title ?? '')) && month >= 4 && month <= 10) {
    lines.push('🌿 Сезон клещей идёт, этот раз лучше не сдвигать.')
  }

  let history = notes
  if (!history && env) history = await db.notesFor(env.DB, task.id)
  const last = history?.[0]?.text
  if (last) lines.push(`📝 В прошлый раз: ${esc(last)}`)

  lines.push('Ответьте реплаем на это сообщение — допишу в историю дела.')
  return lines.join('\n')
}

const NOTE_PREFIX = /^\s*(?:\/?note|заметк\p{L}{0,2}|запиши|запомни)\s*[:\-—]?\s+/iu

// Из реплая «вес 24 кг» достаём чистый текст заметки. Пустое даёт null.
export function parseNote(text) {
  if (typeof text !== 'string') return null
  const cleaned = text.replace(NOTE_PREFIX, '').replace(/\s+/gu, ' ').trim()
  if (!cleaned) return null
  return cleaned.slice(0, 200).trim()
}

export async function addTaskNote(env, taskId, text, nowIso) {
  const note = parseNote(text)
  if (!note) return null
  await db.addNote(env.DB, taskId, note, nowIso)
  return `📝 Записал: «${esc(note)}». Покажу, когда дело придёт в следующий раз.`
}
