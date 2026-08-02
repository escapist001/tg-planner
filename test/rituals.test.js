import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as rt from '../src/features/rituals.js'
import * as db from '../src/db.js'
import * as tg from '../src/telegram.js'

const CHAT = -1001
const TZ = 'Europe/Moscow' // летом UTC+3

// Среда 5 августа 2026, 23:32 по Москве — окно полночной планёрки.
const REVIEW_NOW = '2026-08-05T20:32:00Z'
// Воскресенье 9 августа 2026, 21:00 по Москве — окно недельной сборки.
const SUNDAY_NOW = '2026-08-09T18:00:00Z'

const chat = {
  chat_id: CHAT, tz: TZ, digest_time: '10:00', digest_enabled: 1,
  remind_before_min: 30, last_digest_date: null,
  review_time: '23:30', weekly_time: '21:00',
  last_review_date: null, last_weekly_date: null,
}

function makeEnv(extra = {}) {
  return {
    BOT_TOKEN: 't',
    DB: {},
    DEFAULT_TZ: TZ,
    AI_MODEL: '@cf/meta/llama-3.1-8b-instruct',
    AI_ENABLED: 'true',
    AI: { run: vi.fn().mockResolvedValue({ response: 'Закрыли одно из трёх, химчистка осталась на завтра.' }) },
    ...extra,
  }
}

const task = (over = {}) => ({
  id: 1, chat_id: CHAT, title: 'Дело', due_at: null, remind_at: null,
  assignee: 'danya', status: 'open', repeat_rule: null, parent_id: null,
  tag: null, hard_day: 0, postpone_count: 0, ...over,
})

// День 5 августа: одно закрыто, одно просрочено (свадебное), одно ещё впереди.
const DAY_TASKS = [
  task({ id: 1, title: 'Флорист', due_at: '2026-08-05T09:00:00Z', status: 'done' }),
  task({
    id: 2, title: 'Подтвердить ведущего', due_at: '2026-08-05T15:00:00Z',
    remind_at: '2026-08-05T14:30:00Z', tag: 'wedding', assignee: 'both',
  }),
  task({ id: 3, title: 'Химчистка', due_at: '2026-08-05T20:50:00Z', assignee: 'zhenya' }),
]

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(db, 'getChat').mockResolvedValue(chat)
  vi.spyOn(db, 'tasksOfDay').mockResolvedValue([])
  vi.spyOn(db, 'tasksBetween').mockResolvedValue([])
  vi.spyOn(db, 'updateTask').mockResolvedValue()
  vi.spyOn(db, 'getFlag').mockResolvedValue(null)
  vi.spyOn(db, 'setFlag').mockResolvedValue()
  vi.spyOn(db, 'getStat').mockResolvedValue(0)
  vi.spyOn(db, 'setStat').mockResolvedValue()
  vi.spyOn(db, 'bumpStat').mockResolvedValue()
  vi.spyOn(db, 'allStats').mockResolvedValue({})
  vi.spyOn(tg, 'sendMessage').mockResolvedValue({})
  vi.spyOn(tg, 'sendPoll').mockResolvedValue({ poll: { id: '1' } })
})

describe('окно полночной планёрки', () => {
  it('срабатывает в 23:32 при разборе в 23:30', () => {
    expect(rt.shouldRunReview(chat, REVIEW_NOW)).toBe(true)
  })

  it('второй раз за те же сутки не срабатывает', () => {
    const sent = { ...chat, last_review_date: '2026-08-05' }
    expect(rt.shouldRunReview(sent, REVIEW_NOW)).toBe(false)
  })

  it('после окна молчит', () => {
    expect(rt.shouldRunReview(chat, '2026-08-05T20:40:00Z')).toBe(false) // 23:40 МСК
    expect(rt.shouldRunReview(chat, '2026-08-05T20:20:00Z')).toBe(false) // 23:20 МСК
  })

  it('вчерашняя отметка разбору не мешает', () => {
    const sent = { ...chat, last_review_date: '2026-08-04' }
    expect(rt.shouldRunReview(sent, REVIEW_NOW)).toBe(true)
  })
})

describe('разбор дня', () => {
  it('пустой день остаётся без сообщения', async () => {
    const env = makeEnv()
    expect(await rt.dayReview(env, CHAT, REVIEW_NOW)).toBeNull()
  })

  it('делит день на закрытое, открытое и просроченное', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue(DAY_TASKS)

    const res = await rt.dayReview(env, CHAT, REVIEW_NOW)
    expect(res.text).toContain('Закрыто 1 из 3')
    expect(res.text).toContain('Флорист')
    expect(res.text).toContain('<b>Просрочено</b> — 1 дело')
    expect(res.text).toContain('Подтвердить ведущего')
    expect(res.text).toContain('<b>Ещё открыто</b> — 1 дело')
    expect(res.text).toContain('Химчистка')
    expect(res.text).toContain('Закрыли одно из трёх')
    expect(res.reply_markup.inline_keyboard[0][0].callback_data).toBe('rt:spread')
  })

  it('нейросеть упала — подставляется заготовка', async () => {
    const env = makeEnv({ AI: { run: vi.fn().mockRejectedValue(new Error('AI down')) } })
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue(DAY_TASKS)

    const res = await rt.dayReview(env, CHAT, REVIEW_NOW)
    expect(env.AI.run).toHaveBeenCalled()
    expect(res.text).toContain('Закрыта часть списка')
  })

  it('нейросеть выключена — заготовка выбирается по числу закрытых', async () => {
    const env = makeEnv({ AI_ENABLED: 'false' })
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue(DAY_TASKS.map((t) => ({ ...t, status: 'open' })))

    const res = await rt.dayReview(env, CHAT, REVIEW_NOW)
    expect(res.text).toContain('День прошёл мимо списка')

    vi.spyOn(db, 'tasksOfDay').mockResolvedValue(DAY_TASKS.map((t) => ({ ...t, status: 'done' })))
    const full = await rt.dayReview(env, CHAT, REVIEW_NOW)
    expect(full.text).toContain('Всё, что стояло на сегодня, закрыто')
    expect(full.reply_markup).toBeNull()
  })

  it('экранирует название дела', async () => {
    const env = makeEnv({ AI_ENABLED: 'false' })
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue([
      task({ id: 9, title: 'Купить 3<5 литров', due_at: '2026-08-05T09:00:00Z' }),
    ])
    const res = await rt.dayReview(env, CHAT, REVIEW_NOW)
    expect(res.text).toContain('Купить 3&lt;5 литров')
  })
})

describe('раскидать хвосты', () => {
  it('срочное — на завтра на то же время, остальное — на субботу с 13:00', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue([
      ...DAY_TASKS,
      task({ id: 4, title: 'Жёсткий день', due_at: '2026-08-05T16:15:00Z', hard_day: 1 }),
      task({ id: 5, title: 'Аптека', due_at: '2026-08-05T17:00:00Z' }),
    ])

    const res = await rt.spreadLeftovers(env, CHAT, REVIEW_NOW, TZ)
    expect(res.moved).toBe(4)
    expect(res.tomorrow.map((t) => t.id)).toEqual([2, 4])
    expect(res.weekend.map((t) => t.id)).toEqual([5, 3])

    // Свадебное дело стояло на 18:00 МСК — на завтра встаёт туда же.
    expect(res.tomorrow[0].due_at).toBe('2026-08-06T15:00:00.000Z')
    // Жёсткий день: 19:15 МСК → 19:15 МСК завтра.
    expect(res.tomorrow[1].due_at).toBe('2026-08-06T16:15:00.000Z')
    // Суббота 8 августа: 13:00 и 14:00 МСК.
    expect(res.weekend[0].due_at).toBe('2026-08-08T10:00:00.000Z')
    expect(res.weekend[1].due_at).toBe('2026-08-08T11:00:00.000Z')
  })

  it('сохраняет зазор до напоминания и сбрасывает отметки', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue([DAY_TASKS[1]])

    await rt.spreadLeftovers(env, CHAT, REVIEW_NOW, TZ)
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 2, {
      due_at: '2026-08-06T15:00:00.000Z',
      remind_at: '2026-08-06T14:30:00.000Z',
      notified_pre: 0,
      notified_due: 0,
    })
  })

  it('закрытый день никуда не переезжает', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue([DAY_TASKS[0]])

    const res = await rt.spreadLeftovers(env, CHAT, REVIEW_NOW, TZ)
    expect(res).toEqual({ moved: 0, tomorrow: [], weekend: [] })
    expect(db.updateTask).not.toHaveBeenCalled()
  })
})

describe('воскресная сборка', () => {
  // Понедельник забит под завязку, в пятницу — дело, к которому ничего не готовится.
  const WEEK = [
    ...Array.from({ length: 4 }, (_, i) => task({
      id: 10 + i, title: `Понедельник ${i + 1}`, due_at: `2026-08-10T0${6 + i}:00:00Z`,
    })),
    task({ id: 20, title: 'Интеграция с Medipeel', due_at: '2026-08-14T09:00:00Z', assignee: 'zhenya' }),
  ]

  it('шлёт карту недели и три вопроса', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'tasksBetween').mockResolvedValue(WEEK)

    const res = await rt.weeklyAssembly(env, CHAT, SUNDAY_NOW)
    expect(res.text).toContain('Неделя целиком')
    expect(res.text).toContain('1. Плотнее всего в понедельник — 4 дела')
    expect(res.text).toContain('2. У дела «Интеграция с Medipeel»')
    expect(res.text).toContain('3. Какой вечер')

    const codes = res.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)
    expect(codes).toEqual(['rt:unload:2026-08-10', 'rt:prep:20', 'rt:date'])
  })

  it('спокойная неделя оставляет только вопрос про свидание', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'tasksBetween').mockResolvedValue([
      task({ id: 30, title: 'Прогулка', due_at: '2026-08-10T15:00:00Z' }),
    ])

    const res = await rt.weeklyAssembly(env, CHAT, SUNDAY_NOW)
    const codes = res.reply_markup.inline_keyboard.flat().map((b) => b.callback_data)
    expect(codes).toEqual(['rt:date'])
  })

  it('помнит уже забронированный вечер', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'getFlag').mockResolvedValue('5')

    const res = await rt.weeklyAssembly(env, CHAT, SUNDAY_NOW)
    expect(res.text).toContain('Свидание пока стоит в пятницу')
  })

  it('опрос уходит семью вариантами с понедельника', async () => {
    const env = makeEnv()
    await rt.dateNightPoll(env, CHAT)

    const [, chatId, question, options] = tg.sendPoll.mock.calls[0]
    expect(chatId).toBe(CHAT)
    expect(question).toBe('Какой вечер бронируем под свидание?')
    expect(options).toHaveLength(7)
    expect(options[0]).toBe('Понедельник')
    expect(rt.dateNightWeekday(0)).toBe(1)
    expect(rt.dateNightWeekday(6)).toBe(0)
  })
})

describe('защищённый вечер', () => {
  it('сохраняется во флаг вместе с датой брони', async () => {
    const env = makeEnv()
    const res = await rt.protectEvening(env, CHAT, 5, SUNDAY_NOW)

    expect(res).toEqual({ weekday: 5, label: 'пятница' })
    expect(db.setFlag).toHaveBeenCalledWith(env.DB, CHAT, 'protected_evening', 5)
    expect(db.setFlag).toHaveBeenCalledWith(env.DB, CHAT, 'protected_evening_since', SUNDAY_NOW)
  })

  it('чужой номер дня отбрасывается', async () => {
    const env = makeEnv()
    expect(await rt.protectEvening(env, CHAT, 9, SUNDAY_NOW)).toBeNull()
    expect(db.setFlag).not.toHaveBeenCalled()
  })

  it('ловит дело, поставленное на защищённый вечер', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'getFlag').mockResolvedValue('5')

    // Пятница 7 августа, 19:00 МСК.
    expect(await rt.isProtectedSlot(env, CHAT, '2026-08-07T16:00:00Z', TZ)).toBe(true)
    // Та же пятница, но 15:00 МСК — день свободен.
    expect(await rt.isProtectedSlot(env, CHAT, '2026-08-07T12:00:00Z', TZ)).toBe(false)
    // Суббота вечером — другой день.
    expect(await rt.isProtectedSlot(env, CHAT, '2026-08-08T16:00:00Z', TZ)).toBe(false)
    // Дело без срока.
    expect(await rt.isProtectedSlot(env, CHAT, null, TZ)).toBe(false)
  })

  it('без брони ничего не защищает', async () => {
    const env = makeEnv()
    expect(await rt.isProtectedSlot(env, CHAT, '2026-08-07T16:00:00Z', TZ)).toBe(false)
  })
})

describe('окно воскресной сборки', () => {
  it('в воскресенье 21:00 срабатывает', () => {
    expect(rt.shouldRunWeekly(chat, SUNDAY_NOW)).toBe(true)
  })

  it('на этой неделе уже присылали — молчит', () => {
    const sent = { ...chat, last_weekly_date: '2026-08-09' }
    expect(rt.shouldRunWeekly(sent, SUNDAY_NOW)).toBe(false)
  })

  it('сборка прошлого воскресенья не мешает', () => {
    const sent = { ...chat, last_weekly_date: '2026-08-02' }
    expect(rt.shouldRunWeekly(sent, SUNDAY_NOW)).toBe(true)
  })

  it('в будни и мимо часа не срабатывает', () => {
    expect(rt.shouldRunWeekly(chat, '2026-08-05T18:00:00Z')).toBe(false) // среда
    expect(rt.shouldRunWeekly(chat, '2026-08-09T19:00:00Z')).toBe(false) // 22:00 МСК
  })
})

describe('чистая полоса', () => {
  it('день без просрочек удлиняет полосу и обновляет рекорд', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'getStat').mockImplementation(async (_db, _chat, key) => (key === 'streak_current' ? 10 : 10))
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue([DAY_TASKS[0]])

    const res = await rt.updateStreak(env, CHAT, REVIEW_NOW, TZ)
    expect(res).toEqual({ current: 11, best: 11, broken: false, skipped: false })
    expect(db.bumpStat).toHaveBeenCalledWith(env.DB, CHAT, 'streak_current', 1, REVIEW_NOW)
    expect(db.setStat).toHaveBeenCalledWith(env.DB, CHAT, 'streak_best', 11, REVIEW_NOW)
    expect(db.setFlag).toHaveBeenCalledWith(env.DB, CHAT, 'streak_date', '2026-08-05')
  })

  it('рекорд не трогается, если он выше текущей полосы', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'getStat').mockImplementation(async (_db, _chat, key) => (key === 'streak_current' ? 3 : 16))
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue([])

    const res = await rt.updateStreak(env, CHAT, REVIEW_NOW, TZ)
    expect(res.current).toBe(4)
    expect(res.best).toBe(16)
    expect(db.setStat).not.toHaveBeenCalled()
  })

  it('просрочка обнуляет полосу', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'getStat').mockImplementation(async (_db, _chat, key) => (key === 'streak_current' ? 11 : 16))
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue(DAY_TASKS)

    const res = await rt.updateStreak(env, CHAT, REVIEW_NOW, TZ)
    expect(res).toEqual({ current: 0, best: 16, broken: true, skipped: false })
    expect(db.setStat).toHaveBeenCalledWith(env.DB, CHAT, 'streak_current', 0, REVIEW_NOW)
    expect(db.bumpStat).not.toHaveBeenCalled()
  })

  it('за сутки считает только один раз', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'getFlag').mockResolvedValue('2026-08-05')
    vi.spyOn(db, 'getStat').mockImplementation(async (_db, _chat, key) => (key === 'streak_current' ? 11 : 16))

    const res = await rt.updateStreak(env, CHAT, REVIEW_NOW, TZ)
    expect(res).toEqual({ current: 11, best: 16, broken: false, skipped: true })
    expect(db.bumpStat).not.toHaveBeenCalled()
    expect(db.setStat).not.toHaveBeenCalled()
  })

  it('строка для дайджеста появляется только при живой полосе', async () => {
    const env = makeEnv()
    expect(await rt.streakForDigest(env, CHAT)).toBeNull()

    vi.spyOn(db, 'getStat').mockImplementation(async (_db, _chat, key) => (key === 'streak_current' ? 11 : 16))
    expect(await rt.streakForDigest(env, CHAT)).toBe('✨ 11 дней без единой просрочки (рекорд — 16 дней).')
  })
})

describe('карточка месяца', () => {
  const LAST_DAY = '2026-08-31T20:00:00Z' // 31 августа, 23:00 МСК

  it('в середине месяца не собирается', async () => {
    const env = makeEnv()
    expect(await rt.monthlyCard(env, CHAT, REVIEW_NOW, TZ)).toBeNull()
  })

  it('в последний день месяца отдаёт файл со статистикой', async () => {
    const env = makeEnv()
    vi.spyOn(db, 'allStats').mockResolvedValue({ streak_best: 16, handoffs: 7, walks: 14 })
    vi.spyOn(db, 'tasksOfDay').mockResolvedValue([
      task({ id: 1, status: 'done', assignee: 'danya' }),
      task({ id: 2, status: 'done', assignee: 'both' }),
      task({ id: 3, status: 'done', assignee: 'zhenya' }),
      task({ id: 4, status: 'open', assignee: 'zhenya' }),
    ])

    const res = await rt.monthlyCard(env, CHAT, LAST_DAY, TZ)
    expect(res.filename).toBe('itogi-2026-08.html')
    expect(res.html).toContain('Август 2026')
    expect(res.html).toContain('3 из 4')
    expect(res.html).toContain('16 дн.')
    expect(res.html).toContain('Прогулок с Радой: 14')
    expect(res.caption).toContain('Закрыто 3 дела из 4')
    expect(res.caption).toContain('лучшая полоса — 16 дней')
    expect(res.caption).toContain('подхватили 7 дел')

    // Месяц берётся по местному календарю: с 1 августа 00:00 МСК.
    expect(db.tasksOfDay).toHaveBeenCalledWith(env.DB, CHAT,
      '2026-07-31T21:00:00.000Z', '2026-08-31T21:00:00.000Z')
  })
})
