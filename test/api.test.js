import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleApi } from '../src/api.js'
import * as tasks from '../src/tasks.js'
import * as db from '../src/db.js'

const env = {
  API_TOKEN: 'sekret', ALLOWED_CHATS: '-1001', DEFAULT_TZ: 'Europe/Moscow',
  DEFAULT_DIGEST_TIME: '10:00', DEFAULT_REMIND_BEFORE_MIN: '30', DB: {},
}
const NOW = '2026-08-05T09:00:00Z'

const req = (path, { method = 'GET', body, token = 'sekret' } = {}) =>
  new Request(`https://x${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(tasks, 'addTaskFromText').mockResolvedValue({
    task: { id: 7, title: 'К врачу', due_at: '2026-08-06T12:00:00.000Z', assignee: 'danya' },
    chat: { chat_id: -1001, tz: 'Europe/Moscow' },
    parsed: { source: 'local' },
  })
})

describe('handleApi', () => {
  it('без токена — 401', async () => {
    const res = await handleApi(req('/api/tasks', { method: 'POST', body: { text: 'x' }, token: null }), env, NOW)
    expect(res.status).toBe(401)
  })

  it('с неверным токеном — 401', async () => {
    const res = await handleApi(req('/api/tasks', { method: 'POST', body: { text: 'x' }, token: 'wrong' }), env, NOW)
    expect(res.status).toBe(401)
  })

  it('создаёт дело и возвращает его', async () => {
    const res = await handleApi(req('/api/tasks', { method: 'POST', body: { text: 'завтра в 15 к врачу' } }), env, NOW)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.task.title).toBe('К врачу')
    expect(tasks.addTaskFromText).toHaveBeenCalled()
    expect(tasks.addTaskFromText.mock.calls[0][1].chatId).toBe(-1001)
  })

  it('пустой текст — 400', async () => {
    const res = await handleApi(req('/api/tasks', { method: 'POST', body: { text: '  ' } }), env, NOW)
    expect(res.status).toBe(400)
  })

  it('уважает assignee и notify', async () => {
    await handleApi(req('/api/tasks', {
      method: 'POST', body: { text: 'купить корм', assignee: 'zhenya', notify: false },
    }), env, NOW)
    const arg = tasks.addTaskFromText.mock.calls[0][1]
    expect(arg.assignee).toBe('zhenya')
    expect(arg.notify).toBe(false)
  })

  it('принимает явные due_at и repeat_rule без разбора текста', async () => {
    await handleApi(req('/api/tasks', {
      method: 'POST',
      body: {
        text: 'Позвонить в загс насчёт фамилии',
        due_at: '2026-08-03T08:00:00.000Z',
        repeat_rule: 'weekly:1',
        notify: false,
      },
    }), env, NOW)
    const arg = tasks.addTaskFromText.mock.calls[0][1]
    expect(arg.dueAt).toBe('2026-08-03T08:00:00.000Z')
    expect(arg.repeatRule).toBe('weekly:1')
  })

  it('битый due_at отвергается', async () => {
    const res = await handleApi(req('/api/tasks', {
      method: 'POST', body: { text: 'тест', due_at: 'вчера как-нибудь' },
    }), env, NOW)
    expect(res.status).toBe(400)
  })

  it('список на неделю', async () => {
    const between = vi.spyOn(db, 'tasksBetween').mockResolvedValue([{ id: 1, title: 'Дело' }])
    vi.spyOn(db, 'getChat').mockResolvedValue({ chat_id: -1001, tz: 'Europe/Moscow' })
    const res = await handleApi(req('/api/tasks?range=week'), env, NOW)
    const data = await res.json()
    expect(data.tasks).toHaveLength(1)
    const [, , from, to] = between.mock.calls[0]
    expect(new Date(to) - new Date(from)).toBe(7 * 86400000)
  })

  it('отметка выполнения', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({ id: 7, chat_id: -1001, title: 'Дело', repeat_rule: null })
    vi.spyOn(db, 'getChat').mockResolvedValue({ chat_id: -1001, tz: 'Europe/Moscow', remind_before_min: 30 })
    const done = vi.spyOn(db, 'markDone').mockResolvedValue()
    const res = await handleApi(req('/api/tasks/7/done', { method: 'POST' }), env, NOW)
    expect(res.status).toBe(200)
    expect(done).toHaveBeenCalledWith(env.DB, 7)
  })

  it('отметка повторяющегося дела заводит следующее — как и кнопка в чате', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 7, chat_id: -1001, title: 'Мусор', due_at: '2026-08-11T06:00:00Z',
      assignee: 'both', created_by: 0, repeat_rule: 'weekly:2', parent_id: null,
    })
    vi.spyOn(db, 'getChat').mockResolvedValue({ chat_id: -1001, tz: 'Europe/Moscow', remind_before_min: 30 })
    vi.spyOn(db, 'markDone').mockResolvedValue()
    const create = vi.spyOn(db, 'createTask').mockResolvedValue({ id: 8 })
    const res = await handleApi(req('/api/tasks/7/done', { method: 'POST' }), env, NOW)
    const data = await res.json()
    expect(data.next).toBe('2026-08-18T06:00:00.000Z')
    expect(create.mock.calls[0][1].due_at).toBe('2026-08-18T06:00:00.000Z')
    expect(create.mock.calls[0][1].parent_id).toBe(7)
  })

  it('неизвестный путь — 404', async () => {
    const res = await handleApi(req('/api/nope'), env, NOW)
    expect(res.status).toBe(404)
  })
})
