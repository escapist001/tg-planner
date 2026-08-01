import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runTick } from '../src/reminders.js'
import * as tg from '../src/telegram.js'
import * as db from '../src/db.js'

const env = { BOT_TOKEN: 't', DB: {} }
const CHAT = -1001
const NOW = '2026-08-05T09:00:00Z' // 12:00 МСК

const chat = {
  chat_id: CHAT, tz: 'Europe/Moscow', digest_time: '10:00',
  digest_enabled: 1, remind_before_min: 30, last_digest_date: '2026-08-05',
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(tg, 'sendMessage').mockResolvedValue({})
  vi.spyOn(db, 'duePre').mockResolvedValue([])
  vi.spyOn(db, 'dueNow').mockResolvedValue([])
  vi.spyOn(db, 'chatsForDigest').mockResolvedValue([chat])
  vi.spyOn(db, 'markNotified').mockResolvedValue()
  vi.spyOn(db, 'markDigestSent').mockResolvedValue()
  vi.spyOn(db, 'tasksBetween').mockResolvedValue([])
  vi.spyOn(db, 'overdueTasks').mockResolvedValue([])
})

describe('runTick: напоминания', () => {
  const task = {
    id: 1, chat_id: CHAT, title: 'К врачу', due_at: '2026-08-05T09:30:00Z',
    remind_at: '2026-08-05T09:00:00Z', assignee: 'danya', repeat_rule: null,
  }

  it('шлёт предупреждение и помечает', async () => {
    vi.spyOn(db, 'duePre').mockResolvedValue([task])
    const res = await runTick(env, NOW)
    expect(res.pre).toBe(1)
    expect(tg.sendMessage.mock.calls[0][2]).toContain('К врачу')
    expect(db.markNotified).toHaveBeenCalledWith(env.DB, 1, 'pre')
  })

  it('шлёт напоминание в момент срока', async () => {
    vi.spyOn(db, 'dueNow').mockResolvedValue([{ ...task, due_at: '2026-08-05T09:00:00Z' }])
    const res = await runTick(env, NOW)
    expect(res.due).toBe(1)
    expect(db.markNotified).toHaveBeenCalledWith(env.DB, 1, 'due')
  })

  it('если отправка упала — флаг не ставим', async () => {
    vi.spyOn(db, 'duePre').mockResolvedValue([task])
    vi.spyOn(tg, 'sendMessage').mockRejectedValue(new Error('network'))
    const res = await runTick(env, NOW)
    expect(res.pre).toBe(0)
    expect(db.markNotified).not.toHaveBeenCalled()
  })
})

describe('runTick: дайджест', () => {
  it('в 10:00 по местному шлёт дайджест один раз', async () => {
    const at10 = '2026-08-05T07:00:00Z' // 10:00 МСК
    vi.spyOn(db, 'chatsForDigest').mockResolvedValue([{ ...chat, last_digest_date: null }])
    vi.spyOn(db, 'tasksBetween').mockResolvedValue([
      { id: 5, title: 'Зарядка', due_at: '2026-08-05T09:00:00Z', assignee: 'danya' },
    ])
    const res = await runTick(env, at10)
    expect(res.digests).toBe(1)
    expect(tg.sendMessage.mock.calls[0][2]).toContain('Зарядка')
    expect(db.markDigestSent).toHaveBeenCalledWith(env.DB, CHAT, '2026-08-05')
  })

  it('повторно в тот же день не шлёт', async () => {
    const at10 = '2026-08-05T07:00:00Z'
    vi.spyOn(db, 'chatsForDigest').mockResolvedValue([{ ...chat, last_digest_date: '2026-08-05' }])
    const res = await runTick(env, at10)
    expect(res.digests).toBe(0)
  })

  it('не в час дайджеста — молчит', async () => {
    vi.spyOn(db, 'chatsForDigest').mockResolvedValue([{ ...chat, last_digest_date: null }])
    const res = await runTick(env, NOW) // 12:00 МСК
    expect(res.digests).toBe(0)
  })

  it('догоняет пропущенный дайджест позже в тот же день', async () => {
    const at11 = '2026-08-05T08:05:00Z' // 11:05 МСК
    vi.spyOn(db, 'chatsForDigest').mockResolvedValue([{ ...chat, last_digest_date: '2026-08-04' }])
    const res = await runTick(env, at11)
    expect(res.digests).toBe(1)
  })
})
