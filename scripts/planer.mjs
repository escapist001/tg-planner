import { readFileSync } from 'node:fs'

function loadEnv() {
  try {
    const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
      if (m) process.env[m[1]] ??= m[2].trim().replace(/^["']|["']$/g, '')
    }
  } catch {
    // переменные могут прийти из окружения
  }
}

loadEnv()
const base = process.env.WORKER_URL
const token = process.env.API_TOKEN
if (!base || !token) {
  console.error('Нужны WORKER_URL и API_TOKEN в .env.local (см. SETUP.md, Шаг 9)')
  process.exit(1)
}

const call = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  })
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!data.ok) {
    console.error('Ошибка:', data.error)
    process.exit(1)
  }
  return data
}

const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'add') {
  const text = rest.join(' ')
  if (!text.trim()) {
    console.error('Что добавить? npm run add -- "завтра в 15 к врачу"')
    process.exit(1)
  }
  const { task } = await call('/api/tasks', { method: 'POST', body: JSON.stringify({ text }) })
  console.log(`✅ #${task.id} ${task.title} — ${task.due_at ?? 'без срока'} (${task.assignee})`)
} else if (cmd === 'list') {
  const range = rest[0] ?? 'week'
  const { tasks } = await call(`/api/tasks?range=${range}`)
  if (!tasks.length) console.log('Пусто')
  for (const t of tasks) console.log(`#${t.id} ${t.due_at ?? '—'} · ${t.title} · ${t.assignee}`)
} else if (cmd === 'done') {
  if (!rest[0]) {
    console.error('Нужен номер дела: npm run done -- 7')
    process.exit(1)
  }
  await call(`/api/tasks/${rest[0]}/done`, { method: 'POST' })
  console.log('✅ Отметил')
} else {
  console.log('Команды: add "текст" | list [day|tomorrow|week|undated] | done <id>')
}
