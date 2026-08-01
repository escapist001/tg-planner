import { describe, it, expect } from 'vitest'
import { fakeD1 } from './helpers/fake-d1.js'
import {
  createTask, tasksBetween, duePre, dueNow, markNotified,
  updateTask, isDuplicateUpdate,
} from '../src/db.js'

describe('db', () => {
  it('createTask вставляет и возвращает id', async () => {
    const db = fakeD1([{ results: [{ id: 42 }] }])
    const task = await createTask(db, {
      chat_id: -100, title: 'К врачу', due_at: '2026-08-06T12:00:00Z',
      remind_at: '2026-08-06T11:30:00Z', assignee: 'danya', created_by: 7,
      repeat_rule: null, created_at: '2026-08-05T09:00:00Z',
    })
    expect(task.id).toBe(42)
    expect(db.calls[0].sql).toContain('INSERT INTO tasks')
    expect(db.calls[0].params).toContain('К врачу')
  })

  it('tasksBetween фильтрует по чату, статусу и диапазону', async () => {
    const db = fakeD1([{ results: [{ id: 1 }] }])
    const rows = await tasksBetween(db, -100, '2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z')
    expect(rows).toHaveLength(1)
    expect(db.calls[0].sql).toContain("status = 'open'")
    expect(db.calls[0].params).toEqual([-100, '2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z'])
  })

  it('duePre берёт только неотправленные', async () => {
    const db = fakeD1([{ results: [] }])
    await duePre(db, '2026-08-05T09:00:00Z')
    expect(db.calls[0].sql).toContain('notified_pre = 0')
    expect(db.calls[0].sql).toContain('remind_at <= ?')
  })

  it('dueNow берёт просроченные по due_at', async () => {
    const db = fakeD1([{ results: [] }])
    await dueNow(db, '2026-08-05T09:00:00Z')
    expect(db.calls[0].sql).toContain('notified_due = 0')
    expect(db.calls[0].sql).toContain('due_at <= ?')
  })

  it('markNotified обновляет нужное поле', async () => {
    const db = fakeD1([{}])
    await markNotified(db, 5, 'pre')
    expect(db.calls[0].sql).toContain('notified_pre = 1')
  })

  it('updateTask отвергает поля вне белого списка', async () => {
    const db = fakeD1([{}])
    await expect(updateTask(db, 1, { chat_id: 999 })).rejects.toThrow()
  })

  it('isDuplicateUpdate: первый раз false', async () => {
    const db = fakeD1([{ results: [] }, {}])
    expect(await isDuplicateUpdate(db, 123, '2026-08-05T09:00:00Z')).toBe(false)
  })

  it('isDuplicateUpdate: повтор true', async () => {
    const db = fakeD1([{ results: [{ update_id: 123 }] }])
    expect(await isDuplicateUpdate(db, 123, '2026-08-05T09:00:00Z')).toBe(true)
  })
})
