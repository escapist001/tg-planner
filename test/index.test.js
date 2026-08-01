import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker from '../src/index.js'
import * as router from '../src/router.js'
import * as reminders from '../src/reminders.js'

const env = {
  BOT_TOKEN: 't', BOT_USERNAME: 'planer_bot', WEBHOOK_SECRET: 'secret',
  ALLOWED_CHATS: '-1001', DB: {},
}

const post = (body, secret = 'secret') => new Request('https://x/tg', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
  body: JSON.stringify(body),
})

const update = {
  update_id: 1,
  message: { message_id: 1, text: '/день', chat: { id: -1001, type: 'supergroup' }, from: { id: 7 } },
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(router, 'handleUpdate').mockResolvedValue()
  vi.spyOn(reminders, 'runTick').mockResolvedValue({ pre: 0, due: 0, digests: 0 })
})

describe('fetch', () => {
  it('передаёт апдейт роутеру', async () => {
    const res = await worker.fetch(post(update), env, { waitUntil: (p) => p })
    expect(res.status).toBe(200)
    expect(router.handleUpdate).toHaveBeenCalled()
  })

  it('без секрета — 401 и роутер не зовём', async () => {
    const res = await worker.fetch(post(update, 'wrong'), env, { waitUntil: (p) => p })
    expect(res.status).toBe(401)
    expect(router.handleUpdate).not.toHaveBeenCalled()
  })

  it('чужой чат игнорируется', async () => {
    const foreign = { ...update, message: { ...update.message, chat: { id: -999, type: 'group' } } }
    const res = await worker.fetch(post(foreign), env, { waitUntil: (p) => p })
    expect(res.status).toBe(200)
    expect(router.handleUpdate).not.toHaveBeenCalled()
  })

  it('ошибка внутри роутера не роняет ответ', async () => {
    vi.spyOn(router, 'handleUpdate').mockRejectedValue(new Error('boom'))
    const res = await worker.fetch(post(update), env, { waitUntil: (p) => p })
    expect(res.status).toBe(200)
  })

  it('GET / отвечает без секрета', async () => {
    const res = await worker.fetch(new Request('https://x/'), env, { waitUntil: (p) => p })
    expect(res.status).toBe(200)
  })
})

describe('scheduled', () => {
  it('запускает тик напоминаний', async () => {
    await worker.scheduled({ scheduledTime: Date.parse('2026-08-05T09:00:00Z') }, env, { waitUntil: (p) => p })
    expect(reminders.runTick).toHaveBeenCalled()
  })
})
