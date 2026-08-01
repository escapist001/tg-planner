import { localParts, localToUtcIso, addDays } from './time.js'

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()

export function nextOccurrence(dueAtIso, repeatRule, tz) {
  if (!dueAtIso || !repeatRule) return null
  const { hour, minute } = localParts(dueAtIso, tz)

  if (repeatRule === 'daily') return addDays(dueAtIso, 1)

  if (repeatRule === 'weekdays') {
    let iso = addDays(dueAtIso, 1)
    for (let i = 0; i < 7; i++) {
      const wd = localParts(iso, tz).weekday
      if (wd !== 0 && wd !== 6) return iso
      iso = addDays(iso, 1)
    }
    return null
  }

  if (repeatRule.startsWith('weekly:')) return addDays(dueAtIso, 7)

  if (repeatRule.startsWith('monthly:')) {
    const wanted = Number(repeatRule.split(':')[1])
    const { year, month } = localParts(dueAtIso, tz)
    const nextMonth = month === 12 ? 1 : month + 1
    const nextYear = month === 12 ? year + 1 : year
    const day = Math.min(wanted, daysInMonth(nextYear, nextMonth))
    return localToUtcIso({ year: nextYear, month: nextMonth, day, hour, minute }, tz)
  }

  return null
}
