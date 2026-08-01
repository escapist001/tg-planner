import { describe, it, expect } from 'vitest'
import { plural, taskCard, dayList, weekList, digest, reminderText } from '../src/format.js'

const TZ = 'Europe/Moscow'
const NOW = '2026-08-05T09:00:00Z'

const task = (over = {}) => ({
  id: 1, title: 'К врачу', due_at: '2026-08-06T12:00:00Z',
  assignee: 'danya', status: 'open', repeat_rule: null, ...over,
})

describe('plural', () => {
  it('склоняет дела', () => {
    expect(plural(1, 'дело', 'дела', 'дел')).toBe('1 дело')
    expect(plural(2, 'дело', 'дела', 'дел')).toBe('2 дела')
    expect(plural(5, 'дело', 'дела', 'дел')).toBe('5 дел')
    expect(plural(11, 'дело', 'дела', 'дел')).toBe('11 дел')
    expect(plural(22, 'дело', 'дела', 'дел')).toBe('22 дела')
    expect(plural(101, 'дело', 'дела', 'дел')).toBe('101 дело')
  })
})

describe('taskCard', () => {
  it('содержит название, дату и ответственного', () => {
    const card = taskCard(task(), { tz: TZ, nowIso: NOW })
    expect(card.text).toContain('К врачу')
    expect(card.text).toContain('завтра, 6 августа')
    expect(card.text).toContain('15:00')
    expect(card.text).toContain('Даня')
    expect(card.reply_markup.inline_keyboard[0][0].callback_data).toBe('done:1')
  })

  it('дело без срока не показывает время', () => {
    const card = taskCard(task({ due_at: null }), { tz: TZ, nowIso: NOW })
    expect(card.text).toContain('без срока')
  })

  it('повторяющееся дело помечено', () => {
    const card = taskCard(task({ repeat_rule: 'weekly:2' }), { tz: TZ, nowIso: NOW })
    expect(card.text).toContain('каждый вторник')
  })
})

describe('dayList', () => {
  it('пустой день', () => {
    expect(dayList([], { tz: TZ, nowIso: NOW, title: 'Сегодня' })).toContain('пусто')
  })

  it('сортирует по времени', () => {
    const text = dayList([
      task({ id: 2, title: 'Вечер', due_at: '2026-08-05T16:00:00Z' }),
      task({ id: 3, title: 'Утро', due_at: '2026-08-05T06:00:00Z' }),
    ], { tz: TZ, nowIso: NOW, title: 'Сегодня' })
    expect(text.indexOf('Утро')).toBeLessThan(text.indexOf('Вечер'))
  })
})

describe('weekList', () => {
  it('группирует по дням', () => {
    const text = weekList([
      task({ id: 2, title: 'Первое', due_at: '2026-08-05T06:00:00Z' }),
      task({ id: 3, title: 'Второе', due_at: '2026-08-07T06:00:00Z' }),
    ], { tz: TZ, nowIso: NOW })
    expect(text).toContain('Первое')
    expect(text).toContain('Второе')
    expect(text).toContain('5 августа')
    expect(text).toContain('7 августа')
  })
})

describe('digest', () => {
  it('показывает просроченное отдельно', () => {
    const text = digest(
      [task({ id: 2, title: 'Сегодняшнее', due_at: '2026-08-05T12:00:00Z' })],
      [task({ id: 3, title: 'Забытое', due_at: '2026-08-01T12:00:00Z' })],
      { tz: TZ, nowIso: NOW },
    )
    expect(text).toContain('Забытое')
    expect(text).toContain('Сегодняшнее')
    expect(text.indexOf('Забытое')).toBeLessThan(text.indexOf('Сегодняшнее'))
  })

  it('пустой день — короткое сообщение', () => {
    expect(digest([], [], { tz: TZ, nowIso: NOW })).toContain('свободен')
  })
})

describe('reminderText', () => {
  it('предупреждение заранее', () => {
    expect(reminderText(task(), { tz: TZ, nowIso: NOW, kind: 'pre' })).toContain('через')
  })

  it('напоминание в момент', () => {
    expect(reminderText(task(), { tz: TZ, nowIso: NOW, kind: 'due' })).toContain('Пора')
  })
})
