// Зомби-дела: те, что кочуют из дайджеста в дайджест.
// Здесь две связанные штуки — разговор на пятом переносе (идея 1)
// и дробилка крупного дела на шаги через нейросеть (идея 2).
import * as db from '../db.js'
import * as tg from '../telegram.js'
import { esc, plural } from '../format.js'
import { formatDateHuman, formatTime, localParts, addMinutes } from '../time.js'

// После какого числа переносов бот перестаёт молчать.
export const INTERVENTION_AT = 5

// Подзадачам ставим напоминание за полчаса — они мелкие, раньше дёргать незачем.
const STEP_REMIND_BEFORE_MIN = 30

// Сколько шагов вообще имеет смысл заводить: меньше двух — это тот же монстр,
// больше пяти — новая свалка вместо одного дела.
const MIN_STEPS = 2
const MAX_STEPS = 5

// ─── Пятый перенос ───────────────────────────────────────────────────────────

// Дёргается на каждой кнопке переноса. Возвращает новое значение счётчика,
// чтобы вызывающий код сразу мог спросить shouldIntervene().
export async function registerPostpone(env, task, nowIso) {
  const next = Number(task.postpone_count ?? 0) + 1
  await db.updateTask(env.DB, task.id, { postpone_count: next })
  return next
}

export function shouldIntervene(count) {
  return Number(count ?? 0) >= INTERVENTION_AT
}

// formatDateHuman отдаёт «вторник, 14 июля», а для даты рождения дела
// хватает хвоста без дня недели: «14 июля».
function dayAndMonth(iso, tz, nowIso) {
  const human = formatDateHuman(iso, tz, nowIso)
  const comma = human.indexOf(', ')
  return comma === -1 ? human : human.slice(comma + 2)
}

// Тон здесь важнее текста: человек не виноват, что дело оказалось тяжёлым.
// Никаких упрёков, только факты и четыре выхода.
export function interventionMessage(task, { tz, nowIso }) {
  const count = Number(task.postpone_count ?? 0)
  const lines = [`🕰 <b>${esc(task.title)}</b>`, '']

  const times = plural(count, 'раз', 'раза', 'раз')
  lines.push(task.created_at
    ? `Дело переносили уже ${times} — оно ждёт с ${dayAndMonth(task.created_at, tz, nowIso)}.`
    : `Дело переносили уже ${times}.`)
  lines.push('Так обычно ведут себя дела, которые оказались крупнее, чем выглядели, '
    + 'или упираются во что-то снаружи. Бывает.')
  lines.push('')
  lines.push('Давай решим, что с ним делать.')

  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: '🧩 Разбить на шаги', callback_data: `zb:split:${task.id}` },
        { text: '🤝 Отдать партнёру', callback_data: `zb:give:${task.id}` },
      ], [
        { text: '🎯 Жёсткий день', callback_data: `zb:hard:${task.id}` },
        { text: '🗑 Признать и удалить', callback_data: `zb:drop:${task.id}` },
      ]],
    },
  }
}

// Считает перенос и, если счётчик дорос, сам присылает разговор.
export async function maybeIntervene(env, task, { tz, nowIso }) {
  const count = await registerPostpone(env, task, nowIso)
  if (!shouldIntervene(count)) return { count, intervened: false }

  const msg = interventionMessage({ ...task, postpone_count: count }, { tz, nowIso })
  await tg.sendMessage(env, task.chat_id, msg.text, { reply_markup: msg.reply_markup })
  return { count, intervened: true }
}

export async function markHardDay(env, taskId) {
  await db.updateTask(env.DB, taskId, { hard_day: 1 })
}

// У дела с жёстким днём короткие переносы пропадают: «+15 мин» — это и есть
// механика, которой дело доехало до пятого раза.
export function snoozeOptionsFor(task) {
  const id = task.id
  if (task.hard_day) {
    return [{ text: '⚠️ Завтра', callback_data: `sn:${id}:tomorrow` }]
  }
  return [
    { text: '+15 мин', callback_data: `sn:${id}:15` },
    { text: '+1 час', callback_data: `sn:${id}:60` },
    { text: 'Вечером', callback_data: `sn:${id}:evening` },
    { text: 'Завтра', callback_data: `sn:${id}:tomorrow` },
  ]
}

// Текст над кнопками переноса: у жёсткого дня он объясняет, куда делись варианты.
export function snoozePrompt(task) {
  if (task.hard_day) {
    return `⚠️ <b>${esc(task.title)}</b>\nУ дела жёсткий день, короткие переносы выключены. `
      + 'Остался один вариант — завтра.'
  }
  return `⏰ <b>${esc(task.title)}</b>\nНа сколько отложить?`
}

export function snoozeKeyboardFor(task) {
  return { inline_keyboard: [snoozeOptionsFor(task)] }
}

// ─── Дробилка ────────────────────────────────────────────────────────────────

const SPLIT_SYSTEM = `Ты помогаешь разложить крупное бытовое дело на конкретные шаги.
Отвечай ТОЛЬКО одним JSON-объектом без пояснений и без markdown.
Формат: {"steps": [{"title": "...", "due_at": "YYYY-MM-DDTHH:MM:SSZ"}]}
Правила:
  шагов от 3 до 5, каждый — законченное действие на один подход;
  "title" — до 80 символов, с заглавной буквы, без даты внутри;
  "due_at" — срок в UTC, шаги идут по возрастанию срока, первый ближайший;
  если срок шага непонятен — поставь null;
  опирайся только на формулировку дела, ничего не выдумывай сверх неё.`

// Модель любит обрамлять JSON болтовнёй и markdown-заборами, поэтому
// вытаскиваем первый объект или массив, а на всё остальное отвечаем null.
function extractJson(raw) {
  if (!raw) return null
  const text = typeof raw === 'string' ? raw : raw.response ?? ''
  const match = String(text).match(/[{[][\s\S]*[}\]]/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

function normalizeStep(raw) {
  if (!raw || typeof raw !== 'object') return null
  const title = typeof raw.title === 'string' ? raw.title.trim() : ''
  if (!title) return null

  let dueAt = null
  if (raw.due_at) {
    const d = new Date(raw.due_at)
    if (!Number.isNaN(d.getTime())) dueAt = d.toISOString()
  }
  return { title: title.slice(0, 200), dueAt }
}

// Возвращает массив шагов либо null. Null означает «нейросеть не справилась»,
// и тогда вызывающий код просто говорит об этом человеку, ничего не придумывая.
export async function splitTask(env, task, nowIso, tz) {
  if (!env.AI || !task?.title) return null

  const p = localParts(nowIso, tz)
  const nowLine = `Сейчас: ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} `
    + `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}, зона ${tz}.`
  const dueLine = task.due_at ? `\nСрок всего дела: ${task.due_at}.` : ''

  try {
    const out = await env.AI.run(env.AI_MODEL, {
      messages: [
        { role: 'system', content: SPLIT_SYSTEM },
        { role: 'user', content: `${nowLine}${dueLine}\nДело: ${task.title}` },
      ],
      max_tokens: 512,
      temperature: 0.2,
    })

    const parsed = extractJson(out)
    const rawSteps = Array.isArray(parsed) ? parsed : parsed?.steps
    if (!Array.isArray(rawSteps)) return null

    const steps = rawSteps.map(normalizeStep).filter(Boolean).slice(0, MAX_STEPS)
    if (steps.length < MIN_STEPS) return null
    return steps
  } catch {
    return null
  }
}

function stepWhen(step, tz, nowIso) {
  if (!step.dueAt) return 'без срока'
  return `${formatDateHuman(step.dueAt, tz, nowIso)}, ${formatTime(step.dueAt, tz)}`
}

export function splitPreview(task, steps, { tz, nowIso }) {
  const lines = [`🧩 <b>${esc(task.title)}</b>`, '']
  lines.push(`Получилось ${plural(steps.length, 'шаг', 'шага', 'шагов')}:`)
  lines.push('')
  steps.forEach((s, i) => {
    lines.push(`${i + 1}. <b>${esc(s.title)}</b> — ${esc(stepWhen(s, tz, nowIso))}`)
  })
  lines.push('')
  lines.push('Заведу их отдельными делами, а само дело закрою — оно превратится в этот список.')

  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Завести все', callback_data: `zb:apply:${task.id}` },
        { text: '✖️ Отмена', callback_data: `zb:cancel:${task.id}` },
      ]],
    },
  }
}

// ─── Черновик шагов между показом и подтверждением ───────────────────────────

export const splitFlagKey = (taskId) => `split:${taskId}`

export async function saveSplitDraft(env, chatId, taskId, steps) {
  await db.setFlag(env.DB, chatId, splitFlagKey(taskId), JSON.stringify(steps))
}

export async function loadSplitDraft(env, chatId, taskId) {
  const raw = await db.getFlag(env.DB, chatId, splitFlagKey(taskId))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length ? parsed : null
  } catch {
    return null
  }
}

export async function clearSplitDraft(env, chatId, taskId) {
  await db.deleteFlag(env.DB, chatId, splitFlagKey(taskId))
}

// Заводит подзадачи и закрывает родителя: дело целиком переехало в шаги.
export async function applySplit(env, task, steps, nowIso) {
  const created = []
  for (const step of steps) {
    const sub = await db.createTask(env.DB, {
      chat_id: task.chat_id,
      title: step.title,
      due_at: step.dueAt ?? null,
      remind_at: step.dueAt ? addMinutes(step.dueAt, -STEP_REMIND_BEFORE_MIN) : null,
      assignee: task.assignee,
      created_by: task.created_by,
      parent_id: task.id,
      created_at: nowIso,
      tag: task.tag ?? null,
    })
    created.push(sub)
  }

  await db.markDone(env.DB, task.id)
  await clearSplitDraft(env, task.chat_id, task.id)
  return created
}

export function splitDoneText(task, steps) {
  return `✅ Готово: <b>${esc(task.title)}</b> разложено на `
    + `${plural(steps.length, 'шаг', 'шага', 'шагов')}. Само дело закрыл.`
}
