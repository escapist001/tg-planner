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
