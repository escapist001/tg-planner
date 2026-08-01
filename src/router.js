import * as db from './db.js'
import * as tg from './telegram.js'
import { addTaskFromText } from './tasks.js'
import { nextOccurrence } from './repeat.js'
import {
  taskCard, dayList, weekList, snoozeKeyboard, taskKeyboard, ASSIGNEE_LABEL, plural,
} from './format.js'
import {
  addDays, addMinutes, startOfLocalDay, localParts, localToUtcIso, formatDateHuman, formatTime,
} from './time.js'

const HELP = `Я веду ваши дела.

<b>Как добавить</b>
Напиши мне с упоминанием: «@BOT завтра в 15 к врачу»
или ответь реплаем на любое моё сообщение.
Понимаю: «через 2 часа», «в пятницу вечером», «5 марта»,
«каждый вторник», «каждое 5-е число», «по будням».

<b>Команды</b>
/день — что сегодня
/завтра — что завтра
/неделя — расписание на 7 дней
/мои — только мои дела
/все — дела без срока
/настройки — время дайджеста и напоминаний

Напомню за 30 минут до срока и в сам момент.`

function chatDefaults(env) {
  return {
    tz: env.DEFAULT_TZ,
    digestTime: env.DEFAULT_DIGEST_TIME,
    remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN),
  }
}

function roleFromName(from) {
  const name = `${from.first_name ?? ''} ${from.username ?? ''}`.toLowerCase()
  if (/жен|zhen|evgen/.test(name)) return 'zhenya'
  return 'danya'
}

function addressedText(msg, env) {
  const text = (msg.text ?? msg.caption ?? '').trim()
  if (!text) return null
  if (text.startsWith('/')) return null

  const mention = new RegExp(`@${env.BOT_USERNAME}(?![0-9A-Za-z_])`, 'i')
  if (mention.test(text)) return text.replace(mention, ' ').trim()

  if (msg.reply_to_message?.from?.is_bot) return text
  if (msg.chat.type === 'private') return text

  return null
}

const COMMANDS = {
  'start': 'start', 'help': 'help', 'помощь': 'help',
  'добавить': 'add', 'add': 'add',
  'день': 'today', 'today': 'today', 'сегодня': 'today',
  'завтра': 'tomorrow', 'tomorrow': 'tomorrow',
  'неделя': 'week', 'week': 'week',
  'мои': 'mine', 'mine': 'mine',
  'все': 'all', 'всё': 'all', 'all': 'all',
  'настройки': 'settings', 'settings': 'settings',
}

function parseCommand(text) {
  if (!text?.startsWith('/')) return null
  const head = text.split(/\s+/)[0]
  const raw = head.slice(1).split('@')[0].toLowerCase()
  const rest = text.slice(head.length).trim()
  return COMMANDS[raw] ? { cmd: COMMANDS[raw], rest } : null
}

export async function handleUpdate(update, env, nowIso) {
  if (update.update_id != null && await db.isDuplicateUpdate(env.DB, update.update_id, nowIso)) return

  if (update.callback_query) return handleCallback(update.callback_query, env, nowIso)
  if (update.message) return handleMessage(update.message, env, nowIso)
}

async function handleMessage(msg, env, nowIso) {
  const chatId = msg.chat.id
  const command = parseCommand(msg.text ?? '')
  const addressed = addressedText(msg, env)
  if (!command && !addressed) return

  const chat = await db.getChat(env.DB, chatId, chatDefaults(env))
  const role = (await db.getUserRole(env.DB, chatId, msg.from.id)) ?? roleFromName(msg.from)
  await db.upsertUser(env.DB, chatId, msg.from.id, msg.from.first_name ?? '', role)

  if (command) return runCommand(command, msg, chat, role, env, nowIso)
  return createFromText(addressed, msg, chat, role, env, nowIso)
}

async function createFromText(text, msg, chat, role, env, nowIso) {
  const { task } = await addTaskFromText(env, {
    chatId: chat.chat_id, text, authorRole: role, authorId: msg.from.id, nowIso,
  })

  if (!task) {
    await tg.sendMessage(env, chat.chat_id, 'Не понял, что за дело. Напиши коротко: что и когда.')
    return
  }

  if (!task.due_at) {
    await tg.sendMessage(env, chat.chat_id, `📌 <b>${task.title}</b>\n\nКогда напомнить?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Сегодня', callback_data: `when:${task.id}:today` },
          { text: 'Завтра', callback_data: `when:${task.id}:tomorrow` },
          { text: 'В выходные', callback_data: `when:${task.id}:weekend` },
          { text: 'Без срока', callback_data: `when:${task.id}:none` },
        ]],
      },
    })
  }
}

async function runCommand({ cmd, rest }, msg, chat, role, env, nowIso) {
  const chatId = chat.chat_id
  const tz = chat.tz

  if (cmd === 'start' || cmd === 'help') {
    await tg.sendMessage(env, chatId, HELP.replace(/@BOT/g, `@${env.BOT_USERNAME}`))
    return
  }

  if (cmd === 'add') {
    if (!rest) {
      await tg.sendMessage(env, chatId, 'Напиши так: /добавить завтра в 15 к врачу')
      return
    }
    return createFromText(rest, msg, chat, role, env, nowIso)
  }

  if (cmd === 'today' || cmd === 'tomorrow') {
    const shift = cmd === 'today' ? 0 : 1
    const from = addDays(startOfLocalDay(nowIso, tz), shift)
    const to = addDays(from, 1)
    const tasks = await db.tasksBetween(env.DB, chatId, from, to)
    const title = cmd === 'today' ? 'Сегодня' : 'Завтра'
    await tg.sendMessage(env, chatId, dayList(tasks, { tz, nowIso, title }))
    return
  }

  if (cmd === 'week') {
    const from = startOfLocalDay(nowIso, tz)
    const to = addDays(from, 7)
    const tasks = await db.tasksBetween(env.DB, chatId, from, to)
    await tg.sendMessage(env, chatId, weekList(tasks, { tz, nowIso }))
    return
  }

  if (cmd === 'mine') {
    const from = startOfLocalDay(nowIso, tz)
    const to = addDays(from, 7)
    const all = await db.tasksBetween(env.DB, chatId, from, to)
    const undated = await db.undatedTasks(env.DB, chatId)
    const mine = [...all, ...undated].filter((t) => t.assignee === role || t.assignee === 'both')
    await tg.sendMessage(env, chatId, dayList(mine, { tz, nowIso, title: `Дела: ${ASSIGNEE_LABEL[role]}` }))
    return
  }

  if (cmd === 'all') {
    const undated = await db.undatedTasks(env.DB, chatId)
    await tg.sendMessage(env, chatId, dayList(undated, { tz, nowIso, title: 'Без срока' }))
    return
  }

  if (cmd === 'settings') {
    const text = '⚙️ <b>Настройки</b>\n\n'
      + `Часовой пояс: ${chat.tz}\n`
      + `Утренний дайджест: ${chat.digest_enabled ? chat.digest_time : 'выключен'}\n`
      + `Напоминание заранее: ${plural(chat.remind_before_min, 'минута', 'минуты', 'минут')}`
    await tg.sendMessage(env, chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Дайджест 8:00', callback_data: 'set:digest:08:00' },
            { text: '10:00', callback_data: 'set:digest:10:00' },
            { text: 'Выключить', callback_data: 'set:digest:off' },
          ],
          [
            { text: 'Напоминать за 15 мин', callback_data: 'set:pre:15' },
            { text: '30', callback_data: 'set:pre:30' },
            { text: '60', callback_data: 'set:pre:60' },
          ],
        ],
      },
    })
  }
}

async function handleCallback(cb, env, nowIso) {
  const chatId = cb.message.chat.id
  const chat = await db.getChat(env.DB, chatId, chatDefaults(env))
  const [action, ...args] = cb.data.split(':')

  if (action === 'set') return handleSettings(cb, chat, args, env, nowIso)

  const taskId = Number(args[0])
  const task = await db.getTask(env.DB, taskId)
  if (!task || task.chat_id !== chatId) {
    await tg.answerCallback(env, cb.id, 'Дело не найдено')
    return
  }

  if (action === 'done') {
    await db.markDone(env.DB, taskId)
    let suffix = '\n\n✅ Готово.'
    if (task.repeat_rule) {
      const next = nextOccurrence(task.due_at, task.repeat_rule, chat.tz)
      if (next) {
        await db.createTask(env.DB, {
          chat_id: chatId, title: task.title, due_at: next,
          remind_at: addMinutes(next, -chat.remind_before_min),
          assignee: task.assignee, created_by: task.created_by,
          repeat_rule: task.repeat_rule, parent_id: task.parent_id ?? task.id,
          created_at: nowIso,
        })
        suffix = `\n\n✅ Готово. Следующий раз — ${formatDateHuman(next, chat.tz, nowIso)}.`
      }
    }
    await tg.editMessageText(env, chatId, cb.message.message_id,
      `<s>${task.title}</s>${suffix}`, { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id, 'Отметил')
    return
  }

  if (action === 'del') {
    await db.updateTask(env.DB, taskId, { status: 'cancelled' })
    await tg.editMessageText(env, chatId, cb.message.message_id,
      `<s>${task.title}</s>\n\n🗑 Удалено.`, { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id, 'Удалил')
    return
  }

  if (action === 'snooze') {
    await tg.editMessageText(env, chatId, cb.message.message_id,
      `📌 <b>${task.title}</b>\n\nНа когда перенести?`,
      { reply_markup: snoozeKeyboard(taskId) })
    await tg.answerCallback(env, cb.id)
    return
  }

  if (action === 'sn') {
    const mode = args[1]
    const base = task.due_at ?? nowIso
    let due
    if (mode === 'evening') {
      const p = localParts(nowIso, chat.tz)
      due = localToUtcIso({ year: p.year, month: p.month, day: p.day, hour: 19, minute: 0 }, chat.tz)
      if (new Date(due) <= new Date(nowIso)) due = addDays(due, 1)
    } else if (mode === 'tomorrow') {
      const p = localParts(addDays(startOfLocalDay(nowIso, chat.tz), 1), chat.tz)
      const src = task.due_at ? localParts(task.due_at, chat.tz) : { hour: 9, minute: 0 }
      due = localToUtcIso({ year: p.year, month: p.month, day: p.day, hour: src.hour, minute: src.minute }, chat.tz)
    } else {
      due = addMinutes(base, Number(mode))
    }
    await db.updateTask(env.DB, taskId, {
      due_at: due,
      remind_at: addMinutes(due, -chat.remind_before_min),
      notified_pre: 0,
      notified_due: 0,
    })
    const card = taskCard({ ...task, due_at: due }, { tz: chat.tz, nowIso })
    await tg.editMessageText(env, chatId, cb.message.message_id, card.text,
      { reply_markup: card.reply_markup })
    await tg.answerCallback(env, cb.id, `Перенёс на ${formatTime(due, chat.tz)}`)
    return
  }

  if (action === 'as') {
    const role = args[1]
    await db.updateTask(env.DB, taskId, { assignee: role })
    const card = taskCard({ ...task, assignee: role }, { tz: chat.tz, nowIso })
    await tg.editMessageText(env, chatId, cb.message.message_id, card.text,
      { reply_markup: card.reply_markup })
    await tg.answerCallback(env, cb.id, `Теперь на ${ASSIGNEE_LABEL[role]}`)
    return
  }

  if (action === 'when') {
    const mode = args[1]
    if (mode === 'none') {
      await tg.editMessageText(env, chatId, cb.message.message_id,
        `📌 <b>${task.title}</b>\n🗓 без срока`, { reply_markup: taskKeyboard(taskId) })
      await tg.answerCallback(env, cb.id, 'Оставил без срока')
      return
    }
    const p0 = localParts(nowIso, chat.tz)
    let due
    if (mode === 'today') {
      due = localToUtcIso({ year: p0.year, month: p0.month, day: p0.day, hour: 19, minute: 0 }, chat.tz)
      if (new Date(due) <= new Date(nowIso)) due = addMinutes(nowIso, 60)
    } else if (mode === 'tomorrow') {
      const p = localParts(addDays(startOfLocalDay(nowIso, chat.tz), 1), chat.tz)
      due = localToUtcIso({ year: p.year, month: p.month, day: p.day, hour: 9, minute: 0 }, chat.tz)
    } else {
      const shift = (6 - p0.weekday + 7) % 7 || 7
      const p = localParts(addDays(startOfLocalDay(nowIso, chat.tz), shift), chat.tz)
      due = localToUtcIso({ year: p.year, month: p.month, day: p.day, hour: 12, minute: 0 }, chat.tz)
    }
    await db.updateTask(env.DB, taskId, {
      due_at: due, remind_at: addMinutes(due, -chat.remind_before_min),
    })
    const card = taskCard({ ...task, due_at: due }, { tz: chat.tz, nowIso })
    await tg.editMessageText(env, chatId, cb.message.message_id, card.text,
      { reply_markup: card.reply_markup })
    await tg.answerCallback(env, cb.id, 'Записал')
  }
}

async function handleSettings(cb, chat, args, env, nowIso) {
  const [kind, ...value] = args
  if (kind === 'digest') {
    if (value[0] === 'off') {
      await db.setChatSetting(env.DB, chat.chat_id, 'digest_enabled', 0)
      await tg.answerCallback(env, cb.id, 'Дайджест выключен')
    } else {
      await db.setChatSetting(env.DB, chat.chat_id, 'digest_enabled', 1)
      await db.setChatSetting(env.DB, chat.chat_id, 'digest_time', value.join(':'))
      await tg.answerCallback(env, cb.id, `Дайджест в ${value.join(':')}`)
    }
    return
  }
  if (kind === 'pre') {
    await db.setChatSetting(env.DB, chat.chat_id, 'remind_before_min', Number(value[0]))
    await tg.answerCallback(env, cb.id, `Напомню за ${value[0]} мин`)
  }
}
