import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as db from '../src/db.js'
import * as tg from '../src/telegram.js'
import {
  renderWeddingBoard, refreshWeddingBoard, weddingBoardKeyboard,
  startCheckup, checkupStep, checklistText, WEDDING_DAY_CHECKLIST,
  isQuietDay, renderTimeline, timelineTick, finishWeddingDay,
} from '../src/features/wedding.js'

const env = { BOT_TOKEN: 't', DB: {}, DEFAULT_TZ: 'Europe/Moscow', DEFAULT_DIGEST_TIME: '10:00', DEFAULT_REMIND_BEFORE_MIN: '30' }
const CHAT = -1001
const NOW = '2026-08-02T09:00:00Z' // 12:00 МСК, 2 августа

const chat = {
  chat_id: CHAT, tz: 'Europe/Moscow', digest_time: '10:00',
  digest_enabled: 1, remind_before_min: 30, last_digest_date: null,
}

const task = (over = {}) => ({
  id: 1, chat_id: CHAT, title: 'Ведущий', due_at: '2026-08-10T11:00:00Z',
  assignee: 'both', status: 'open', confirmed: 0, created_by: 7, tag: 'wedding', ...over,
})

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(db, 'getChat').mockResolvedValue(chat)
  vi.spyOn(db, 'getFlag').mockResolvedValue(null)
  vi.spyOn(db, 'setFlag').mockResolvedValue()
  vi.spyOn(db, 'deleteFlag').mockResolvedValue()
  vi.spyOn(db, 'tasksByTag').mockResolvedValue([])
  vi.spyOn(db, 'getTask').mockResolvedValue(null)
  vi.spyOn(db, 'updateTask').mockResolvedValue()
  vi.spyOn(db, 'createTask').mockResolvedValue({ id: 99 })
  vi.spyOn(db, 'getPinned').mockResolvedValue(null)
  vi.spyOn(db, 'setPinned').mockResolvedValue()
  vi.spyOn(db, 'tasksOfDay').mockResolvedValue([])
  vi.spyOn(db, 'timelineForChat').mockResolvedValue([])
  vi.spyOn(db, 'timelineDue').mockResolvedValue([])
  vi.spyOn(db, 'markTimelineNotified').mockResolvedValue()
  vi.spyOn(tg, 'sendMessage').mockResolvedValue({ message_id: 555 })
  vi.spyOn(tg, 'editMessageText').mockResolvedValue({})
  vi.spyOn(tg, 'pinMessage').mockResolvedValue({})
})

describe('штаб «15 августа»', () => {
  it('считает отсчёт от даты из флага и прогресс по делам', async () => {
    vi.spyOn(db, 'getFlag').mockResolvedValue('2026-08-15')
    vi.spyOn(db, 'tasksByTag').mockResolvedValue([
      task({ id: 1, status: 'done' }),
      task({ id: 2, status: 'done', title: 'Кольца' }),
      task({ id: 3, title: 'Флорист', due_at: '2026-08-06T09:00:00Z' }),
      task({ id: 4, title: 'Торт', due_at: '2026-08-08T09:00:00Z' }),
    ])
    const text = await renderWeddingBoard(env, CHAT, NOW)
    expect(text).toContain('через 13 дней')
    expect(text).toContain('2 из 4')
    expect(text).toContain('Флорист')
    expect(db.tasksByTag).toHaveBeenCalledWith(env.DB, CHAT, 'wedding')
  })

  it('без флага берёт дату свадьбы по умолчанию', async () => {
    const text = await renderWeddingBoard(env, CHAT, NOW)
    expect(text).toContain('через 13 дней')
  })

  it('экранирует названия дел', async () => {
    vi.spyOn(db, 'tasksByTag').mockResolvedValue([
      task({ id: 1, title: 'Свет <b>&</b> звук', due_at: '2026-08-06T09:00:00Z' }),
    ])
    const text = await renderWeddingBoard(env, CHAT, NOW)
    expect(text).toContain('Свет &lt;b&gt;&amp;&lt;/b&gt; звук')
    expect(text).not.toContain('Свет <b>&</b>')
  })

  it('отдельной строкой показывает дела без срока и то, что горит сегодня', async () => {
    vi.spyOn(db, 'tasksByTag').mockResolvedValue([
      task({ id: 1, due_at: null, title: 'Список гостей' }),
      task({ id: 2, due_at: '2026-08-02T15:00:00Z', title: 'Примерка' }),
    ])
    const text = await renderWeddingBoard(env, CHAT, NOW)
    expect(text).toContain('1 дело')
    expect(text).toContain('Сегодня горит: Примерка')
  })

  it('первый раз шлёт, закрепляет и запоминает id', async () => {
    const res = await refreshWeddingBoard(env, CHAT, NOW)
    expect(tg.sendMessage).toHaveBeenCalledTimes(1)
    expect(tg.pinMessage).toHaveBeenCalledWith(env, CHAT, 555)
    expect(db.setPinned).toHaveBeenCalledWith(env.DB, CHAT, 'wedding', 555)
    expect(res).toMatchObject({ messageId: 555, created: true })
  })

  it('дальше редактирует закреплённое сообщение', async () => {
    vi.spyOn(db, 'getPinned').mockResolvedValue(777)
    const res = await refreshWeddingBoard(env, CHAT, NOW)
    expect(tg.editMessageText).toHaveBeenCalledTimes(1)
    expect(tg.editMessageText.mock.calls[0][2]).toBe(777)
    expect(tg.sendMessage).not.toHaveBeenCalled()
    expect(res.created).toBe(false)
  })

  it('если закреп удалили — шлёт заново и перезакрепляет', async () => {
    vi.spyOn(db, 'getPinned').mockResolvedValue(777)
    vi.spyOn(tg, 'editMessageText').mockRejectedValue(new Error('message to edit not found'))
    const res = await refreshWeddingBoard(env, CHAT, NOW)
    expect(tg.sendMessage).toHaveBeenCalledTimes(1)
    expect(tg.pinMessage).toHaveBeenCalledWith(env, CHAT, 555)
    expect(db.setPinned).toHaveBeenCalledWith(env.DB, CHAT, 'wedding', 555)
    expect(res.created).toBe(true)
  })

  it('под штабом висит кнопка обновления', async () => {
    await refreshWeddingBoard(env, CHAT, NOW)
    const markup = tg.sendMessage.mock.calls[0][3].reply_markup
    expect(markup).toEqual(weddingBoardKeyboard())
    expect(JSON.stringify(markup)).toContain('wb:refresh')
  })
})

describe('прогон', () => {
  const three = [task({ id: 1 }), task({ id: 2, status: 'done', title: 'Ведущий оплачен' }), task({ id: 3, title: 'Флорист' })]

  const withTasks = (list) => {
    vi.spyOn(db, 'tasksByTag').mockResolvedValue(list)
    vi.spyOn(db, 'getTask').mockImplementation(async (_d, id) => list.find((t) => t.id === id) ?? null)
  }

  it('складывает очередь из всех свадебных дел, включая закрытые', async () => {
    withTasks(three)
    const res = await startCheckup(env, CHAT, NOW)
    expect(res).toMatchObject({ started: true, total: 3, taskId: 1 })
    expect(db.setFlag).toHaveBeenCalledWith(env.DB, CHAT, 'checkup_queue', '[1,2,3]')
  })

  it('первый вопрос уходит с тремя кнопками', async () => {
    withTasks(three)
    await startCheckup(env, CHAT, NOW)
    const last = tg.sendMessage.mock.calls.at(-1)
    expect(last[2]).toContain('Ведущий')
    const kb = JSON.stringify(last[3].reply_markup)
    expect(kb).toContain('ck:ok:1')
    expect(kb).toContain('ck:later:1')
    expect(kb).toContain('ck:skip:1')
  })

  it('без свадебных дел прогон не начинается', async () => {
    const res = await startCheckup(env, CHAT, NOW)
    expect(res).toMatchObject({ started: false, total: 0 })
    expect(db.setFlag).not.toHaveBeenCalled()
  })

  it('«Подтверждено» ставит confirmed и переходит к следующему', async () => {
    withTasks(three)
    vi.spyOn(db, 'getFlag').mockResolvedValue('[1,2,3]')
    const res = await checkupStep(env, CHAT, NOW, { action: 'ok', taskId: 1 })
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 1, { confirmed: 1 })
    expect(db.setFlag).toHaveBeenCalledWith(env.DB, CHAT, 'checkup_queue', '[2,3]')
    expect(res).toMatchObject({ done: false, taskId: 2, remaining: 2 })
  })

  it('понимает callback_data строкой', async () => {
    withTasks(three)
    vi.spyOn(db, 'getFlag').mockResolvedValue('[1,2,3]')
    await checkupStep(env, CHAT, NOW, 'ck:ok:2')
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 2, { confirmed: 1 })
  })

  it('«Напомни завтра» заводит дело на завтра 13:00 по местному', async () => {
    withTasks(three)
    vi.spyOn(db, 'getFlag').mockResolvedValue('[1,2,3]')
    await checkupStep(env, CHAT, NOW, { action: 'later', taskId: 1 })
    expect(db.createTask).toHaveBeenCalledTimes(1)
    const arg = db.createTask.mock.calls[0][1]
    expect(arg.title).toBe('Уточнить: Ведущий')
    expect(arg.due_at).toBe('2026-08-03T10:00:00.000Z') // 13:00 МСК
    expect(arg.remind_at).toBe('2026-08-03T09:30:00.000Z')
    expect(arg.tag).toBe('wedding')
    expect(db.updateTask).not.toHaveBeenCalled()
  })

  it('«Пропустить» ничего не меняет в деле', async () => {
    withTasks(three)
    vi.spyOn(db, 'getFlag').mockResolvedValue('[1,2,3]')
    const res = await checkupStep(env, CHAT, NOW, { action: 'skip', taskId: 1 })
    expect(db.updateTask).not.toHaveBeenCalled()
    expect(db.createTask).not.toHaveBeenCalled()
    expect(res.taskId).toBe(2)
  })

  it('пропускает исчезнувшее дело и идёт дальше', async () => {
    withTasks(three)
    vi.spyOn(db, 'getFlag').mockResolvedValue('[1,9,3]')
    const res = await checkupStep(env, CHAT, NOW, { action: 'skip', taskId: 1 })
    expect(res.taskId).toBe(3)
    expect(db.setFlag).toHaveBeenCalledWith(env.DB, CHAT, 'checkup_queue', '[3]')
  })

  it('в конце показывает чек-лист дня свадьбы и чистит очередь', async () => {
    withTasks(three)
    vi.spyOn(db, 'getFlag').mockResolvedValue('[3]')
    const res = await checkupStep(env, CHAT, NOW, { action: 'ok', taskId: 3 })
    expect(res).toMatchObject({ done: true, remaining: 0 })
    expect(db.deleteFlag).toHaveBeenCalledWith(env.DB, CHAT, 'checkup_queue')
    const last = tg.sendMessage.mock.calls.at(-1)
    for (const item of WEDDING_DAY_CHECKLIST) expect(last[2]).toContain(item)
    expect(JSON.stringify(last[3].reply_markup)).toContain('ck:checklist')
  })

  it('«Завести недостающее» просит перечислить пункты и закрывает прогон', async () => {
    const res = await checkupStep(env, CHAT, NOW, 'ck:checklist')
    expect(res).toMatchObject({ done: true, awaitingItems: true })
    expect(db.deleteFlag).toHaveBeenCalledWith(env.DB, CHAT, 'checkup_queue')
    expect(tg.sendMessage.mock.calls.at(-1)[2]).toContain('Перечисли реплаем')
  })

  it('чек-лист содержит восемь пунктов и кольца первыми', async () => {
    expect(WEDDING_DAY_CHECKLIST).toHaveLength(8)
    expect(WEDDING_DAY_CHECKLIST[0]).toBe('Кольца')
    expect(checklistText()).toContain('Наличные')
  })
})

describe('режим «День X»', () => {
  it('тихий день срабатывает по местной дате', async () => {
    vi.spyOn(db, 'getFlag').mockResolvedValue('2026-08-15')
    expect(await isQuietDay(env, CHAT, '2026-08-15T10:00:00Z')).toBe(true)
    expect(await isQuietDay(env, CHAT, '2026-08-16T10:00:00Z')).toBe(false)
  })

  it('поздний вечер 14-го по UTC — это уже 15-е в Москве', async () => {
    vi.spyOn(db, 'getFlag').mockResolvedValue('2026-08-15')
    expect(await isQuietDay(env, CHAT, '2026-08-14T21:30:00Z')).toBe(true)
  })

  it('без флага тихого дня режим выключен', async () => {
    expect(await isQuietDay(env, CHAT, '2026-08-15T10:00:00Z')).toBe(false)
  })

  it('таймлайн печатает местное время, названия и контакты', async () => {
    vi.spyOn(db, 'timelineForChat').mockResolvedValue([
      { id: 1, chat_id: CHAT, at: '2026-08-15T08:00:00Z', title: 'Макияж', contact: 'Марина +7 999 000-11-22' },
      { id: 2, chat_id: CHAT, at: '2026-08-15T11:00:00Z', title: 'Выезд к площадке', contact: null },
    ])
    const text = await renderTimeline(env, CHAT, '2026-08-15T06:00:00Z')
    expect(text).toContain('11:00')
    expect(text).toContain('14:00')
    expect(text).toContain('Макияж')
    expect(text).toContain('Марина +7 999 000-11-22')
    expect(text).toContain('<pre>')
  })

  it('пустой таймлайн не падает', async () => {
    const text = await renderTimeline(env, CHAT, '2026-08-15T06:00:00Z')
    expect(text).toContain('Пусто')
  })

  it('тик шлёт пункты в горизонте 40 минут и помечает их', async () => {
    const now = '2026-08-15T08:00:00Z'
    vi.spyOn(db, 'timelineDue').mockResolvedValue([
      { id: 3, chat_id: CHAT, at: '2026-08-15T08:25:00Z', title: 'Выезд к площадке', contact: 'Водитель Игорь' },
    ])
    const sent = await timelineTick(env, CHAT, now)
    expect(db.timelineDue).toHaveBeenCalledWith(env.DB, now, '2026-08-15T08:40:00.000Z')
    expect(sent).toHaveLength(1)
    expect(tg.sendMessage.mock.calls[0][2]).toContain('Через 25 минут')
    expect(tg.sendMessage.mock.calls[0][2]).toContain('Водитель Игорь')
    expect(db.markTimelineNotified).toHaveBeenCalledWith(env.DB, 3)
  })

  it('чужие чаты в тике пропускает, а упавшую отправку не помечает', async () => {
    const now = '2026-08-15T08:00:00Z'
    vi.spyOn(db, 'timelineDue').mockResolvedValue([
      { id: 4, chat_id: -2002, at: '2026-08-15T08:10:00Z', title: 'Чужое', contact: null },
      { id: 5, chat_id: CHAT, at: '2026-08-15T08:20:00Z', title: 'Своё', contact: null },
    ])
    vi.spyOn(tg, 'sendMessage').mockRejectedValue(new Error('network'))
    const sent = await timelineTick(env, CHAT, now)
    expect(tg.sendMessage).toHaveBeenCalledTimes(1)
    expect(sent).toHaveLength(0)
    expect(db.markTimelineNotified).not.toHaveBeenCalled()
  })

  it('вечер: незакрытые дела дня уезжают на 17-е, время сохраняется', async () => {
    const now = '2026-08-15T18:00:00Z' // 21:00 МСК
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue([
      task({ id: 10, status: 'open', due_at: '2026-08-15T09:00:00Z' }),
      task({ id: 11, status: 'done', due_at: '2026-08-15T10:00:00Z' }),
    ])
    const res = await finishWeddingDay(env, CHAT, now)
    expect(res.moved).toBe(1)
    expect(db.updateTask).toHaveBeenCalledTimes(1)
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 10, {
      due_at: '2026-08-17T09:00:00.000Z',
      remind_at: '2026-08-17T08:30:00.000Z',
      notified_pre: 0,
      notified_due: 0,
    })
    expect(tg.sendMessage.mock.calls[0][2]).toContain('1 дело')
  })

  it('вечер без хвостов — просто поздравление', async () => {
    const res = await finishWeddingDay(env, CHAT, '2026-08-15T18:00:00Z')
    expect(res.moved).toBe(0)
    expect(db.updateTask).not.toHaveBeenCalled()
    expect(tg.sendMessage.mock.calls[0][2]).toContain('Хвостов не осталось')
  })
})
