import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as zb from '../src/features/zombie.js'
import * as db from '../src/db.js'
import * as tg from '../src/telegram.js'

const CHAT = -1001
const TZ = 'Europe/Moscow'
const NOW = '2026-08-02T09:00:00Z' // 12:00 МСК

function makeEnv(aiResponse) {
  return {
    BOT_TOKEN: 't',
    DB: {},
    AI_MODEL: '@cf/meta/llama-3.1-8b-instruct',
    AI: { run: vi.fn().mockResolvedValue(aiResponse) },
  }
}

const task = {
  id: 42,
  chat_id: CHAT,
  title: 'Отнести документы в МФЦ',
  due_at: '2026-08-05T09:00:00Z',
  assignee: 'danya',
  created_by: 777,
  created_at: '2026-07-14T08:00:00Z',
  postpone_count: 4,
  tag: null,
  hard_day: 0,
}

const AI_OK = {
  response: `Вот план: {"steps": [
    {"title": "Собрать документы", "due_at": "2026-08-03T09:00:00Z"},
    {"title": "Записаться в МФЦ", "due_at": "2026-08-04T09:00:00Z"},
    {"title": "Съездить и сдать", "due_at": "2026-08-06T09:00:00Z"}
  ]}`,
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(db, 'updateTask').mockResolvedValue()
  vi.spyOn(db, 'markDone').mockResolvedValue()
  vi.spyOn(db, 'setFlag').mockResolvedValue()
  vi.spyOn(db, 'getFlag').mockResolvedValue(null)
  vi.spyOn(db, 'deleteFlag').mockResolvedValue()
  vi.spyOn(db, 'createTask').mockImplementation(async (_db, t) => ({ ...t, id: 100 }))
  vi.spyOn(tg, 'sendMessage').mockResolvedValue({})
})

describe('счётчик переносов', () => {
  it('увеличивает postpone_count и возвращает новое значение', async () => {
    const env = makeEnv(AI_OK)
    const count = await zb.registerPostpone(env, task, NOW)
    expect(count).toBe(5)
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 42, { postpone_count: 5 })
  })

  it('у дела без счётчика начинает с единицы', async () => {
    const env = makeEnv(AI_OK)
    const count = await zb.registerPostpone(env, { ...task, postpone_count: undefined }, NOW)
    expect(count).toBe(1)
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 42, { postpone_count: 1 })
  })

  it('вмешивается начиная с пятого раза', () => {
    expect(zb.shouldIntervene(0)).toBe(false)
    expect(zb.shouldIntervene(4)).toBe(false)
    expect(zb.shouldIntervene(5)).toBe(true)
    expect(zb.shouldIntervene(11)).toBe(true)
  })
})

describe('разговор на пятом переносе', () => {
  const msg = () => zb.interventionMessage({ ...task, postpone_count: 5 }, { tz: TZ, nowIso: NOW })

  it('называет дело, число переносов и дату появления', () => {
    const { text } = msg()
    expect(text).toContain('Отнести документы в МФЦ')
    expect(text).toContain('5 раз')
    expect(text).toContain('14 июля')
  })

  it('склоняет числительное по-русски', () => {
    const { text } = zb.interventionMessage({ ...task, postpone_count: 22 }, { tz: TZ, nowIso: NOW })
    expect(text).toContain('22 раза')
  })

  it('даёт четыре выхода с правильными callback_data', () => {
    const flat = msg().reply_markup.inline_keyboard.flat()
    expect(flat.map((b) => b.callback_data)).toEqual([
      'zb:split:42', 'zb:give:42', 'zb:hard:42', 'zb:drop:42',
    ])
    expect(flat.length).toBe(4)
  })

  it('экранирует HTML в названии дела', () => {
    const { text } = zb.interventionMessage(
      { ...task, title: 'Купить 3<5 литров & скотч', postpone_count: 5 },
      { tz: TZ, nowIso: NOW },
    )
    expect(text).toContain('3&lt;5 литров &amp; скотч')
    expect(text).not.toContain('3<5')
  })

  it('обходится без даты, если created_at не заполнен', () => {
    const { text } = zb.interventionMessage(
      { ...task, created_at: null, postpone_count: 5 },
      { tz: TZ, nowIso: NOW },
    )
    expect(text).toContain('5 раз')
    expect(text).not.toContain('ждёт с')
  })

  it('maybeIntervene на пятом переносе шлёт сообщение', async () => {
    const env = makeEnv(AI_OK)
    const res = await zb.maybeIntervene(env, task, { tz: TZ, nowIso: NOW })
    expect(res).toEqual({ count: 5, intervened: true })
    expect(tg.sendMessage).toHaveBeenCalledTimes(1)
    expect(tg.sendMessage.mock.calls[0][1]).toBe(CHAT)
    expect(tg.sendMessage.mock.calls[0][2]).toContain('Отнести документы в МФЦ')
  })

  it('maybeIntervene на третьем переносе молчит', async () => {
    const env = makeEnv(AI_OK)
    const res = await zb.maybeIntervene(env, { ...task, postpone_count: 2 }, { tz: TZ, nowIso: NOW })
    expect(res).toEqual({ count: 3, intervened: false })
    expect(tg.sendMessage).not.toHaveBeenCalled()
  })
})

describe('жёсткий день', () => {
  it('markHardDay ставит флаг', async () => {
    const env = makeEnv(AI_OK)
    await zb.markHardDay(env, 42)
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 42, { hard_day: 1 })
  })

  it('обычному делу даёт все четыре варианта переноса', () => {
    const opts = zb.snoozeOptionsFor(task)
    expect(opts.map((b) => b.callback_data)).toEqual([
      'sn:42:15', 'sn:42:60', 'sn:42:evening', 'sn:42:tomorrow',
    ])
  })

  it('делу с жёстким днём оставляет только «завтра»', () => {
    const opts = zb.snoozeOptionsFor({ ...task, hard_day: 1 })
    expect(opts).toHaveLength(1)
    expect(opts[0].callback_data).toBe('sn:42:tomorrow')
    expect(opts[0].text).toContain('Завтра')
    expect(zb.snoozePrompt({ ...task, hard_day: 1 })).toContain('жёсткий день')
    expect(zb.snoozeKeyboardFor({ ...task, hard_day: 1 }).inline_keyboard[0]).toHaveLength(1)
  })
})

describe('дробилка: вызов нейросети', () => {
  it('разбирает ответ модели в массив шагов', async () => {
    const env = makeEnv(AI_OK)
    const steps = await zb.splitTask(env, task, NOW, TZ)
    expect(steps).toEqual([
      { title: 'Собрать документы', dueAt: '2026-08-03T09:00:00.000Z' },
      { title: 'Записаться в МФЦ', dueAt: '2026-08-04T09:00:00.000Z' },
      { title: 'Съездить и сдать', dueAt: '2026-08-06T09:00:00.000Z' },
    ])
    expect(env.AI.run).toHaveBeenCalledTimes(1)
    const [model, payload] = env.AI.run.mock.calls[0]
    expect(model).toBe('@cf/meta/llama-3.1-8b-instruct')
    expect(payload.messages[1].content).toContain('Отнести документы в МФЦ')
    expect(payload.messages[1].content).toContain('Europe/Moscow')
  })

  it('принимает и голый массив вместо объекта', async () => {
    const env = makeEnv({ response: '[{"title":"Раз"},{"title":"Два"},{"title":"Три"}]' })
    const steps = await zb.splitTask(env, task, NOW, TZ)
    expect(steps.map((s) => s.title)).toEqual(['Раз', 'Два', 'Три'])
    expect(steps.every((s) => s.dueAt === null)).toBe(true)
  })

  it('битую дату шага превращает в «без срока»', async () => {
    const env = makeEnv({
      response: '{"steps":[{"title":"Раз","due_at":"когда-нибудь"},'
        + '{"title":"Два","due_at":"2026-08-04T09:00:00Z"},{"title":"Три","due_at":null}]}',
    })
    const steps = await zb.splitTask(env, task, NOW, TZ)
    expect(steps[0].dueAt).toBeNull()
    expect(steps[1].dueAt).toBe('2026-08-04T09:00:00.000Z')
  })

  it('обрезает список до пяти шагов и выкидывает пустые названия', async () => {
    const items = Array.from({ length: 8 }, (_, i) => `{"title":"Шаг ${i + 1}"}`).join(',')
    const env = makeEnv({ response: `{"steps":[${items},{"title":"   "},{"nope":1}]}` })
    const steps = await zb.splitTask(env, task, NOW, TZ)
    expect(steps).toHaveLength(5)
    expect(steps[4].title).toBe('Шаг 5')
  })

  it('нейросеть вернула мусор без JSON — null', async () => {
    const env = makeEnv({ response: 'Конечно! Давайте разобьём это дело на шаги.' })
    expect(await zb.splitTask(env, task, NOW, TZ)).toBeNull()
  })

  it('нейросеть вернула JSON не той формы — null', async () => {
    const env = makeEnv({ response: '{"steps": "сначала документы, потом МФЦ"}' })
    expect(await zb.splitTask(env, task, NOW, TZ)).toBeNull()
  })

  it('нейросеть вернула сломанный JSON — null', async () => {
    const env = makeEnv({ response: '{"steps": [{"title": "Раз"},, ]}' })
    expect(await zb.splitTask(env, task, NOW, TZ)).toBeNull()
  })

  it('шагов слишком мало — null, ничего не выдумываем', async () => {
    const env = makeEnv({ response: '{"steps":[{"title":"Сделать всё"}]}' })
    expect(await zb.splitTask(env, task, NOW, TZ)).toBeNull()
  })

  it('нейросеть упала — null без исключения наружу', async () => {
    const env = makeEnv(AI_OK)
    env.AI.run = vi.fn().mockRejectedValue(new Error('AI unavailable'))
    await expect(zb.splitTask(env, task, NOW, TZ)).resolves.toBeNull()
  })

  it('без биндинга AI молча возвращает null', async () => {
    expect(await zb.splitTask({ DB: {} }, task, NOW, TZ)).toBeNull()
  })
})

describe('дробилка: черновик и подтверждение', () => {
  const steps = [
    { title: 'Собрать документы', dueAt: '2026-08-03T09:00:00.000Z' },
    { title: 'Записаться в МФЦ', dueAt: null },
  ]

  it('превью показывает шаги, даты и две кнопки', () => {
    const { text, reply_markup } = zb.splitPreview(task, steps, { tz: TZ, nowIso: NOW })
    expect(text).toContain('2 шага')
    expect(text).toContain('1. <b>Собрать документы</b>')
    expect(text).toContain('12:00')
    expect(text).toContain('без срока')
    expect(reply_markup.inline_keyboard[0].map((b) => b.callback_data))
      .toEqual(['zb:apply:42', 'zb:cancel:42'])
  })

  it('превью экранирует названия шагов от нейросети', () => {
    const { text } = zb.splitPreview(task, [{ title: '<b>взлом</b>', dueAt: null }, steps[1]],
      { tz: TZ, nowIso: NOW })
    expect(text).toContain('&lt;b&gt;взлом&lt;/b&gt;')
  })

  it('черновик кладётся в флаг чата и читается обратно', async () => {
    const env = makeEnv(AI_OK)
    await zb.saveSplitDraft(env, CHAT, 42, steps)
    expect(db.setFlag).toHaveBeenCalledWith(env.DB, CHAT, 'split:42', JSON.stringify(steps))

    vi.spyOn(db, 'getFlag').mockResolvedValue(JSON.stringify(steps))
    expect(await zb.loadSplitDraft(env, CHAT, 42)).toEqual(steps)
  })

  it('битый черновик читается как null', async () => {
    const env = makeEnv(AI_OK)
    vi.spyOn(db, 'getFlag').mockResolvedValue('{сломано')
    expect(await zb.loadSplitDraft(env, CHAT, 42)).toBeNull()

    vi.spyOn(db, 'getFlag').mockResolvedValue(null)
    expect(await zb.loadSplitDraft(env, CHAT, 42)).toBeNull()
  })

  it('applySplit заводит подзадачи, закрывает родителя и убирает черновик', async () => {
    const env = makeEnv(AI_OK)
    const created = await zb.applySplit(env, task, steps, NOW)

    expect(created).toHaveLength(2)
    expect(db.createTask).toHaveBeenNthCalledWith(1, env.DB, {
      chat_id: CHAT,
      title: 'Собрать документы',
      due_at: '2026-08-03T09:00:00.000Z',
      remind_at: '2026-08-03T08:30:00.000Z',
      assignee: 'danya',
      created_by: 777,
      parent_id: 42,
      created_at: NOW,
      tag: null,
    })
    expect(db.createTask.mock.calls[1][1].remind_at).toBeNull()
    expect(db.markDone).toHaveBeenCalledWith(env.DB, 42)
    expect(db.deleteFlag).toHaveBeenCalledWith(env.DB, CHAT, 'split:42')
  })
})
