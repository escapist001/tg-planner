// Картинки без картинок: моноширинная псевдографика, которую Telegram показывает
// одинаково на всех клиентах и которую не надо растеризовать в Worker.
import { localParts, localDateKey, startOfLocalDay, addDays, formatTime } from './time.js'
import { plural, ASSIGNEE_LABEL } from './format.js'

const FULL = '█'
const EMPTY = '░'
const ICON = { danya: '🐊', zhenya: '🐈‍⬛', both: '👫' }
const WEEKDAY_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

export function progressBar(done, total, width = 12) {
  if (!total) return EMPTY.repeat(width)
  const filled = Math.round((done / total) * width)
  return FULL.repeat(filled) + EMPTY.repeat(width - filled)
}

export function daysUntil(targetIso, nowIso, tz) {
  const from = new Date(startOfLocalDay(nowIso, tz))
  const to = new Date(startOfLocalDay(targetIso, tz))
  return Math.round((to - from) / 86400000)
}

// Штаб события: отсчёт, полоса прогресса, ближайшие дедлайны.
export function eventBoard({ title, targetIso, tasks, nowIso, tz, emoji = '💍' }) {
  const left = daysUntil(targetIso, nowIso, tz)
  const done = tasks.filter((t) => t.status === 'done').length
  const total = tasks.length
  const open = tasks.filter((t) => t.status === 'open' && t.due_at).sort((a, b) => a.due_at.localeCompare(b.due_at))

  const head = left > 0
    ? `${emoji} <b>${title}</b> — через ${plural(left, 'день', 'дня', 'дней')}`
    : left === 0 ? `${emoji} <b>${title}</b> — сегодня!` : `${emoji} <b>${title}</b>`

  const lines = [head, '']
  lines.push(`<code>${progressBar(done, total)}</code>  ${done} из ${total}`)

  if (open.length) {
    lines.push('')
    lines.push('<b>Ближайшее:</b>')
    for (const t of open.slice(0, 3)) {
      const day = localParts(t.due_at, tz)
      lines.push(`· ${String(day.day).padStart(2, '0')}.${String(day.month).padStart(2, '0')} ${formatTime(t.due_at, tz)} — ${t.title} ${ICON[t.assignee] ?? ''}`)
    }
  }

  const rest = total - done
  if (!rest && total) {
    lines.push('')
    lines.push('Всё закрыто. Можно выдохнуть.')
  }
  return lines.join('\n')
}

// Карта недели: по дню на строку, дела точками, плотность видно сразу.
export function weekMap(tasks, { tz, nowIso }) {
  const start = startOfLocalDay(nowIso, tz)
  const days = []
  for (let i = 0; i < 7; i++) {
    const dayIso = addDays(start, i)
    const key = localDateKey(dayIso, tz)
    const p = localParts(dayIso, tz)
    const items = tasks.filter((t) => t.due_at && localDateKey(t.due_at, tz) === key)
    days.push({ key, p, items })
  }

  const max = Math.max(1, ...days.map((d) => d.items.length))
  const lines = ['🗓 <b>Неделя целиком</b>', '', '<pre>']

  for (const d of days) {
    const label = `${WEEKDAY_SHORT[d.p.weekday]} ${String(d.p.day).padStart(2, '0')}.${String(d.p.month).padStart(2, '0')}`
    const bar = d.items.length
      ? FULL.repeat(Math.max(1, Math.round((d.items.length / max) * 10)))
      : '·'
    const count = d.items.length ? String(d.items.length).padStart(2, ' ') : ' —'
    lines.push(`${label}  ${count} ${bar}`)
  }
  lines.push('</pre>')

  const busiest = [...days].sort((a, b) => b.items.length - a.items.length)[0]
  const free = days.filter((d) => !d.items.length).map((d) => WEEKDAY_SHORT[d.p.weekday])
  if (busiest.items.length > 3) {
    lines.push(`Плотнее всего ${WEEKDAY_SHORT[busiest.p.weekday]} — ${plural(busiest.items.length, 'дело', 'дела', 'дел')}.`)
  }
  if (free.length) lines.push(`Свободно: ${free.join(', ')}.`)

  return lines.join('\n')
}

// Две колонки: у кого сколько дел по дням недели. Перекос видно с одного взгляда.
export function balanceMap(tasks, { tz, nowIso }) {
  const start = startOfLocalDay(nowIso, tz)
  const rows = []

  for (let i = 0; i < 7; i++) {
    const key = localDateKey(addDays(start, i), tz)
    const p = localParts(addDays(start, i), tz)
    const forWho = (who) => tasks.filter((t) => t.due_at
      && localDateKey(t.due_at, tz) === key
      && (t.assignee === who || t.assignee === 'both')).length
    rows.push({ label: WEEKDAY_SHORT[p.weekday], d: forWho('danya'), z: forWho('zhenya') })
  }

  const lines = ['⚖️ <b>Весы недели</b>', '', '<pre>', '     🐊 Даня   🐈‍⬛ Женя']
  for (const r of rows) {
    const left = FULL.repeat(Math.min(r.d, 8)).padStart(8, ' ')
    const right = FULL.repeat(Math.min(r.z, 8)).padEnd(8, ' ')
    lines.push(`${r.label}  ${left} │ ${right}`)
  }
  lines.push('</pre>')

  const totalD = rows.reduce((s, r) => s + r.d, 0)
  const totalZ = rows.reduce((s, r) => s + r.z, 0)
  lines.push(`За неделю: 🐊 ${plural(totalD, 'дело', 'дела', 'дел')} · 🐈‍⬛ ${plural(totalZ, 'дело', 'дела', 'дел')}`)

  const skew = rows.filter((r) => Math.abs(r.d - r.z) >= 3)
  if (skew.length) {
    lines.push('')
    lines.push(`Перекос: ${skew.map((r) => `${r.label} (${r.d} против ${r.z})`).join(', ')}`)
  }
  return lines.join('\n')
}

// Строка про полосу без просрочек. Без салютов, просто факт.
export function streakLine(days, best) {
  if (!days) return null
  if (days === 1) return '✨ День без единой просрочки. Начало положено.'
  const tail = best && best > days ? ` (рекорд — ${plural(best, 'день', 'дня', 'дней')})` : ''
  return `✨ ${plural(days, 'день', 'дня', 'дней')} без единой просрочки${tail}.`
}

// Месячная карточка-открытка. HTML-файл: открывается в браузере, красиво пересылается.
export function monthCardHtml({ month, done, total, streakBest, byWho, handoffs, walks }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${month} — итоги</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0d1117; color: #e6edf3;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    padding: 24px;
  }
  .card {
    width: min(560px, 100%); background: linear-gradient(160deg, #161b22, #0d1117);
    border: 1px solid #30363d; border-radius: 20px; padding: 40px 36px;
    box-shadow: 0 24px 60px rgba(0,0,0,.5);
  }
  .eyebrow { font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: #7d8590; }
  h1 { margin: 8px 0 28px; font-size: 40px; line-height: 1.05; font-weight: 800; }
  .big { font-size: 68px; font-weight: 800; line-height: 1; letter-spacing: -.03em;
         background: linear-gradient(135deg, #7ee787, #58a6ff); -webkit-background-clip: text;
         background-clip: text; color: transparent; }
  .sub { color: #7d8590; margin-top: 6px; font-size: 15px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 32px; }
  .tile { background: #0d1117; border: 1px solid #21262d; border-radius: 14px; padding: 16px 18px; }
  .tile .k { font-size: 12px; color: #7d8590; text-transform: uppercase; letter-spacing: .1em; }
  .tile .v { font-size: 26px; font-weight: 700; margin-top: 4px; }
  .bar { height: 10px; border-radius: 999px; background: #21262d; overflow: hidden; margin-top: 20px; }
  .bar i { display: block; height: 100%; width: ${pct}%;
           background: linear-gradient(90deg, #7ee787, #58a6ff); }
  footer { margin-top: 28px; color: #7d8590; font-size: 13px; display: flex; justify-content: space-between; }
</style></head>
<body><div class="card">
  <div class="eyebrow">Итоги месяца</div>
  <h1>${month}</h1>
  <div class="big">${done} из ${total}</div>
  <div class="sub">дел закрыто — это ${pct}%</div>
  <div class="bar"><i></i></div>
  <div class="grid">
    <div class="tile"><div class="k">Лучшая полоса</div><div class="v">${streakBest} дн.</div></div>
    <div class="tile"><div class="k">Подхватов</div><div class="v">${handoffs}</div></div>
    <div class="tile"><div class="k">🐊 Даня</div><div class="v">${byWho.danya}</div></div>
    <div class="tile"><div class="k">🐈‍⬛ Женя</div><div class="v">${byWho.zhenya}</div></div>
  </div>
  <footer><span>Прогулок с Радой: ${walks}</span><span>🐊 ❤️ 🐈‍⬛</span></footer>
</div></body></html>`
}

export { ICON as ASSIGNEE_ICONS, ASSIGNEE_LABEL }
