import { parseRu } from './ru-dates.js'
import { parseWithAi } from './ai.js'

export async function parseTask(env, text, nowIso, tz) {
  const local = parseRu(text, nowIso, tz)
  if (!local) return { title: '', dueAt: null, repeatRule: null, source: 'none' }

  if (local.matched) {
    return { title: local.title, dueAt: local.dueAt, repeatRule: local.repeatRule, source: 'local' }
  }

  const ai = await parseWithAi(env, text, nowIso, tz)
  if (ai && (ai.dueAt || ai.repeatRule)) {
    return { title: ai.title, dueAt: ai.dueAt, repeatRule: ai.repeatRule, source: 'ai' }
  }

  return { title: local.title, dueAt: null, repeatRule: local.repeatRule, source: 'none' }
}
