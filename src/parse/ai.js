import { localParts } from '../time.js'

const SYSTEM = `Ты разбираешь короткие бытовые заметки на русском и превращаешь их в задачу.
Отвечай ТОЛЬКО одним JSON-объектом без пояснений и без markdown.
Поля:
  "title" — суть дела без даты и времени, с заглавной буквы, до 80 символов
  "due_at" — срок в формате YYYY-MM-DDTHH:MM:SSZ (UTC) или null
  "repeat_rule" — "daily" | "weekly:N" (N: 0=вс..6=сб) | "monthly:D" | "weekdays" | null
Если срок не указан и не подразумевается — due_at: null. Ничего не выдумывай.`

function extractJson(raw) {
  if (!raw) return null
  const text = typeof raw === 'string' ? raw : raw.response ?? ''
  const match = String(text).match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

export async function parseWithAi(env, text, nowIso, tz) {
  if (env.AI_ENABLED !== 'true' || !env.AI) return null

  const p = localParts(nowIso, tz)
  const nowLine = `Сейчас: ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} `
    + `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}, зона ${tz}.`

  try {
    const out = await env.AI.run(env.AI_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${nowLine}\nЗаметка: ${text}` },
      ],
      max_tokens: 256,
      temperature: 0.1,
    })
    const parsed = extractJson(out)
    if (!parsed || !parsed.title) return null

    let dueAt = null
    if (parsed.due_at) {
      const d = new Date(parsed.due_at)
      if (!Number.isNaN(d.getTime())) dueAt = d.toISOString()
    }

    return {
      title: String(parsed.title).slice(0, 200),
      dueAt,
      repeatRule: parsed.repeat_rule ?? null,
    }
  } catch {
    return null
  }
}
