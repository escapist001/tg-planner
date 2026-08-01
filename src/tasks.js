import * as db from './db.js'
import * as tg from './telegram.js'
import { parseTask } from './parse/index.js'
import { detectAssignee } from './assignee.js'
import { taskCard } from './format.js'
import { nextOccurrence } from './repeat.js'
import { addMinutes } from './time.js'

// Общая логика создания дела: ей пользуется и бот в чате, и внешнее API.
export async function addTaskFromText(env, {
  chatId, text, authorRole, authorId, nowIso, notify = true, assignee: forced = null,
}) {
  const chat = await db.getChat(env.DB, chatId, {
    tz: env.DEFAULT_TZ,
    digestTime: env.DEFAULT_DIGEST_TIME,
    remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN),
  })

  const detected = detectAssignee(text, authorRole)
  const assignee = forced ?? detected.assignee
  const parsed = await parseTask(env, detected.text, nowIso, chat.tz)
  if (!parsed.title) return { task: null, chat, parsed }

  const task = await db.createTask(env.DB, {
    chat_id: chatId,
    title: parsed.title,
    due_at: parsed.dueAt,
    remind_at: parsed.dueAt ? addMinutes(parsed.dueAt, -chat.remind_before_min) : null,
    assignee,
    created_by: authorId,
    repeat_rule: parsed.repeatRule,
    created_at: nowIso,
  })

  const full = { ...task, assignee, repeat_rule: parsed.repeatRule }

  if (notify && parsed.dueAt) {
    const card = taskCard(full, { tz: chat.tz, nowIso })
    await tg.sendMessage(env, chatId, card.text, { reply_markup: card.reply_markup })
  }

  return { task: full, chat, parsed }
}

// Закрыть дело. У повторяющегося сразу заводим следующий экземпляр,
// иначе оно исчезнет насовсем. Возвращает срок следующего раза или null.
export async function completeTask(env, task, chat, nowIso) {
  await db.markDone(env.DB, task.id)
  if (!task.repeat_rule) return null

  const next = nextOccurrence(task.due_at, task.repeat_rule, chat.tz)
  if (!next) return null

  await db.createTask(env.DB, {
    chat_id: task.chat_id,
    title: task.title,
    due_at: next,
    remind_at: addMinutes(next, -chat.remind_before_min),
    assignee: task.assignee,
    created_by: task.created_by,
    repeat_rule: task.repeat_rule,
    parent_id: task.parent_id ?? task.id,
    created_at: nowIso,
  })
  return next
}
