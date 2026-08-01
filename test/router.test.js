import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleUpdate } from '../src/router.js'
import * as tg from '../src/telegram.js'
import * as db from '../src/db.js'

const NOW = '2026-08-05T09:00:00Z'
const CHAT = -1001
const env = {
  BOT_TOKEN: 't', BOT_USERNAME: 'planer_bot', DEFAULT_TZ: 'Europe/Moscow',
  DEFAULT_DIGEST_TIME: '10:00', DEFAULT_REMIND_BEFORE_MIN: '30',
  AI_ENABLED: 'false', DB: {},
}

const message = (text, extra = {}) => ({
  update_id: 1,
  message: {
    message_id: 10, text, chat: { id: CHAT, type: 'supergroup' },
    from: { id: 7, first_name: 'Даня' }, ...extra,
  },
})

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(tg, 'sendMessage').mockResolvedValue({ message_id: 11 })
  vi.spyOn(tg, 'editMessageText').mockResolvedValue({})
  vi.spyOn(tg, 'answerCallback').mockResolvedValue({})
  vi.spyOn(db, 'getChat').mockResolvedValue({
    chat_id: CHAT, tz: 'Europe/Moscow', digest_time: '10:00',
    digest_enabled: 1, remind_before_min: 30,
  })
  vi.spyOn(db, 'getUserRole').mockResolvedValue('danya')
  vi.spyOn(db, 'upsertUser').mockResolvedValue()
  vi.spyOn(db, 'isDuplicateUpdate').mockResolvedValue(false)
})

describe('handleUpdate: добавление дела', () => {
  it('по упоминанию создаёт задачу и отвечает карточкой', async () => {
    const create = vi.spyOn(db, 'createTask').mockResolvedValue({
      id: 1, title: 'К врачу', due_at: '2026-08-06T12:00:00.000Z',
      assignee: 'danya', repeat_rule: null,
    })
    await handleUpdate(message('@planer_bot завтра в 15:00 к врачу'), env, NOW)
    expect(create).toHaveBeenCalled()
    const arg = create.mock.calls[0][1]
    expect(arg.title).toBe('К врачу')
    expect(arg.due_at).toBe('2026-08-06T12:00:00.000Z')
    expect(arg.remind_at).toBe('2026-08-06T11:30:00.000Z')
    expect(tg.sendMessage).toHaveBeenCalled()
    expect(tg.sendMessage.mock.calls[0][2]).toContain('К врачу')
  })

  it('дубль апдейта игнорируется', async () => {
    vi.spyOn(db, 'isDuplicateUpdate').mockResolvedValue(true)
    const create = vi.spyOn(db, 'createTask')
    await handleUpdate(message('@planer_bot завтра в 15 к врачу'), env, NOW)
    expect(create).not.toHaveBeenCalled()
  })

  it('без обращения к боту ничего не делает', async () => {
    const create = vi.spyOn(db, 'createTask')
    await handleUpdate(message('слушай, а что там с ремонтом'), env, NOW)
    expect(create).not.toHaveBeenCalled()
    expect(tg.sendMessage).not.toHaveBeenCalled()
  })

  it('дело без даты — спрашивает срок кнопками', async () => {
    vi.spyOn(db, 'createTask').mockResolvedValue({
      id: 2, title: 'Купить корм коту', due_at: null, assignee: 'danya', repeat_rule: null,
    })
    await handleUpdate(message('@planer_bot купить корм коту'), env, NOW)
    const extra = tg.sendMessage.mock.calls[0][3]
    const flat = JSON.stringify(extra.reply_markup)
    expect(flat).toContain('Сегодня')
    expect(flat).toContain('Завтра')
    expect(flat).toContain('Без срока')
  })
})

describe('handleUpdate: команды', () => {
  it('/день показывает список на сегодня', async () => {
    vi.spyOn(db, 'tasksBetween').mockResolvedValue([
      { id: 1, title: 'Зарядка', due_at: '2026-08-05T06:00:00Z', assignee: 'danya' },
    ])
    await handleUpdate(message('/день'), env, NOW)
    expect(tg.sendMessage.mock.calls[0][2]).toContain('Зарядка')
  })

  it('/неделя берёт диапазон в 7 дней', async () => {
    const between = vi.spyOn(db, 'tasksBetween').mockResolvedValue([])
    await handleUpdate(message('/неделя'), env, NOW)
    const [, , from, to] = between.mock.calls[0]
    expect(new Date(to) - new Date(from)).toBe(7 * 86400000)
  })

  it('/мои фильтрует по автору', async () => {
    vi.spyOn(db, 'tasksBetween').mockResolvedValue([
      { id: 1, title: 'Моё', due_at: '2026-08-05T06:00:00Z', assignee: 'danya' },
      { id: 2, title: 'Женино', due_at: '2026-08-05T07:00:00Z', assignee: 'zhenya' },
    ])
    vi.spyOn(db, 'undatedTasks').mockResolvedValue([])
    await handleUpdate(message('/мои'), env, NOW)
    const text = tg.sendMessage.mock.calls[0][2]
    expect(text).toContain('Моё')
    expect(text).not.toContain('Женино')
  })
})

describe('handleUpdate: кнопки', () => {
  const callback = (data) => ({
    update_id: 2,
    callback_query: {
      id: 'cb1', data,
      from: { id: 7, first_name: 'Даня' },
      message: { message_id: 10, chat: { id: CHAT } },
    },
  })

  it('done закрывает дело', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: CHAT, title: 'К врачу', due_at: '2026-08-06T12:00:00Z',
      assignee: 'danya', repeat_rule: null, status: 'open',
    })
    const done = vi.spyOn(db, 'markDone').mockResolvedValue()
    await handleUpdate(callback('done:1'), env, NOW)
    expect(done).toHaveBeenCalledWith(env.DB, 1)
    expect(tg.editMessageText).toHaveBeenCalled()
  })

  it('done у повторяющегося дела создаёт следующее', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: CHAT, title: 'Мусор', due_at: '2026-08-11T06:00:00Z',
      assignee: 'both', repeat_rule: 'weekly:2', status: 'open', created_by: 7,
    })
    vi.spyOn(db, 'markDone').mockResolvedValue()
    const create = vi.spyOn(db, 'createTask').mockResolvedValue({ id: 9 })
    await handleUpdate(callback('done:1'), env, NOW)
    expect(create.mock.calls[0][1].due_at).toBe('2026-08-18T06:00:00.000Z')
  })

  it('перенос на час двигает срок и сбрасывает флаги', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: CHAT, title: 'К врачу', due_at: '2026-08-06T12:00:00Z',
      assignee: 'danya', repeat_rule: null, status: 'open',
    })
    const upd = vi.spyOn(db, 'updateTask').mockResolvedValue()
    await handleUpdate(callback('sn:1:60'), env, NOW)
    expect(upd.mock.calls[0][2].due_at).toBe('2026-08-06T13:00:00.000Z')
    expect(upd.mock.calls[0][2].notified_due).toBe(0)
  })

  it('назначение ответственного', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: CHAT, title: 'К врачу', due_at: '2026-08-06T12:00:00Z',
      assignee: 'danya', repeat_rule: null, status: 'open',
    })
    const upd = vi.spyOn(db, 'updateTask').mockResolvedValue()
    await handleUpdate(callback('as:1:zhenya'), env, NOW)
    expect(upd.mock.calls[0][2].assignee).toBe('zhenya')
  })

  it('чужой чат не может трогать задачу', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: -999, title: 'Чужое', due_at: null,
      assignee: 'danya', repeat_rule: null, status: 'open',
    })
    const done = vi.spyOn(db, 'markDone')
    await handleUpdate(callback('done:1'), env, NOW)
    expect(done).not.toHaveBeenCalled()
  })
})
