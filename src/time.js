const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const WEEKDAYS_NOM = ['воскресенье', 'понедельник', 'вторник', 'среда',
  'четверг', 'пятница', 'суббота']

const fmtCache = new Map()
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }))
  }
  return fmtCache.get(tz)
}

function partsMap(tz, date) {
  const out = {}
  for (const p of fmt(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value
  }
  return out
}

export function tzOffsetMinutes(tz, date = new Date()) {
  const p = partsMap(tz, date)
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    hour, Number(p.minute), Number(p.second))
  return Math.round((asUtc - date.getTime()) / 60000)
}

export function localParts(iso, tz) {
  const date = new Date(iso)
  const p = partsMap(tz, date)
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  const shifted = new Date(date.getTime() + tzOffsetMinutes(tz, date) * 60000)
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour, minute: Number(p.minute), weekday: shifted.getUTCDay(),
  }
}

export function localToUtcIso({ year, month, day, hour = 0, minute = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  let ts = guess - tzOffsetMinutes(tz, new Date(guess)) * 60000
  ts = guess - tzOffsetMinutes(tz, new Date(ts)) * 60000
  return new Date(ts).toISOString()
}

export function startOfLocalDay(iso, tz) {
  const { year, month, day } = localParts(iso, tz)
  return localToUtcIso({ year, month, day, hour: 0, minute: 0 }, tz)
}

export function addDays(iso, n) {
  return new Date(new Date(iso).getTime() + n * 86400000).toISOString()
}

export function addMinutes(iso, n) {
  return new Date(new Date(iso).getTime() + n * 60000).toISOString()
}

export function localDateKey(iso, tz) {
  const { year, month, day } = localParts(iso, tz)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function formatTime(iso, tz) {
  const { hour, minute } = localParts(iso, tz)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function formatDateHuman(iso, tz, nowIso) {
  const target = localDateKey(iso, tz)
  const today = localDateKey(nowIso, tz)
  const tomorrow = localDateKey(addDays(startOfLocalDay(nowIso, tz), 1), tz)
  const { day, month, weekday } = localParts(iso, tz)
  const tail = `${day} ${MONTHS_GEN[month - 1]}`
  if (target === today) return `сегодня, ${tail}`
  if (target === tomorrow) return `завтра, ${tail}`
  return `${WEEKDAYS_NOM[weekday]}, ${tail}`
}
