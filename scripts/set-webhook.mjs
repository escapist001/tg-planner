const token = process.env.BOT_TOKEN
const secret = process.env.WEBHOOK_SECRET
const url = process.env.WORKER_URL

if (!token || !secret || !url) {
  console.error('Нужны переменные BOT_TOKEN, WEBHOOK_SECRET, WORKER_URL')
  process.exit(1)
}

const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: `${url}/tg`,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  }),
})
console.log(await res.json())
