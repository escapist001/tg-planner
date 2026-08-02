const API = 'https://api.telegram.org/bot'

export async function tg(env, method, payload) {
  const res = await fetch(`${API}${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await res.json()
  if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`)
  return data.result
}

export const sendMessage = (env, chatId, text, extra = {}) =>
  tg(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra })

export const editMessageText = (env, chatId, messageId, text, extra = {}) =>
  tg(env, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra })

export const answerCallback = (env, callbackId, text = '') =>
  tg(env, 'answerCallbackQuery', { callback_query_id: callbackId, text })

export const pinMessage = (env, chatId, messageId) =>
  tg(env, 'pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true })

export const sendPoll = (env, chatId, question, options, extra = {}) =>
  tg(env, 'sendPoll', { chat_id: chatId, question, options, is_anonymous: false, ...extra })

// Реакция на сообщение — тихое подтверждение, что бот дело принял.
export const setReaction = (env, chatId, messageId, emoji) =>
  tg(env, 'setMessageReaction', {
    chat_id: chatId, message_id: messageId, reaction: [{ type: 'emoji', emoji }],
  })

// Файлы Telegram принимает только как multipart, поэтому здесь свой запрос вместо общего tg().
export async function sendDocument(env, chatId, { filename, content, caption, mime = 'text/html' }) {
  const form = new FormData()
  form.append('chat_id', String(chatId))
  if (caption) {
    form.append('caption', caption)
    form.append('parse_mode', 'HTML')
  }
  form.append('document', new Blob([content], { type: mime }), filename)

  const res = await fetch(`${API}${env.BOT_TOKEN}/sendDocument`, { method: 'POST', body: form })
  const data = await res.json()
  if (!data.ok) throw new Error(`Telegram sendDocument: ${data.description}`)
  return data.result
}
