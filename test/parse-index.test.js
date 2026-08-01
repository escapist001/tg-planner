import { describe, it, expect, vi } from 'vitest'
import { parseTask } from '../src/parse/index.js'

const TZ = 'Europe/Moscow'
const NOW = '2026-08-05T09:00:00Z'

describe('parseTask', () => {
  it('свой парсер справился — AI не зовём', async () => {
    const env = { AI_ENABLED: 'true', AI: { run: vi.fn() } }
    const r = await parseTask(env, 'завтра в 15:00 к врачу', NOW, TZ)
    expect(r.source).toBe('local')
    expect(r.dueAt).toBe('2026-08-06T12:00:00.000Z')
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('свой не справился — идём в AI', async () => {
    const env = {
      AI_ENABLED: 'true', AI_MODEL: 'm',
      AI: {
        run: vi.fn().mockResolvedValue({
          response: '{"title":"К нотариусу","due_at":"2026-08-12T09:00:00Z","repeat_rule":null}',
        }),
      },
    }
    const r = await parseTask(env, 'надо бы к нотариусу где-то в середине недели', NOW, TZ)
    expect(env.AI.run).toHaveBeenCalled()
    expect(r.source).toBe('ai')
    expect(r.title).toBe('К нотариусу')
    expect(r.dueAt).toBe('2026-08-12T09:00:00.000Z')
  })

  it('AI упал — возвращаем результат своего парсера', async () => {
    const env = {
      AI_ENABLED: 'true', AI_MODEL: 'm',
      AI: { run: vi.fn().mockRejectedValue(new Error('boom')) },
    }
    const r = await parseTask(env, 'купить корм коту', NOW, TZ)
    expect(r.source).toBe('none')
    expect(r.title).toBe('Купить корм коту')
    expect(r.dueAt).toBeNull()
  })

  it('AI вернул мусор — не падаем', async () => {
    const env = {
      AI_ENABLED: 'true', AI_MODEL: 'm',
      AI: { run: vi.fn().mockResolvedValue({ response: 'я не понял, извините' }) },
    }
    const r = await parseTask(env, 'что-то невнятное', NOW, TZ)
    expect(r.source).toBe('none')
    expect(r.dueAt).toBeNull()
  })

  it('AI выключен — не зовём вовсе', async () => {
    const env = { AI_ENABLED: 'false', AI: { run: vi.fn() } }
    const r = await parseTask(env, 'купить корм коту', NOW, TZ)
    expect(env.AI.run).not.toHaveBeenCalled()
    expect(r.source).toBe('none')
  })
})
