import { describe, it, expect } from 'vitest'
import {
  tzOffsetMinutes, localParts, localToUtcIso, startOfLocalDay,
  addDays, addMinutes, localDateKey, formatTime, formatDateHuman,
} from '../src/time.js'

const MSK = 'Europe/Moscow'

describe('time', () => {
  it('смещение Москвы +180 минут', () => {
    expect(tzOffsetMinutes(MSK, new Date('2026-08-02T12:00:00Z'))).toBe(180)
    expect(tzOffsetMinutes(MSK, new Date('2026-01-02T12:00:00Z'))).toBe(180)
  })

  it('разбирает UTC в местные части', () => {
    expect(localParts('2026-08-05T12:00:00Z', MSK)).toEqual({
      year: 2026, month: 8, day: 5, hour: 15, minute: 0, weekday: 3,
    })
  })

  it('собирает местное время обратно в UTC', () => {
    expect(localToUtcIso({ year: 2026, month: 8, day: 5, hour: 15, minute: 0 }, MSK))
      .toBe('2026-08-05T12:00:00.000Z')
  })

  it('переход через полночь местного времени', () => {
    expect(localToUtcIso({ year: 2026, month: 8, day: 5, hour: 1, minute: 30 }, MSK))
      .toBe('2026-08-04T22:30:00.000Z')
  })

  it('начало местного дня', () => {
    expect(startOfLocalDay('2026-08-05T12:00:00Z', MSK)).toBe('2026-08-04T21:00:00.000Z')
  })

  it('сдвиги', () => {
    expect(addDays('2026-08-05T12:00:00Z', 1)).toBe('2026-08-06T12:00:00.000Z')
    expect(addMinutes('2026-08-05T12:00:00Z', 90)).toBe('2026-08-05T13:30:00.000Z')
  })

  it('ключ местной даты', () => {
    expect(localDateKey('2026-08-05T22:30:00Z', MSK)).toBe('2026-08-06')
  })

  it('время местное', () => {
    expect(formatTime('2026-08-05T12:00:00Z', MSK)).toBe('15:00')
  })

  it('человеческая дата', () => {
    const now = '2026-08-05T09:00:00Z'
    expect(formatDateHuman('2026-08-05T12:00:00Z', MSK, now)).toBe('сегодня, 5 августа')
    expect(formatDateHuman('2026-08-06T12:00:00Z', MSK, now)).toBe('завтра, 6 августа')
    expect(formatDateHuman('2026-08-12T12:00:00Z', MSK, now)).toBe('среда, 12 августа')
  })
})
