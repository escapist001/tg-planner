// Единая точка подключения фич к роутеру. Роутер знает только про handleFeatureCallback
// и пару хуков — вся начинка живёт в модулях рядом.
import * as db from '../db.js'
import * as tg from '../telegram.js'
import * as wedding from './wedding.js'
import * as zombie from './zombie.js'
import * as content from './content.js'
import * as teamwork from './teamwork.js'
import * as rituals from './rituals.js'
import * as pets from './pets.js'
import { taskCard } from '../format.js'
import { addMinutes } from '../time.js'

const PREFIXES = ['wb', 'ck', 'zb', 'ct', 'hf', 'tw', 'rt', 'pt']

export function isFeatureCallback(data) {
  return PREFIXES.includes(String(data ?? '').split(':')[0])
}

// Возвращает true, если callback обработан здесь и роутеру делать нечего.
export async function handleFeatureCallback(cb, env, nowIso, ctx) {
  const [prefix, action, ...rest] = String(cb.data).split(':')
  const { chat } = ctx
  const chatId = chat.chat_id

  if (prefix === 'wb') {
    await wedding.refreshWeddingBoard(env, chatId, nowIso)
    await tg.answerCallback(env, cb.id, 'Обновил')
    return true
  }

  if (prefix === 'ck') {
    const res = await wedding.checkupStep(env, chatId, nowIso, cb.data)
    await tg.answerCallback(env, cb.id, res.done ? 'Прогон закончен' : 'Дальше')
    return true
  }

  if (prefix === 'zb') return handleZombie(cb, env, nowIso, ctx, action, rest)
  if (prefix === 'ct') return handleContent(cb, env, nowIso, ctx, action, rest)
  if (prefix === 'hf') return handleHandoff(cb, env, nowIso, ctx, action, rest)
  if (prefix === 'tw') return handleBalance(cb, env, nowIso, ctx, action, rest)
  if (prefix === 'rt') return handleRituals(cb, env, nowIso, ctx, action, rest)
  if (prefix === 'pt') return handlePets(cb, env, nowIso, ctx, action, rest)

  return false
}

async function handleRituals(cb, env, nowIso, ctx, action, rest) {
  const { chat } = ctx
  const chatId = chat.chat_id

  if (action === 'spread') {
    await tg.answerCallback(env, cb.id, 'Раскидываю…')
    const result = await rituals.spreadLeftovers(env, chatId, nowIso, chat.tz)
    await tg.editMessageText(env, chatId, cb.message.message_id,
      rituals.spreadSummaryText(result, { tz: chat.tz, nowIso }),
      { reply_markup: { inline_keyboard: [] } })
    return true
  }

  if (action === 'date') {
    await rituals.dateNightPoll(env, chatId)
    await tg.answerCallback(env, cb.id, 'Выбирайте вечер')
    return true
  }

  if (action === 'prep') {
    const task = await db.getTask(env.DB, Number(rest[0]))
    if (!task || task.chat_id !== chatId) {
      await tg.answerCallback(env, cb.id, 'Дело не найдено')
      return true
    }
    return handleZombie({ ...cb, data: `zb:split:${task.id}` }, env, nowIso, ctx, 'split', [task.id])
  }

  if (action === 'unload') {
    await tg.answerCallback(env, cb.id, 'Смотрю…')
    const { tasks } = await teamwork.weeklyBalance(env, chatId, nowIso)
    const suggestions = await teamwork.suggestRebalance(env, tasks, { tz: chat.tz, nowIso })
    if (!suggestions.length) {
      await tg.sendMessage(env, chatId, 'Разгружать особо нечего, день терпимый.')
      return true
    }
    const preview = teamwork.rebalancePreview(suggestions, { tz: chat.tz, nowIso })
    await tg.sendMessage(env, chatId, preview.text, { reply_markup: preview.reply_markup })
    return true
  }

  return false
}

async function handlePets(cb, env, nowIso, ctx, action, rest) {
  const { chat } = ctx
  const chatId = chat.chat_id

  if (action === 'take') {
    const parsed = pets.parseDutyCallback(cb.data)
    if (!parsed) {
      await tg.answerCallback(env, cb.id, 'Не понял кнопку')
      return true
    }
    const task = await db.getTask(env.DB, parsed.taskId)
    if (!task || task.chat_id !== chatId) {
      await tg.answerCallback(env, cb.id, 'Дело не найдено')
      return true
    }
    const { next } = await pets.claimDuty(env, task, parsed.who, nowIso)
    await tg.editMessageText(env, chatId, cb.message.message_id,
      pets.dutyClaimedText(task, parsed.who, next, { tz: chat.tz, nowIso }),
      { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id, 'Записал')
    return true
  }

  return false
}

async function handleHandoff(cb, env, nowIso, ctx, action, rest) {
  const { chat } = ctx
  const chatId = chat.chat_id
  const task = await db.getTask(env.DB, Number(rest[0]))
  if (!task || task.chat_id !== chatId) {
    await tg.answerCallback(env, cb.id, 'Дело не найдено')
    return true
  }

  if (action === 'ask') {
    const partner = task.assignee === 'danya' ? 'zhenya' : 'danya'
    const dayTasks = await db.tasksOfDay(env.DB, chatId,
      task.due_at ?? nowIso, addMinutes(task.due_at ?? nowIso, 60 * 24))
    const theirs = dayTasks.filter((t) => t.assignee === partner || t.assignee === 'both')
    const window = teamwork.findFreeWindow(theirs, task.due_at ?? nowIso, chat.tz)
    const req = teamwork.handoffRequest(task, window,
      { tz: chat.tz, nowIso, partnerTasks: theirs.length })
    await tg.sendMessage(env, chatId, req.text, { reply_markup: req.reply_markup })
    await tg.answerCallback(env, cb.id, 'Спросил')
    return true
  }

  if (action === 'take') {
    const who = cb.from?.id ? await db.getUserRole(env.DB, chatId, cb.from.id) : null
    const target = who ?? (task.assignee === 'danya' ? 'zhenya' : 'danya')
    const res = await teamwork.acceptHandoff(env, task, target, nowIso)
    await tg.editMessageText(env, chatId, cb.message.message_id, res.text,
      { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id, 'Записал на тебя')
    return true
  }

  if (action === 'pass') {
    const res = await teamwork.declineHandoff(env, task, nowIso)
    await tg.editMessageText(env, chatId, cb.message.message_id, res.text,
      { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id, 'Понял')
    return true
  }

  return false
}

async function handleBalance(cb, env, nowIso, ctx, action, rest) {
  const { chat } = ctx
  const chatId = chat.chat_id

  if (action === 'balance') {
    await tg.answerCallback(env, cb.id, 'Смотрю…')
    const { tasks } = await teamwork.weeklyBalance(env, chatId, nowIso)
    const suggestions = await teamwork.suggestRebalance(env, tasks, { tz: chat.tz, nowIso })
    if (!suggestions.length) {
      await tg.sendMessage(env, chatId, 'Неделя и так ровная, перекладывать нечего.')
      return true
    }
    const preview = teamwork.rebalancePreview(suggestions, { tz: chat.tz, nowIso })
    await tg.sendMessage(env, chatId, preview.text, { reply_markup: preview.reply_markup })
    return true
  }

  if (action === 'apply') {
    const task = await db.getTask(env.DB, Number(rest[0]))
    if (!task || task.chat_id !== chatId) {
      await tg.answerCallback(env, cb.id, 'Дело не найдено')
      return true
    }
    const res = await teamwork.applyRebalance(env, task, rest[1], nowIso)
    await tg.answerCallback(env, cb.id, res.ok ? 'Переложил' : 'Не вышло')
    if (res.ok) await tg.sendMessage(env, chatId, res.text)
    return true
  }

  if (action === 'keep') {
    await tg.editMessageText(env, chatId, cb.message.message_id, 'Хорошо, оставляем как есть.',
      { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id)
    return true
  }

  return false
}

async function handleZombie(cb, env, nowIso, ctx, action, rest) {
  const { chat } = ctx
  const chatId = chat.chat_id
  const taskId = Number(rest[0])
  const task = await db.getTask(env.DB, taskId)
  if (!task || task.chat_id !== chatId) {
    await tg.answerCallback(env, cb.id, 'Дело не найдено')
    return true
  }

  if (action === 'split') {
    await tg.answerCallback(env, cb.id, 'Думаю…')
    const steps = await zombie.splitTask(env, task, nowIso, chat.tz)
    if (!steps) {
      await tg.sendMessage(env, chatId, 'Не смог разложить это дело на шаги. Попробуй описать его подробнее.')
      return true
    }
    await zombie.saveSplitDraft(env, chatId, taskId, steps)
    const preview = zombie.splitPreview(task, steps, { tz: chat.tz, nowIso })
    await tg.sendMessage(env, chatId, preview.text, { reply_markup: preview.reply_markup })
    return true
  }

  if (action === 'apply') {
    const steps = await zombie.loadSplitDraft(env, chatId, taskId)
    if (!steps) {
      await tg.answerCallback(env, cb.id, 'Черновик уже применён')
      return true
    }
    const created = await zombie.applySplit(env, task, steps, nowIso)
    await tg.editMessageText(env, chatId, cb.message.message_id,
      zombie.splitDoneText(task, created), { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id, 'Завёл')
    return true
  }

  if (action === 'cancel') {
    await zombie.clearSplitDraft(env, chatId, taskId)
    await tg.editMessageText(env, chatId, cb.message.message_id, 'Оставил как было.',
      { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id)
    return true
  }

  if (action === 'hard') {
    await zombie.markHardDay(env, taskId)
    await tg.answerCallback(env, cb.id, 'Теперь это жёсткий день')
    const card = taskCard({ ...task, hard_day: 1 }, { tz: chat.tz, nowIso })
    await tg.editMessageText(env, chatId, cb.message.message_id,
      `${card.text}\n\n📌 Жёсткий день: перенести можно только на завтра.`,
      { reply_markup: card.reply_markup })
    return true
  }

  if (action === 'give') {
    const other = task.assignee === 'danya' ? 'zhenya' : 'danya'
    await db.updateTask(env.DB, taskId, { assignee: other, handoff_from: task.assignee })
    const card = taskCard({ ...task, assignee: other }, { tz: chat.tz, nowIso })
    await tg.editMessageText(env, chatId, cb.message.message_id, card.text,
      { reply_markup: card.reply_markup })
    await tg.answerCallback(env, cb.id, 'Передал')
    return true
  }

  if (action === 'drop') {
    await db.updateTask(env.DB, taskId, { status: 'cancelled' })
    await tg.editMessageText(env, chatId, cb.message.message_id,
      `<s>${task.title}</s>\n\nПохоронено честно. Так тоже можно.`,
      { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id, 'Убрал')
    return true
  }

  return false
}

async function handleContent(cb, env, nowIso, ctx, action, rest) {
  const { chat, role } = ctx
  const chatId = chat.chat_id
  const key = rest[0]

  if (action === 'cancel') {
    await content.dropDraft(env, chatId, key)
    await tg.editMessageText(env, chatId, cb.message.message_id, 'Хорошо, ничего не завожу.',
      { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id)
    return true
  }

  const draft = await content.loadDraft(env, chatId, key)
  if (!draft) {
    await tg.answerCallback(env, cb.id, 'Черновик уже не актуален')
    return true
  }

  if (action === 'dumpone') {
    const index = Number(rest[1])
    const item = draft.items?.[index]
    if (!item) {
      await tg.answerCallback(env, cb.id, 'Такого пункта нет')
      return true
    }
    await content.applyDraft(env, chatId, [item], nowIso, role ?? 'zhenya')
    await tg.answerCallback(env, cb.id, 'Завёл одно')
    return true
  }

  const items = draft.items ?? draft.steps ?? []
  const created = await content.applyDraft(env, chatId, items, nowIso, role ?? 'zhenya')
  await content.dropDraft(env, chatId, key)
  await tg.editMessageText(env, chatId, cb.message.message_id,
    `✅ Завёл ${created.length} — можно посмотреть в /week.`,
    { reply_markup: { inline_keyboard: [] } })
  await tg.answerCallback(env, cb.id, 'Готово')
  return true
}

// Хук на входящий текст: распознаёт интеграции и длинные свалки дел.
// Возвращает true, если сообщение обработано здесь.
export async function handleFeatureText(text, env, nowIso, ctx) {
  const { chat, role } = ctx
  const chatId = chat.chat_id

  if (content.looksLikeIntegration(text)) {
    const parsed = await content.parseIntegration(env, text, nowIso, chat.tz)
    if (parsed?.brand && parsed?.deadline) {
      const steps = content.buildIntegrationChain(parsed.brand, parsed.deadline, chat.tz, nowIso)
      if (steps.length) {
        const key = await content.saveDraft(env, chatId, { steps }, nowIso)
        const preview = content.chainPreview(parsed.brand, steps, { tz: chat.tz, nowIso, key })
        await tg.sendMessage(env, chatId, preview.text, { reply_markup: preview.reply_markup })
        return true
      }
    }
  }

  if (looksLikeDump(text)) {
    const items = await content.dumpToTasks(env, text, nowIso, chat.tz, role ?? 'zhenya')
    if (items?.length) {
      const key = await content.saveDraft(env, chatId, { items }, nowIso)
      const preview = content.dumpPreview(items, { tz: chat.tz, nowIso, key })
      await tg.sendMessage(env, chatId, preview.text, { reply_markup: preview.reply_markup })
      return true
    }
  }

  return false
}

// Длинное сообщение или несколько строк — скорее всего, там сразу пачка дел.
export function looksLikeDump(text) {
  const t = String(text ?? '').trim()
  if (t.length > 180) return true
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length >= 3) return true
  const separators = (t.match(/(?<![\p{L}\p{N}])(и|ещё|еще|потом|а также|также|надо|нужно)(?![\p{L}\p{N}])/giu) ?? []).length
  return separators >= 3 && t.length > 60
}

export { wedding, zombie, content, teamwork, rituals, pets }
