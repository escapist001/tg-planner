import { localParts, localToUtcIso, addDays, addMinutes, startOfLocalDay } from '../time.js'

const DEFAULT_HOUR = 9
const WEEKDAYS = {
  'воскресень': 0, 'вс': 0, 'понедельник': 1, 'понедельника': 1, 'пн': 1,
  'вторник': 2, 'вторника': 2, 'вт': 2, 'сред': 3, 'ср': 3,
  'четверг': 4, 'четверга': 4, 'чт': 4, 'пятниц': 5, 'пт': 5,
  'суббот': 6, 'сб': 6,
}
const MONTHS = {
  'январ': 1, 'феврал': 2, 'март': 3, 'апрел': 4, 'ма': 5, 'июн': 6,
  'июл': 7, 'август': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12,
}
const DAYPARTS = { 'утром': 9, 'днём': 14, 'днем': 14, 'вечером': 19, 'ночью': 23 }
const HALF_HOURS = {
  'полпервого': 0.5, 'полвторого': 1.5, 'полтретьего': 2.5, 'полчетвёртого': 3.5,
  'полчетвертого': 3.5, 'полпятого': 4.5, 'полшестого': 5.5, 'полседьмого': 6.5,
  'полвосьмого': 7.5, 'полдевятого': 8.5, 'полдесятого': 9.5,
  'полодиннадцатого': 10.5, 'полдвенадцатого': 11.5,
}

// `\b` в JS считает словом только [A-Za-z0-9_], поэтому для кириллицы он
// бесполезен: в «завтра в 15:00» границы вокруг «завтра» просто нет.
// Собираем границы вручную по своему классу словесных символов.
const WORD = '0-9A-Za-zА-Яа-яЁё_'
const LB = `(?<![${WORD}])`
const RB = `(?![${WORD}])`
const re = (source, flags = 'i') => new RegExp(`${LB}${source}${RB}`, flags)

const RE_REPEAT_WEEKDAYS = re('по\\s+будням')
const RE_REPEAT_MONTHLY = re('кажд(?:ый|ую|ое|ые)\\s+(\\d{1,2})[-\\s]?[ое]?\\s*числ[оа]')
const RE_REPEAT_EVERY = re('кажд(?:ый|ую|ое)\\s+([а-яё]+)')

const RE_HALF = re(`(?:в\\s+)?(${Object.keys(HALF_HOURS).join('|')})`)
const RE_TIME_HM_PREP = re('в\\s+(\\d{1,2})[:.](\\d{2})')
const RE_TIME_HM = re('(\\d{1,2})[:.](\\d{2})', '')
const RE_TIME_H_PREP = re('в\\s+(\\d{1,2})')
const RE_DAYPART = re(`(${Object.keys(DAYPARTS).join('|')})`)

const RE_AFTER_TOMORROW = re('послезавтра')
const RE_TOMORROW = re('завтра')
const RE_TODAY = re('сегодня')
const RE_REL_N = re('через\\s+(\\d+)\\s*(минут|минуты|мин|час|часа|часов|день|дня|дней|недел[юия]|месяц[а]?)')
const RE_REL_1 = re('через\\s+(недел[юи]|час|день|месяц)')
const RE_DMY = re('(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})', '')
const RE_DM = re('(\\d{1,2})\\.(\\d{1,2})', '')
const RE_DAY_MONTH = re('(\\d{1,2})\\s+([а-яё]{3,})')
const RE_WEEKDAY = re('(?:в|во)\\s+([а-яё]{2,})')

// Вырезаем найденный кусок именно по его позиции: replace() со строкой убрал бы
// первое совпадение подстроки, которое может оказаться совсем в другом месте.
const cut = (text, rx) => {
  const m = text.match(rx)
  if (!m) return [null, text]
  return [m, `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`]
}

function weekdayCode(word) {
  const w = word.toLowerCase()
  for (const [stem, code] of Object.entries(WEEKDAYS)) {
    if (w.startsWith(stem)) return code
  }
  return null
}

function monthCode(word) {
  const w = word.toLowerCase()
  for (const [stem, code] of Object.entries(MONTHS)) {
    if (w.startsWith(stem)) return code
  }
  return null
}

function extractRepeat(text) {
  let rest = text
  let rule = null
  let weekday = null
  let monthDay = null

  let m
  ;[m, rest] = cut(rest, RE_REPEAT_WEEKDAYS)
  if (m) rule = 'weekdays'

  if (!rule) {
    ;[m, rest] = cut(rest, RE_REPEAT_MONTHLY)
    if (m) { rule = `monthly:${Number(m[1])}`; monthDay = Number(m[1]) }
  }
  if (!rule) {
    ;[m, rest] = cut(rest, RE_REPEAT_EVERY)
    if (m) {
      const word = m[1].toLowerCase()
      if (word === 'день' || word === 'дня') rule = 'daily'
      else {
        const wd = weekdayCode(word)
        if (wd !== null) { rule = `weekly:${wd}`; weekday = wd }
        else rest = text // не поняли — вернуть как было
      }
    }
  }
  return { rule, rest, weekday, monthDay }
}

function extractTime(text) {
  let rest = text
  let m

  ;[m, rest] = cut(rest, RE_HALF)
  if (m) {
    const v = HALF_HOURS[m[1].toLowerCase()]
    let hour = Math.floor(v)
    if (hour < 8) hour += 12 // полтретьего — про день
    return { hour, minute: 30, rest }
  }

  ;[m, rest] = cut(rest, RE_TIME_HM_PREP)
  if (m) return { hour: Number(m[1]), minute: Number(m[2]), rest }

  ;[m, rest] = cut(rest, RE_TIME_HM)
  if (m) return { hour: Number(m[1]), minute: Number(m[2]), rest }

  ;[m, rest] = cut(rest, RE_TIME_H_PREP)
  if (m) return { hour: Number(m[1]), minute: 0, rest }

  ;[m, rest] = cut(rest, RE_DAYPART)
  if (m) return { hour: DAYPARTS[m[1].toLowerCase()], minute: 0, rest }

  return { hour: null, minute: null, rest }
}

function extractDate(text) {
  let rest = text
  let m

  ;[m, rest] = cut(rest, RE_AFTER_TOMORROW)
  if (m) return { kind: 'day', shift: 2, rest }

  ;[m, rest] = cut(rest, RE_TOMORROW)
  if (m) return { kind: 'day', shift: 1, rest }

  ;[m, rest] = cut(rest, RE_TODAY)
  if (m) return { kind: 'day', shift: 0, rest }

  ;[m, rest] = cut(rest, RE_REL_N)
  if (m) return { kind: 'relative', amount: Number(m[1]), unit: m[2].toLowerCase(), rest }

  ;[m, rest] = cut(rest, RE_REL_1)
  if (m) return { kind: 'relative', amount: 1, unit: m[1].toLowerCase(), rest }

  ;[m, rest] = cut(rest, RE_DMY)
  if (m) return { kind: 'exact', day: +m[1], month: +m[2], year: +m[3], rest }

  ;[m, rest] = cut(rest, RE_DM)
  if (m) return { kind: 'exact', day: +m[1], month: +m[2], rest }

  ;[m, rest] = cut(rest, RE_DAY_MONTH)
  if (m) {
    const month = monthCode(m[2])
    if (month) return { kind: 'exact', day: +m[1], month, rest }
    rest = text
  }

  ;[m, rest] = cut(rest, RE_WEEKDAY)
  if (m) {
    const wd = weekdayCode(m[1])
    if (wd !== null) return { kind: 'weekday', weekday: wd, rest }
    rest = text
  }

  return { kind: null, rest }
}

function cleanTitle(text) {
  const t = text.replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

export function parseRu(text, nowIso, tz) {
  if (!text || !text.trim()) return null

  const rep = extractRepeat(text)
  const dateRes = extractDate(rep.rest)
  const timeRes = extractTime(dateRes.rest)
  const title = cleanTitle(timeRes.rest)

  const now = localParts(nowIso, tz)
  const hour = timeRes.hour ?? DEFAULT_HOUR
  const minute = timeRes.minute ?? 0
  const hasTime = timeRes.hour !== null

  let dueAt = null

  if (dateRes.kind === 'relative') {
    const u = dateRes.unit
    if (u.startsWith('мин')) dueAt = addMinutes(nowIso, dateRes.amount)
    else if (u.startsWith('час')) dueAt = addMinutes(nowIso, dateRes.amount * 60)
    else if (u.startsWith('д')) dueAt = addDays(nowIso, dateRes.amount)
    else if (u.startsWith('недел')) dueAt = addDays(nowIso, dateRes.amount * 7)
    else if (u.startsWith('месяц')) dueAt = addDays(nowIso, dateRes.amount * 30)
    if (dueAt && hasTime) {
      const d = localParts(dueAt, tz)
      dueAt = localToUtcIso({ year: d.year, month: d.month, day: d.day, hour, minute }, tz)
    }
  } else if (dateRes.kind === 'day') {
    const base = localParts(addDays(startOfLocalDay(nowIso, tz), dateRes.shift), tz)
    dueAt = localToUtcIso({ year: base.year, month: base.month, day: base.day, hour, minute }, tz)
  } else if (dateRes.kind === 'weekday') {
    const shift = (dateRes.weekday - now.weekday + 7) % 7
    const candidate = localParts(addDays(startOfLocalDay(nowIso, tz), shift), tz)
    let iso = localToUtcIso({ year: candidate.year, month: candidate.month, day: candidate.day, hour, minute }, tz)
    if (new Date(iso) <= new Date(nowIso)) {
      const next = localParts(addDays(startOfLocalDay(nowIso, tz), shift + 7), tz)
      iso = localToUtcIso({ year: next.year, month: next.month, day: next.day, hour, minute }, tz)
    }
    dueAt = iso
  } else if (dateRes.kind === 'exact') {
    const year = dateRes.year ?? now.year
    let iso = localToUtcIso({ year, month: dateRes.month, day: dateRes.day, hour, minute }, tz)
    if (!dateRes.year && new Date(iso) < new Date(nowIso)) {
      iso = localToUtcIso({ year: year + 1, month: dateRes.month, day: dateRes.day, hour, minute }, tz)
    }
    dueAt = iso
  } else if (rep.rule) {
    dueAt = firstOccurrence(rep, { hour, minute }, nowIso, tz)
  } else if (hasTime) {
    let iso = localToUtcIso({ year: now.year, month: now.month, day: now.day, hour, minute }, tz)
    if (new Date(iso) <= new Date(nowIso)) iso = addDays(iso, 1)
    dueAt = iso
  }

  if (rep.rule && dateRes.kind === null && dueAt === null) {
    dueAt = firstOccurrence(rep, { hour, minute }, nowIso, tz)
  }

  return {
    title,
    dueAt,
    repeatRule: rep.rule,
    matched: Boolean(dueAt || rep.rule),
  }
}

function firstOccurrence(rep, { hour, minute }, nowIso, tz) {
  const now = localParts(nowIso, tz)
  const at = (shiftDays) => {
    const d = localParts(addDays(startOfLocalDay(nowIso, tz), shiftDays), tz)
    return localToUtcIso({ year: d.year, month: d.month, day: d.day, hour, minute }, tz)
  }
  if (rep.rule === 'daily' || rep.rule === 'weekdays') {
    for (let i = 0; i < 8; i++) {
      const iso = at(i)
      if (new Date(iso) > new Date(nowIso)) {
        if (rep.rule === 'weekdays') {
          const wd = localParts(iso, tz).weekday
          if (wd === 0 || wd === 6) continue
        }
        return iso
      }
    }
  }
  if (rep.rule?.startsWith('weekly:')) {
    const target = Number(rep.rule.split(':')[1])
    for (let i = 0; i < 15; i++) {
      const iso = at(i)
      if (localParts(iso, tz).weekday === target && new Date(iso) > new Date(nowIso)) return iso
    }
  }
  if (rep.rule?.startsWith('monthly:')) {
    const day = Number(rep.rule.split(':')[1])
    let iso = localToUtcIso({ year: now.year, month: now.month, day, hour, minute }, tz)
    if (new Date(iso) <= new Date(nowIso)) {
      const nextMonth = now.month === 12 ? 1 : now.month + 1
      const nextYear = now.month === 12 ? now.year + 1 : now.year
      iso = localToUtcIso({ year: nextYear, month: nextMonth, day, hour, minute }, tz)
    }
    return iso
  }
  return null
}
