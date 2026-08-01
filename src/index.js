import * as router from './router.js'
import * as reminders from './reminders.js'
import * as api from './api.js'

function chatIdOf(update) {
  return update?.message?.chat?.id
    ?? update?.edited_message?.chat?.id
    ?? update?.callback_query?.message?.chat?.id
    ?? null
}

function allowed(env, chatId) {
  const list = (env.ALLOWED_CHATS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!list.length) return true
  return list.includes(String(chatId))
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (url.pathname.startsWith('/api/')) {
      const nowIso = new Date().toISOString()
      try {
        return await api.handleApi(request, env, nowIso)
      } catch (e) {
        console.error('ошибка API', e.message, e.stack)
        return new Response(JSON.stringify({ ok: false, error: 'internal' }), {
          status: 500, headers: { 'content-type': 'application/json' },
        })
      }
    }

    if (request.method === 'GET') return new Response('tg-planner жив')

    if (url.pathname !== '/tg') return new Response('not found', { status: 404 })

    if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
      return new Response('unauthorized', { status: 401 })
    }

    let update
    try {
      update = await request.json()
    } catch {
      return new Response('ok')
    }

    const chatId = chatIdOf(update)
    if (chatId == null || !allowed(env, chatId)) {
      console.log('апдейт из неразрешённого чата', chatId)
      return new Response('ok')
    }

    const nowIso = new Date().toISOString()
    try {
      await router.handleUpdate(update, env, nowIso)
    } catch (e) {
      console.error('ошибка обработки апдейта', e.message, e.stack)
    }
    // Telegram всегда получает 200: иначе он будет слать этот апдейт снова и снова.
    return new Response('ok')
  },

  async scheduled(event, env, ctx) {
    const nowIso = new Date(event.scheduledTime ?? Date.now()).toISOString()
    try {
      const stats = await reminders.runTick(env, nowIso)
      if (stats.pre || stats.due || stats.digests) console.log('tick', JSON.stringify(stats))
    } catch (e) {
      console.error('ошибка тика', e.message, e.stack)
    }
  },
}
