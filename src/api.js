import * as db from './db.js'
import * as tasks from './tasks.js'
import { startOfLocalDay, addDays } from './time.js'

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
})

function authorized(request, env) {
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  return Boolean(env.API_TOKEN) && token === env.API_TOKEN
}

function allowedChats(env) {
  return (env.ALLOWED_CHATS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
}

// Даже с валидным токеном API работает только по разрешённым чатам:
// утечка токена не должна превращать бота в рассыльщик по всем чатам, где он состоит.
function resolveChatId(env, explicit) {
  const list = allowedChats(env)
  if (!list.length) return null
  if (explicit == null || explicit === '') return Number(list[0])
  return list.includes(String(explicit)) ? Number(explicit) : null
}

export async function handleApi(request, env, nowIso) {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401)

  const url = new URL(request.url)
  const parts = url.pathname.split('/').filter(Boolean) // ['api', 'tasks', ...]

  if (parts[1] !== 'tasks') return json({ ok: false, error: 'not found' }, 404)

  if (parts.length === 2 && request.method === 'POST') {
    const body = await request.json().catch(() => ({}))
    const text = String(body.text ?? '').trim()
    if (!text) return json({ ok: false, error: 'пустой текст' }, 400)

    const chatId = resolveChatId(env, body.chat_id)
    if (!chatId) return json({ ok: false, error: 'чат не разрешён' }, 403)

    const { task, parsed } = await tasks.addTaskFromText(env, {
      chatId, text, authorRole: 'danya', authorId: 0, nowIso,
      notify: body.notify !== false,
      assignee: body.assignee ?? null,
    })
    if (!task) return json({ ok: false, error: 'не понял текст' }, 400)
    return json({ ok: true, task, source: parsed.source })
  }

  if (parts.length === 2 && request.method === 'GET') {
    const chatId = resolveChatId(env, url.searchParams.get("chat_id"))
    if (!chatId) return json({ ok: false, error: 'чат не разрешён' }, 403)

    const chat = await db.getChat(env.DB, chatId, {
      tz: env.DEFAULT_TZ, digestTime: env.DEFAULT_DIGEST_TIME,
      remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN),
    })
    const range = url.searchParams.get('range') ?? 'week'

    if (range === 'undated') return json({ ok: true, tasks: await db.undatedTasks(env.DB, chatId) })

    const shift = range === 'tomorrow' ? 1 : 0
    const span = range === 'week' ? 7 : 1
    const from = addDays(startOfLocalDay(nowIso, chat.tz), shift)
    const to = addDays(from, span)
    return json({ ok: true, tasks: await db.tasksBetween(env.DB, chatId, from, to) })
  }

  if (parts.length === 4 && parts[3] === 'done' && request.method === 'POST') {
    const id = Number(parts[2])
    const task = await db.getTask(env.DB, id)
    if (!task) return json({ ok: false, error: 'дело не найдено' }, 404)
    if (!allowedChats(env).includes(String(task.chat_id))) {
      return json({ ok: false, error: 'чат не разрешён' }, 403)
    }

    const chat = await db.getChat(env.DB, task.chat_id, {
      tz: env.DEFAULT_TZ, digestTime: env.DEFAULT_DIGEST_TIME,
      remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN),
    })
    const next = await tasks.completeTask(env, task, chat, nowIso)
    return json({ ok: true, next })
  }

  return json({ ok: false, error: 'not found' }, 404)
}
