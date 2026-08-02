import { formatTime, formatDateHuman, localDateKey } from './time.js'

export const ASSIGNEE_LABEL = { danya: 'Даня', zhenya: 'Женя', both: 'Оба' }
const ASSIGNEE_ICON = { danya: '🐊', zhenya: '🐈‍⬛', both: '👫' }
const WEEKDAY_ACC = ['воскресенье', 'понедельник', 'вторник', 'среду',
  'четверг', 'пятницу', 'субботу']

export function plural(n, one, few, many) {
  const mod10 = n % 10
  const mod100 = n % 100
  let word = many
  if (mod10 === 1 && mod100 !== 11) word = one
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = few
  return `${n} ${word}`
}

export function repeatLabel(rule) {
  if (!rule) return null
  if (rule === 'daily') return 'каждый день'
  if (rule === 'weekdays') return 'по будням'
  if (rule.startsWith('weekly:')) return `каждый ${WEEKDAY_ACC[Number(rule.split(':')[1])]}`
  if (rule.startsWith('monthly:')) return `каждое ${rule.split(':')[1]}-е число`
  return null
}

// Любой пользовательский текст обязан пройти через это перед вставкой в HTML-разметку Telegram:
// иначе название вида «купить 3<5 литров» ломает разбор сущностей и сообщение не уходит вообще.
export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

export function taskKeyboard(taskId) {
  return {
    inline_keyboard: [[
      { text: '✅ Готово', callback_data: `done:${taskId}` },
      { text: '⏰ Перенести', callback_data: `snooze:${taskId}` },
      { text: '🗑', callback_data: `del:${taskId}` },
    ], [
      { text: '🐊 Даня', callback_data: `as:${taskId}:danya` },
      { text: '🐈‍⬛ Женя', callback_data: `as:${taskId}:zhenya` },
      { text: '👫 Оба', callback_data: `as:${taskId}:both` },
    ], [
      { text: '🤝 Подхватишь?', callback_data: `hf:ask:${taskId}` },
      { text: '✂️ Разбить', callback_data: `zb:split:${taskId}` },
    ]],
  }
}

export function snoozeKeyboard(taskId) {
  return {
    inline_keyboard: [[
      { text: '+15 мин', callback_data: `sn:${taskId}:15` },
      { text: '+1 час', callback_data: `sn:${taskId}:60` },
      { text: 'Вечером', callback_data: `sn:${taskId}:evening` },
      { text: 'Завтра', callback_data: `sn:${taskId}:tomorrow` },
    ]],
  }
}

export function taskCard(task, { tz, nowIso }) {
  const lines = [`📌 <b>${esc(task.title)}</b>`]
  if (task.due_at) {
    lines.push(`🗓 ${formatDateHuman(task.due_at, tz, nowIso)}, ${formatTime(task.due_at, tz)}`)
  } else {
    lines.push('🗓 без срока')
  }
  const rep = repeatLabel(task.repeat_rule)
  if (rep) lines.push(`🔁 ${rep}`)
  lines.push(`${ASSIGNEE_ICON[task.assignee]} ${ASSIGNEE_LABEL[task.assignee]}`)
  return { text: lines.join('\n'), reply_markup: taskKeyboard(task.id) }
}

const byTime = (a, b) => String(a.due_at ?? '').localeCompare(String(b.due_at ?? ''))

function taskLine(task, tz) {
  const time = task.due_at ? `<b>${formatTime(task.due_at, tz)}</b> ` : '· '
  const title = task.status === 'done' ? `<s>${esc(task.title)}</s>` : esc(task.title)
  return `${time}${title} ${ASSIGNEE_ICON[task.assignee]}`
}

export function dayList(tasks, { tz, nowIso, title }) {
  if (!tasks.length) return `📅 <b>${esc(title)}</b>\n\nПока пусто.`
  const sorted = [...tasks].sort(byTime)
  const head = `📅 <b>${esc(title)}</b> — ${plural(sorted.length, 'дело', 'дела', 'дел')}`
  return [head, '', ...sorted.map((t) => taskLine(t, tz))].join('\n')
}

export function weekList(tasks, { tz, nowIso }) {
  if (!tasks.length) return '🗓 <b>Неделя</b>\n\nПусто. Можно выдохнуть.'
  const groups = new Map()
  for (const t of [...tasks].sort(byTime)) {
    const key = t.due_at ? localDateKey(t.due_at, tz) : 'later'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }
  const out = [`🗓 <b>Неделя</b> — ${plural(tasks.length, 'дело', 'дела', 'дел')}`, '']
  for (const [key, items] of groups) {
    const label = key === 'later'
      ? 'Без срока'
      : capitalize(formatDateHuman(items[0].due_at, tz, nowIso))
    out.push(`<b>${esc(label)}</b>`)
    out.push(...items.map((t) => `  ${taskLine(t, tz)}`))
    out.push('')
  }
  return out.join('\n').trim()
}

export function digest(todayTasks, overdueTasks, { tz, nowIso }) {
  if (!todayTasks.length && !overdueTasks.length) {
    return '☀️ Доброе утро!\n\nНа сегодня ничего не запланировано — день свободен.'
  }
  const out = ['☀️ <b>Доброе утро!</b>', '']
  if (overdueTasks.length) {
    out.push(`❗️ <b>Просрочено</b> — ${plural(overdueTasks.length, 'дело', 'дела', 'дел')}`)
    out.push(...[...overdueTasks].sort(byTime).map((t) => `  ${taskLine(t, tz)}`))
    out.push('')
  }
  if (todayTasks.length) {
    out.push(`Сегодня — ${plural(todayTasks.length, 'дело', 'дела', 'дел')}:`)
    out.push(...[...todayTasks].sort(byTime).map((t) => `  ${taskLine(t, tz)}`))
  } else {
    out.push('На сегодня ничего нового.')
  }
  return out.join('\n')
}

export function humanDelta(fromIso, toIso) {
  const mins = Math.max(1, Math.round((new Date(toIso) - new Date(fromIso)) / 60000))
  if (mins < 60) return plural(mins, 'минуту', 'минуты', 'минут')
  if (mins < 1440) return plural(Math.round(mins / 60), 'час', 'часа', 'часов')
  return plural(Math.round(mins / 1440), 'день', 'дня', 'дней')
}

export function reminderText(task, { tz, nowIso, kind }) {
  const who = ASSIGNEE_LABEL[task.assignee]
  const time = task.due_at ? formatTime(task.due_at, tz) : ''
  if (kind === 'pre') {
    const when = task.due_at
      ? `через ${humanDelta(nowIso, task.due_at)}, в ${time}`
      : 'скоро'
    return `🔔 <b>${esc(task.title)}</b>\nНачинается ${when} · ${who}`
  }
  return `⏰ Пора: <b>${esc(task.title)}</b>\n${time} · ${who}`
}
