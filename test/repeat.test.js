import { describe, it, expect } from 'vitest'
import { nextOccurrence } from '../src/repeat.js'

const TZ = 'Europe/Moscow'

describe('nextOccurrence', () => {
  it('ежедневно', () => {
    expect(nextOccurrence('2026-08-05T05:00:00Z', 'daily', TZ)).toBe('2026-08-06T05:00:00.000Z')
  })

  it('еженедельно во вторник', () => {
    expect(nextOccurrence('2026-08-11T06:00:00Z', 'weekly:2', TZ)).toBe('2026-08-18T06:00:00.000Z')
  })

  it('по будням: с пятницы на понедельник', () => {
    expect(nextOccurrence('2026-08-07T04:30:00Z', 'weekdays', TZ)).toBe('2026-08-10T04:30:00.000Z')
  })

  it('ежемесячно 5-го', () => {
    expect(nextOccurrence('2026-08-05T06:00:00Z', 'monthly:5', TZ)).toBe('2026-09-05T06:00:00.000Z')
  })

  it('ежемесячно 31-го: в коротком месяце берём последний день', () => {
    expect(nextOccurrence('2026-08-31T06:00:00Z', 'monthly:31', TZ)).toBe('2026-09-30T06:00:00.000Z')
  })

  it('декабрь -> январь следующего года', () => {
    expect(nextOccurrence('2026-12-05T06:00:00Z', 'monthly:5', TZ)).toBe('2027-01-05T06:00:00.000Z')
  })

  it('без правила -> null', () => {
    expect(nextOccurrence('2026-08-05T06:00:00Z', null, TZ)).toBeNull()
  })
})
