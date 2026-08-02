// Контент-цех Жени: раскрутка дедлайна интеграции, четыре ленты, свалка → список.
// Идеи 6, 7 и 8 из docs/ideas.md.
import * as db from '../db.js'
import { esc, plural } from '../format.js'
import {
  formatDateHuman, formatTime, localParts, localToUtcIso, startOfLocalDay, addDays,
} from '../time.js'

const ICON = { danya: '🐊', zhenya: '🐈‍⬛', both: '👫' }
const ASSIGNEES = new Set(['danya', 'zhenya', 'both'])
const DAY_MS = 86400000

// ─────────────────────────── общие мелочи ───────────────────────────

// `\b` в JS считает словом только [A-Za-z0-9_], для кириллицы он бесполезен.
// Границы собираем вручную по юникодным классам, флаг `u` обязателен.
const LB = '(?<![\\p{L}\\p{N}])'
const RB = '(?![\\p{L}\\p{N}])'

// Сдвиг на N местных суток с сохранением времени дня: летний переход
// не должен утаскивать «снять» на час раньше.
function shiftLocalDays(iso, days, tz) {
  const { hour, minute } = localParts(iso, tz)
  const d = localParts(addDays(startOfLocalDay(iso, tz), days), tz)
  return localToUtcIso({ year: d.year, month: d.month, day: d.day, hour, minute }, tz)
}

const toIso = (value) => {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function whenLabel(iso, tz, nowIso) {
  if (!iso) return 'без срока'
  return `${formatDateHuman(iso, tz, nowIso)}, ${formatTime(iso, tz)}`
}

// Тот же приём, что в parse/ai.js: модель любит обрамлять JSON болтовнёй и markdown,
// поэтому вырезаем первый объект или массив и пробуем разобрать.
function extractJson(raw) {
  if (!raw) return null
  const text = typeof raw === 'string' ? raw : raw.response ?? ''
  const s = String(text)
  for (const rx of [/\{[\s\S]*\}/, /\[[\s\S]*\]/]) {
    const m = s.match(rx)
    if (!m) continue
    try {
      return JSON.parse(m[0])
    } catch {
      // попробуем следующую форму
    }
  }
  return null
}

function nowLine(nowIso, tz) {
  const p = localParts(nowIso, tz)
  const pad = (n) => String(n).padStart(2, '0')
  return `Сейчас: ${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}, зона ${tz}.`
}

async function askAi(env, system, user, maxTokens) {
  if (env.AI_ENABLED !== 'true' || !env.AI) return null
  try {
    const out = await env.AI.run(env.AI_MODEL, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.1,
    })
    return extractJson(out)
  } catch {
    return null
  }
}

// ─────────────────── черновики: живут во флагах чата ───────────────────

// Ключ считаем из времени создания — тесты остаются предсказуемыми,
// а Math.random и Date.now внутрь чистых функций не заезжают.
export function draftKey(nowIso) {
  const ms = new Date(nowIso).getTime()
  const base = Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
  return base.toString(36)
}

export async function saveDraft(env, chatId, draft, nowIso) {
  const key = draftKey(nowIso)
  await db.setFlag(env.DB, chatId, `draft:${key}`, JSON.stringify({ ...draft, createdAt: nowIso }))
  return key
}

export async function loadDraft(env, chatId, key) {
  const raw = await db.getFlag(env.DB, chatId, `draft:${key}`)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function dropDraft(env, chatId, key) {
  await db.deleteFlag(env.DB, chatId, `draft:${key}`)
}

// Заводит дела из черновика. Тег берём из самого дела: у цепочек и кросспостов
// это 'content', у разобранной свалки тега нет.
export async function applyDraft(env, chatId, items, nowIso, defaultAssignee, createdBy = 0) {
  const created = []
  for (const item of items ?? []) {
    const title = String(item?.title ?? '').trim()
    if (!title) continue
    const assignee = ASSIGNEES.has(item.assignee) ? item.assignee : defaultAssignee
    created.push(await db.createTask(env.DB, {
      chat_id: chatId,
      title: title.slice(0, 200),
      due_at: toIso(item.dueAt),
      remind_at: null,
      assignee,
      created_by: createdBy,
      repeat_rule: null,
      parent_id: item.parentId ?? null,
      created_at: nowIso,
      tag: item.tag ?? null,
    }))
  }
  return created
}

// ═════════════════ 1. Раскрутка дедлайна (идея 6) ═════════════════

const INTEGRATION_WORDS = [
  'интеграци\\p{L}*',
  'реклам\\p{L}*',
  'бренд\\p{L}*',
  'коллаб\\p{L}*',
  'инт\\.',
]
const RE_INTEGRATION = new RegExp(`${LB}(?:${INTEGRATION_WORDS.join('|')})${RB}`, 'iu')

export function looksLikeIntegration(text) {
  if (!text) return false
  return RE_INTEGRATION.test(String(text))
}

// Обратный отсчёт от дедлайна. Зазор перед публикацией держим на согласование:
// съёмка впритык и бренд, который не успел ответить, — самая частая авария.
const CHAIN_STEPS = [
  { label: 'получить бриф и продукт', daysBefore: 9 },
  { label: 'снять', daysBefore: 6 },
  { label: 'смонтировать', daysBefore: 4 },
  { label: 'отправить на согласование', daysBefore: 3 },
  { label: 'опубликовать', daysBefore: 0 },
  { label: 'отчёт бренду', daysBefore: -1 },
]
export const CHAIN_SPAN_DAYS = 9

// nowIso необязателен: без него строим полную девятидневную цепочку.
// С ним — поджимаем шаги пропорционально остатку времени и держим их в будущем.
export function buildIntegrationChain(brand, deadlineIso, tz, nowIso = null) {
  const deadline = new Date(deadlineIso)
  if (Number.isNaN(deadline.getTime())) return []

  const name = String(brand ?? '').trim() || 'Интеграция'
  const dl = deadline.toISOString()
  const leftMs = nowIso ? deadline.getTime() - new Date(nowIso).getTime() : Infinity
  const spanMs = CHAIN_SPAN_DAYS * DAY_MS
  const squeeze = leftMs < spanMs
  const scale = squeeze ? Math.max(0, leftMs) / spanMs : 1

  return CHAIN_STEPS.map(({ label, daysBefore }) => {
    let iso
    if (!squeeze || daysBefore <= 0) {
      iso = shiftLocalDays(dl, -daysBefore, tz)
    } else {
      const ms = deadline.getTime() - daysBefore * scale * DAY_MS
      iso = new Date(Math.round(ms / 60000) * 60000).toISOString()
    }
    if (nowIso && new Date(iso) < new Date(nowIso)) iso = new Date(nowIso).toISOString()
    return { title: `${name}: ${label}`, dueAt: iso, tag: 'content' }
  })
}

const INTEGRATION_SYSTEM = `Ты разбираешь заявку блогера на рекламную интеграцию.
Отвечай ТОЛЬКО одним JSON-объектом, без пояснений и без markdown.
Поля:
  "brand" — название бренда так, как оно написано в тексте, до 40 символов
  "deadline" — дата и время публикации в формате YYYY-MM-DDTHH:MM:SSZ (UTC)
Год бери текущий, если он не назван. Время не названо — ставь 12:00 по местной зоне.
Ничего не выдумывай: бренда или даты в тексте нет — верни null в этом поле.`

export async function parseIntegration(env, text, nowIso, tz) {
  const parsed = await askAi(
    env, INTEGRATION_SYSTEM, `${nowLine(nowIso, tz)}\nЗаявка: ${text}`, 200,
  )
  if (!parsed) return null

  const brand = String(parsed.brand ?? '').trim().slice(0, 40)
  const deadline = toIso(parsed.deadline)
  if (!brand || brand.toLowerCase() === 'null' || !deadline) return null

  return { brand, deadline }
}

const stripBrand = (title, brand) => (
  title.startsWith(`${brand}: `) ? title.slice(brand.length + 2) : title
)

export function chainPreview(brand, steps, { tz, nowIso, key = draftKey(nowIso) }) {
  const name = String(brand ?? '').trim() || 'Интеграция'
  const lines = [
    `🎬 <b>${esc(name)}</b> — раскрутила дедлайн назад`,
    '',
    ...steps.map((s, i) => `${i + 1}. ${esc(stripBrand(s.title, name))} — ${whenLabel(s.dueAt, tz, nowIso)}`),
    '',
    `Заведу ${plural(steps.length, 'дело', 'дела', 'дел')} одной пачкой.`,
  ]
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: `✅ Завести все ${steps.length}`, callback_data: `ct:chain:${key}` },
        { text: 'Отмена', callback_data: `ct:cancel:${key}` },
      ]],
    },
  }
}

// ═════════════════ 2. Четыре ленты (идея 7) ═════════════════

export const PLATFORMS = [
  {
    id: 'tiktok',
    name: 'TikTok',
    emoji: '🎵',
    hint: 'вертикаль 9:16, до 60 секунд, крючок в первые 2 секунды, крупные субтитры',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    emoji: '📸',
    hint: 'рилс 9:16 до 90 секунд, обложка с лицом и одной фразой, хештеги первым комментарием',
  },
  {
    id: 'threads',
    name: 'Threads',
    emoji: '🧵',
    hint: 'текст 3–5 строк от первого лица, один кадр со съёмки, вопрос в конце',
  },
  {
    id: 'pinterest',
    name: 'Pinterest',
    emoji: '📌',
    hint: 'статичная обложка 2:3, заголовок прямо на картинке, описание с ключевыми словами',
  },
]

export function crosspostChain(title, baseIso, tz) {
  const clean = String(title ?? '').trim()
  if (!clean || !toIso(baseIso)) return []
  const base = toIso(baseIso)
  return PLATFORMS.map((p, i) => ({
    title: `${p.name}: ${clean}`.slice(0, 200),
    dueAt: shiftLocalDays(base, i, tz),
    platform: p.id,
    hint: p.hint,
    tag: 'content',
  }))
}

export function crosspostPreview(title, steps, { tz, nowIso, key = draftKey(nowIso) }) {
  const clean = String(title ?? '').trim()
  const byId = new Map(PLATFORMS.map((p) => [p.id, p]))
  const lines = [
    `📡 <b>${esc(clean)}</b> — по четырём лентам`,
    '',
    ...steps.map((s) => {
      const p = byId.get(s.platform)
      const head = `${p?.emoji ?? '•'} <b>${esc(p?.name ?? s.title)}</b> — ${whenLabel(s.dueAt, tz, nowIso)}`
      return s.hint ? `${head}\n   <i>${esc(s.hint)}</i>` : head
    }),
    '',
    `Сдвиг на день друг от друга: ${plural(steps.length, 'дело', 'дела', 'дел')} на неделю.`,
  ]
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Раскидать по всем', callback_data: `ct:cross:${key}` },
        { text: 'Не надо', callback_data: `ct:cancel:${key}` },
      ]],
    },
  }
}

// ═════════════════ 3. Свалка → список (идея 8) ═════════════════

export const DUMP_LIMIT = 15

const DUMP_SYSTEM = `Ты разбираешь поток мыслей на русском и режешь его на отдельные дела.
Отвечай ТОЛЬКО одним JSON-объектом вида {"items": [...]}, без пояснений и без markdown.
Каждый элемент:
  "title" — суть одного дела без даты, с заглавной буквы, до 80 символов
  "due_at" — срок в формате YYYY-MM-DDTHH:MM:SSZ (UTC) или null
  "assignee" — "danya" | "zhenya" | "both"
Правила:
  одна мысль — один элемент, склеивать разные дела запрещено;
  дат не выдумывай: срок в тексте не назван — ставь due_at: null;
  исполнитель не назван — ставь значение по умолчанию;
  максимум ${DUMP_LIMIT} дел.`

export async function dumpToTasks(env, text, nowIso, tz, defaultAssignee) {
  const user = `${nowLine(nowIso, tz)}\nИсполнитель по умолчанию: ${defaultAssignee}.\nПоток: ${text}`
  const parsed = await askAi(env, DUMP_SYSTEM, user, 900)
  if (!parsed) return null

  const raw = Array.isArray(parsed) ? parsed : parsed.items
  if (!Array.isArray(raw)) return null

  const items = []
  for (const it of raw) {
    const title = String(it?.title ?? '').trim()
    if (!title) continue
    items.push({
      title: title.slice(0, 200),
      dueAt: toIso(it.due_at ?? it.dueAt),
      assignee: ASSIGNEES.has(it.assignee) ? it.assignee : defaultAssignee,
    })
    if (items.length >= DUMP_LIMIT) break
  }
  return items.length ? items : null
}

export function dumpPreview(items, { tz, nowIso, key = draftKey(nowIso) }) {
  const lines = [
    `🧺 <b>Разобрала свалку</b> — ${plural(items.length, 'дело', 'дела', 'дел')}`,
    '',
    ...items.map((it, i) => (
      `${i + 1}. ${esc(it.title)} — ${whenLabel(it.dueAt, tz, nowIso)} ${ICON[it.assignee] ?? ICON.both}`
    )),
    '',
    'Заводить все разом или ткнуть в нужные номера.',
  ]

  const rows = [[{ text: '✅ Завести все', callback_data: `ct:dump:${key}` }]]
  for (let i = 0; i < items.length; i += 5) {
    rows.push(items.slice(i, i + 5).map((_, j) => ({
      text: String(i + j + 1),
      callback_data: `ct:dumpone:${key}:${i + j}`,
    })))
  }
  rows.push([{ text: 'Отмена', callback_data: `ct:cancel:${key}` }])

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } }
}
