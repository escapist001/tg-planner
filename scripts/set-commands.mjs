import { readFileSync } from 'node:fs'

const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
const token = process.env.BOT_TOKEN ?? text.match(/^BOT_TOKEN=(.+)$/m)?.[1]?.trim()
if (!token) {
  console.error('BOT_TOKEN не найден')
  process.exit(1)
}

// Telegram принимает только латиницу в именах команд. Русские синонимы бот
// понимает тоже, но в меню и в группах работают эти.
const commands = [
  { command: 'today', description: 'дела на сегодня' },
  { command: 'tomorrow', description: 'дела на завтра' },
  { command: 'week', description: 'расписание на 7 дней' },
  { command: 'mine', description: 'только мои дела' },
  { command: 'all', description: 'дела без срока' },
  { command: 'add', description: 'добавить дело: /add завтра в 15 к врачу' },
  { command: 'settings', description: 'дайджест и напоминания' },
  { command: 'help', description: 'как пользоваться' },
]

const call = async (method, payload) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return res.json()
}

console.log('команды:', JSON.stringify(await call('setMyCommands', { commands })))
console.log('описание:', JSON.stringify(await call('setMyDescription', {
  description: 'Записываю дела человеческим языком и напоминаю о них. Напиши мне с упоминанием: «завтра в 15 к врачу».',
})))
console.log('короткое описание:', JSON.stringify(await call('setMyShortDescription', {
  short_description: 'Планер дел с напоминаниями',
})))
