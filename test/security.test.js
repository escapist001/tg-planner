// Тесты на найденное аудитом. Каждый закрывает конкретную дыру, чтобы она не вернулась.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker from '../src/index.js'
import { handleApi } from '../src/api.js'
import { handleUpdate } from '../src/router.js'
import { taskCard, dayList, esc } from '../src/format.js'
import { parseRu } from '../src/parse/ru-dates.js'
import * as router from '../src/router.js'
import * as tg from '../src/telegram.js'
import * as db from '../src/db.js'
import * as tasks from '../src/tasks.js'

const NOW = '2026-08-05T09:00:00Z'
const CHAT = -1001
const TZ = 'Europe/Moscow'

const baseEnv = {
  BOT_TOKEN: 't', BOT_USERNAME: 'planer_bot', WEBHOOK_SECRET: 'secret',
  API_TOKEN: 'sekret', DEFAULT_TZ: TZ, DEFAULT_DIGEST_TIME: '10:00',
  DEFAULT_REMIND_BEFORE_MIN: '30', AI_ENABLED: 'false', DB: {},
}

const post = (body, secret = 'secret') => new Request('https://x/tg', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
  body: JSON.stringify(body),
})

const update = {
  update_id: 1,
  message: { message_id: 1, text: '/today', chat: { id: CHAT, type: 'supergroup' }, from: { id: 7 } },
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(tg, 'sendMessage').mockResolvedValue({})
  vi.spyOn(tg, 'editMessageText').mockResolvedValue({})
  vi.spyOn(tg, 'answerCallback').mockResolvedValue({})
})

describe('белый список чатов не должен быть fail-open', () => {
  it('пустой ALLOWED_CHATS никого не пускает к обработке', async () => {
    const handle = vi.spyOn(router, 'handleUpdate').mockResolvedValue()
    const env = { ...baseEnv, ALLOWED_CHATS: '' }
    const res = await worker.fetch(post(update), env, { waitUntil: (p) => p })
    expect(res.status).toBe(200)
    expect(handle).not.toHaveBeenCalled()
  })

  it('в режиме настройки бот сообщает свой chat_id', async () => {
    vi.spyOn(router, 'handleUpdate').mockResolvedValue()
    const env = { ...baseEnv, ALLOWED_CHATS: '' }
    await worker.fetch(post(update), env, { waitUntil: (p) => p })
    expect(tg.sendMessage).toHaveBeenCalled()
    expect(tg.sendMessage.mock.calls[0][2]).toContain(String(CHAT))
  })

  it('чат вне списка не обрабатывается и молчит', async () => {
    const handle = vi.spyOn(router, 'handleUpdate').mockResolvedValue()
    const env = { ...baseEnv, ALLOWED_CHATS: '-999' }
    await worker.fetch(post(update), env, { waitUntil: (p) => p })
    expect(handle).not.toHaveBeenCalled()
    expect(tg.sendMessage).not.toHaveBeenCalled()
  })
})

describe('API не должен выходить за разрешённые чаты', () => {
  const req = (path, { method = 'GET', body } = {}) => new Request(`https://x${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: 'Bearer sekret' },
    body: body ? JSON.stringify(body) : undefined,
  })

  it('создание дела в чужом чате отвергается', async () => {
    const add = vi.spyOn(tasks, 'addTaskFromText')
    const env = { ...baseEnv, ALLOWED_CHATS: '-1001' }
    const res = await handleApi(req('/api/tasks', { method: 'POST', body: { text: 'привет', chat_id: -999 } }), env, NOW)
    expect(res.status).toBe(403)
    expect(add).not.toHaveBeenCalled()
  })

  it('чтение чужого чата отвергается', async () => {
    const env = { ...baseEnv, ALLOWED_CHATS: '-1001' }
    const res = await handleApi(req('/api/tasks?chat_id=-999'), env, NOW)
    expect(res.status).toBe(403)
  })

  it('нельзя закрыть дело из чужого чата', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({ id: 5, chat_id: -999, title: 'Чужое', repeat_rule: null })
    const done = vi.spyOn(db, 'markDone').mockResolvedValue()
    const env = { ...baseEnv, ALLOWED_CHATS: '-1001' }
    const res = await handleApi(req('/api/tasks/5/done', { method: 'POST' }), env, NOW)
    expect(res.status).toBe(403)
    expect(done).not.toHaveBeenCalled()
  })

  it('без ALLOWED_CHATS API закрыт полностью', async () => {
    const env = { ...baseEnv, ALLOWED_CHATS: '' }
    const res = await handleApi(req('/api/tasks', { method: 'POST', body: { text: 'привет' } }), env, NOW)
    expect(res.status).toBe(403)
  })
})

describe('пользовательский текст не должен ломать HTML-разметку', () => {
  const nasty = 'купить 3<5 литров & <a href="http://evil">жми</a>'

  it('esc экранирует угловые скобки и амперсанд', () => {
    expect(esc(nasty)).not.toContain('<a href')
    expect(esc(nasty)).toContain('&lt;')
    expect(esc(nasty)).toContain('&amp;')
  })

  it('карточка дела не содержит сырых тегов из названия', () => {
    const card = taskCard(
      { id: 1, title: nasty, due_at: '2026-08-06T12:00:00Z', assignee: 'danya', repeat_rule: null },
      { tz: TZ, nowIso: NOW },
    )
    expect(card.text).not.toContain('<a href')
    expect(card.text).toContain('&lt;a href')
  })

  it('список дня не содержит сырых тегов', () => {
    const text = dayList(
      [{ id: 1, title: nasty, due_at: '2026-08-05T12:00:00Z', assignee: 'danya' }],
      { tz: TZ, nowIso: NOW, title: 'Сегодня' },
    )
    expect(text).not.toContain('<a href')
  })

  it('карточка «когда напомнить» экранирует название', async () => {
    vi.spyOn(db, 'isDuplicateUpdate').mockResolvedValue(false)
    vi.spyOn(db, 'getChat').mockResolvedValue({
      chat_id: CHAT, tz: TZ, digest_time: '10:00', digest_enabled: 1, remind_before_min: 30,
    })
    vi.spyOn(db, 'getUserRole').mockResolvedValue('danya')
    vi.spyOn(db, 'upsertUser').mockResolvedValue()
    vi.spyOn(db, 'createTask').mockResolvedValue({
      id: 3, title: nasty, due_at: null, assignee: 'danya', repeat_rule: null,
    })
    await handleUpdate({
      update_id: 9,
      message: {
        message_id: 1, text: `@planer_bot ${nasty}`,
        chat: { id: CHAT, type: 'supergroup' }, from: { id: 7, first_name: 'Даня' },
      },
    }, { ...baseEnv, ALLOWED_CHATS: '-1001' }, NOW)
    const sent = tg.sendMessage.mock.calls[0][2]
    expect(sent).not.toContain('<a href')
    expect(sent).toContain('&lt;')
  })

  it('отметка «готово» экранирует название', async () => {
    vi.spyOn(db, 'isDuplicateUpdate').mockResolvedValue(false)
    vi.spyOn(db, 'getChat').mockResolvedValue({
      chat_id: CHAT, tz: TZ, digest_time: '10:00', digest_enabled: 1, remind_before_min: 30,
    })
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: CHAT, title: nasty, due_at: '2026-08-06T12:00:00Z',
      assignee: 'danya', repeat_rule: null, status: 'open',
    })
    vi.spyOn(db, 'markDone').mockResolvedValue()
    await handleUpdate({
      update_id: 10,
      callback_query: {
        id: 'cb', data: 'done:1', from: { id: 7 },
        message: { message_id: 4, chat: { id: CHAT } },
      },
    }, { ...baseEnv, ALLOWED_CHATS: '-1001' }, NOW)
    expect(tg.editMessageText.mock.calls[0][3]).not.toContain('<a href')
  })
})

describe('прочее', () => {
  it('название дела обрезается, чтобы не раздувать сообщения', () => {
    const long = 'а'.repeat(500)
    expect(parseRu(`завтра в 10 ${long}`, NOW, TZ).title.length).toBeLessThanOrEqual(200)
  })

  it('неизвестный исполнитель в кнопке не пишется в базу', async () => {
    vi.spyOn(db, 'isDuplicateUpdate').mockResolvedValue(false)
    vi.spyOn(db, 'getChat').mockResolvedValue({
      chat_id: CHAT, tz: TZ, digest_time: '10:00', digest_enabled: 1, remind_before_min: 30,
    })
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: CHAT, title: 'Дело', due_at: null, assignee: 'danya',
      repeat_rule: null, status: 'open',
    })
    const upd = vi.spyOn(db, 'updateTask').mockResolvedValue()
    await handleUpdate({
      update_id: 11,
      callback_query: {
        id: 'cb', data: 'as:1:hacker', from: { id: 7 },
        message: { message_id: 4, chat: { id: CHAT } },
      },
    }, { ...baseEnv, ALLOWED_CHATS: '-1001' }, NOW)
    expect(upd).not.toHaveBeenCalled()
  })
})
