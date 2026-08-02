import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  findFreeWindow, handoffRequest, acceptHandoff, declineHandoff, handoffSummary,
  weeklyBalance, sendWeeklyBalance, suggestRebalance, rebalancePreview, applyRebalance,
  isPersonal,
} from '../src/features/teamwork.js'
import * as db from '../src/db.js'
import * as tg from '../src/telegram.js'

const TZ = 'Europe/Moscow'
const CHAT = -1001
// 2026-08-05 — среда, 12:00 по Москве. Пара как раз просыпается.
const NOW = '2026-08-05T09:00:00Z'

const chat = {
  chat_id: CHAT, tz: TZ, digest_time: '10:00',
  digest_enabled: 1, remind_before_min: 30, last_digest_date: null,
}

/** Московское время в UTC-ISO: msk(6, 15) → 15:00 6 августа по Москве. */
const msk = (day, hour, minute = 0) =>
  `2026-08-${String(day).padStart(2, '0')}T${String(hour - 3).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`

const task = (id, title, day, hour, assignee = 'zhenya') => ({
  id, chat_id: CHAT, title, due_at: msk(day, hour), remind_at: null,
  assignee, status: 'open', handoff_from: null, repeat_rule: null,
})

const env = { DB: {}, BOT_TOKEN: 't', DEFAULT_TZ: TZ, DEFAULT_DIGEST_TIME: '10:00', DEFAULT_REMIND_BEFORE_MIN: '30' }

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(db, 'getChat').mockResolvedValue(chat)
  vi.spyOn(db, 'updateTask').mockResolvedValue()
  vi.spyOn(db, 'bumpStat').mockResolvedValue()
  vi.spyOn(db, 'tasksBetween').mockResolvedValue([])
  vi.spyOn(tg, 'sendMessage').mockResolvedValue({})
})

describe('findFreeWindow', () => {
  it('пустой день — всё окно совиного дня целиком', () => {
    expect(findFreeWindow([], msk(6, 12), TZ)).toBe('с 12:00 до 22:00')
  })

  it('одно дело в 15:00 — берёт самый длинный кусок после него', () => {
    const tasks = [task(1, 'Химчистка', 6, 15)]
    expect(findFreeWindow(tasks, msk(6, 12), TZ)).toBe('с 16:00 до 22:00')
  })

  it('плотный день без единого свободного часа — null', () => {
    const tasks = []
    for (let h = 12; h <= 21; h++) tasks.push(task(h, `Дело ${h}`, 6, h))
    expect(findFreeWindow(tasks, msk(6, 12), TZ)).toBeNull()
  })

  it('дела соседних дней в расчёт не идут', () => {
    const tasks = [task(1, 'Вчерашнее', 5, 15), task(2, 'Послезавтра', 7, 16)]
    expect(findFreeWindow(tasks, msk(6, 12), TZ)).toBe('с 12:00 до 22:00')
  })

  it('дырка меньше часа окном не считается', () => {
    // 12:00–13:00 занято, дальше всё с 13:30 подряд до 22:00.
    // Свободны ровно полчаса — этого мало.
    const tasks = [{ ...task(1, 'Первое', 6, 12), due_at: msk(6, 12) }]
    let id = 2
    for (let h = 13; h <= 21; h++) {
      tasks.push({ ...task(id, `Дело ${id}`, 6, h), due_at: msk(6, h, 30) })
      id += 1
    }
    expect(findFreeWindow(tasks, msk(6, 12), TZ)).toBeNull()
  })
})

describe('handoffRequest', () => {
  const t = task(42, 'Забрать костюм из химчистки', 6, 19)

  it('собирает контекст: кто просит, что, к какому сроку, чем занят партнёр', () => {
    const { text, reply_markup } = handoffRequest(t, 'с 15:00 до 18:00', {
      tz: TZ, nowIso: NOW, partnerTasks: 3,
    })
    expect(text).toContain('Женя просит подхватить')
    expect(text).toContain('Забрать костюм из химчистки')
    expect(text).toContain('завтра, 6 августа')
    expect(text).toContain('19:00')
    expect(text).toContain('3 дела')
    expect(text).toContain('с 15:00 до 18:00')
    expect(reply_markup.inline_keyboard[0][0].callback_data).toBe('hf:take:42')
    expect(reply_markup.inline_keyboard[0][1].callback_data).toBe('hf:pass:42')
  })

  it('без свободного окна текст остаётся спокойным и кнопки на месте', () => {
    const { text, reply_markup } = handoffRequest(t, null, { tz: TZ, nowIso: NOW, partnerTasks: 7 })
    expect(text).toContain('7 дел')
    expect(text).toContain('свободного часа подряд не видно')
    expect(text).toContain('отказ тоже ответ')
    expect(reply_markup.inline_keyboard[0]).toHaveLength(2)
  })

  it('экранирует опасный текст названия', () => {
    const { text } = handoffRequest({ ...t, title: 'Купить 3<5 литров' }, null, { tz: TZ, nowIso: NOW })
    expect(text).toContain('3&lt;5')
    expect(text).not.toContain('3<5')
  })
})

describe('acceptHandoff / declineHandoff', () => {
  const t = task(7, 'Аптека', 6, 16, 'zhenya')

  it('«Забираю» переставляет исполнителя, помнит прежнего и плюсует счётчик', async () => {
    const res = await acceptHandoff(env, t, 'danya', NOW)
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 7, { assignee: 'danya', handoff_from: 'zhenya' })
    expect(db.bumpStat).toHaveBeenCalledWith(env.DB, CHAT, 'handoffs:danya', 1, NOW)
    expect(res.task.assignee).toBe('danya')
    expect(res.text).toContain('Даня забрал')
    expect(res.text).toContain('Аптека')
  })

  it('«Не смогу» возвращает дело владельцу и чистит handoff_from', async () => {
    const pending = { ...t, assignee: 'danya', handoff_from: 'zhenya' }
    const res = await declineHandoff(env, pending, NOW)
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 7, { assignee: 'zhenya', handoff_from: null })
    expect(res.task.assignee).toBe('zhenya')
    expect(res.task.handoff_from).toBeNull()
    expect(res.text).toContain('остаётся на')
    expect(res.text).toContain('Спросить стоило')
    expect(db.bumpStat).not.toHaveBeenCalled()
  })
})

describe('handoffSummary', () => {
  it('считает оба счётчика и склоняет числительное', () => {
    const line = handoffSummary({ 'handoffs:danya': 4, 'handoffs:zhenya': 3, 'walks:danya': 9 })
    expect(line).toContain('7 дел')
    expect(line).toContain('подхватили друг за друга')
  })

  it('одно дело — «1 дело»', () => {
    expect(handoffSummary({ 'handoffs:danya': 1 })).toContain('1 дело')
  })

  it('подхватов не было — строки нет', () => {
    expect(handoffSummary({})).toBeNull()
    expect(handoffSummary({ 'handoffs:danya': 0, 'handoffs:zhenya': 0 })).toBeNull()
  })
})

describe('weeklyBalance', () => {
  it('берёт неделю вперёд, рисует весы и вешает кнопку «Выровнять»', async () => {
    vi.spyOn(db, 'tasksBetween').mockResolvedValue([
      task(1, 'Съёмка', 6, 14, 'zhenya'),
      task(2, 'Аптека', 6, 16, 'zhenya'),
      task(3, 'Кольца', 7, 13, 'danya'),
    ])
    const res = await weeklyBalance(env, CHAT, NOW)

    const [, chatId, fromIso, toIso] = db.tasksBetween.mock.calls[0]
    expect(chatId).toBe(CHAT)
    expect(Math.round((new Date(toIso) - new Date(fromIso)) / 86400000)).toBe(7)
    expect(res.text).toContain('Весы недели')
    expect(res.reply_markup.inline_keyboard[0][0].callback_data).toBe('tw:balance')
  })

  it('sendWeeklyBalance отправляет то же самое в чат', async () => {
    await sendWeeklyBalance(env, CHAT, NOW)
    expect(tg.sendMessage).toHaveBeenCalledTimes(1)
    expect(tg.sendMessage.mock.calls[0][2]).toContain('Весы недели')
  })
})

describe('suggestRebalance', () => {
  // Четверг у Жени забит, у Дани пусто. Маникюр и психолог передавать нельзя.
  const week = [
    task(1, 'Аптека', 6, 13, 'zhenya'),
    task(2, 'Забрать посылку', 6, 14, 'zhenya'),
    task(3, 'Маникюр', 6, 16, 'zhenya'),
    task(4, 'Психолог', 6, 18, 'zhenya'),
  ]

  it('нейросеть ответила — берём её предложения', async () => {
    const run = vi.fn().mockResolvedValue({
      response: 'Вот: [{"task_id": 1, "kind": "assignee", "to": "danya"}]',
    })
    const aiEnv = { ...env, AI_ENABLED: 'true', AI_MODEL: 'llama', AI: { run } }

    const res = await suggestRebalance(aiEnv, week, { tz: TZ, nowIso: NOW })
    expect(run).toHaveBeenCalled()
    expect(res).toEqual([{ taskId: 1, title: 'Аптека', from: 'zhenya', to: 'danya', kind: 'assignee' }])
  })

  it('нейросеть упала — запасной алгоритм всё равно даёт перебросы', async () => {
    const run = vi.fn().mockRejectedValue(new Error('AI unavailable'))
    const aiEnv = { ...env, AI_ENABLED: 'true', AI_MODEL: 'llama', AI: { run } }

    const res = await suggestRebalance(aiEnv, week, { tz: TZ, nowIso: NOW })
    expect(run).toHaveBeenCalled()
    expect(res.length).toBeGreaterThan(0)
    expect(res.every((s) => s.from === 'zhenya')).toBe(true)
  })

  it('личные процедуры к передаче не предлагаются', async () => {
    const run = vi.fn().mockResolvedValue({
      response: '[{"task_id": 3, "kind": "assignee", "to": "danya"}, {"task_id": 4, "kind": "assignee", "to": "danya"}]',
    })
    const aiEnv = { ...env, AI_ENABLED: 'true', AI_MODEL: 'llama', AI: { run } }

    const res = await suggestRebalance(aiEnv, week, { tz: TZ, nowIso: NOW })
    const titles = res.map((s) => s.title)
    expect(titles).not.toContain('Маникюр')
    expect(titles).not.toContain('Психолог')
    expect(titles).toContain('Аптека')
  })

  it('без нейросети считает сам и не трогает личное', async () => {
    const res = await suggestRebalance(env, week, { tz: TZ, nowIso: NOW })
    expect(res).toHaveLength(2)
    expect(res.map((s) => s.title).sort()).toEqual(['Аптека', 'Забрать посылку'])
    expect(res.every((s) => s.kind === 'assignee' && s.to === 'danya')).toBe(true)
  })

  it('ровная неделя — предлагать нечего', async () => {
    const even = [task(1, 'Аптека', 6, 13, 'zhenya'), task(2, 'Кольца', 6, 14, 'danya')]
    expect(await suggestRebalance(env, even, { tz: TZ, nowIso: NOW })).toEqual([])
  })

  it('когда партнёр в этот день тоже занят — двигает дело на другой день', async () => {
    const busy = [
      task(1, 'Аптека', 6, 13, 'zhenya'),
      task(2, 'Посылка', 6, 14, 'zhenya'),
      task(3, 'Сторис', 6, 15, 'zhenya'),
      task(4, 'Монтаж', 6, 16, 'zhenya'),
      task(5, 'Бриф', 6, 17, 'zhenya'),
      task(6, 'Кольца', 6, 18, 'danya'),
      task(7, 'МФЦ', 6, 19, 'danya'),
      task(8, 'Костюм', 6, 20, 'danya'),
    ]
    const res = await suggestRebalance(env, busy, { tz: TZ, nowIso: NOW })
    expect(res.some((s) => s.kind === 'day')).toBe(true)
  })
})

describe('rebalancePreview', () => {
  it('на каждое предложение своя кнопка плюс «Оставить как есть»', () => {
    const suggestions = [
      { taskId: 1, title: 'Аптека', from: 'zhenya', to: 'danya', kind: 'assignee' },
      { taskId: 2, title: 'Посылка', from: msk(6, 12), to: msk(8, 12), kind: 'day' },
    ]
    const { text, reply_markup } = rebalancePreview(suggestions, { tz: TZ, nowIso: NOW })

    expect(text).toContain('Как выровнять неделю')
    expect(text).toContain('2 идеи')
    expect(text).toContain('Аптека')
    const codes = reply_markup.inline_keyboard.flat().map((b) => b.callback_data)
    expect(codes).toEqual(['tw:apply:1:assignee', 'tw:apply:2:day', 'tw:keep'])
  })

  it('пустой список — только кнопка «Оставить как есть»', () => {
    const { text, reply_markup } = rebalancePreview([], { tz: TZ, nowIso: NOW })
    expect(text).toContain('ровная')
    expect(reply_markup.inline_keyboard.flat().map((b) => b.callback_data)).toEqual(['tw:keep'])
  })
})

describe('applyRebalance', () => {
  it('kind=assignee отдаёт дело противоположному человеку', async () => {
    const t = task(11, 'Аптека', 6, 16, 'zhenya')
    const res = await applyRebalance(env, t, 'assignee', NOW)
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 11, { assignee: 'danya', handoff_from: 'zhenya' })
    expect(res.ok).toBe(true)
    expect(res.task.assignee).toBe('danya')
  })

  it('kind=day переносит дело на свободный день и сохраняет время', async () => {
    const t = { ...task(12, 'МФЦ', 6, 15, 'danya'), remind_at: msk(6, 14, 30) }
    vi.spyOn(db, 'tasksBetween').mockResolvedValue([
      t,
      task(13, 'Кольца', 5, 18, 'danya'),
      task(14, 'Костюм', 5, 19, 'danya'),
      task(15, 'Съёмка', 6, 17, 'danya'),
    ])

    const res = await applyRebalance(env, t, 'day', NOW)
    expect(res.ok).toBe(true)
    const patch = db.updateTask.mock.calls[0][2]
    expect(patch.due_at).toBe(msk(7, 15))
    expect(patch.remind_at).toBe(msk(7, 14, 30))
    expect(patch.notified_pre).toBe(0)
    expect(patch.notified_due).toBe(0)
  })

  it('общее дело исполнителя не меняет', async () => {
    const t = task(16, 'Гости', 6, 16, 'both')
    const res = await applyRebalance(env, t, 'assignee', NOW)
    expect(res.ok).toBe(false)
    expect(db.updateTask).not.toHaveBeenCalled()
  })
})

describe('isPersonal', () => {
  it('ловит процедуры в любых падежах', () => {
    for (const s of ['Маникюр', 'записаться к мастеру по бровям', 'нарастить ресницы',
      'психолог в 19:00', 'стоматолог', 'лазерная эпиляция', 'солярий и загар',
      'стрижка', 'ботокс для волос']) {
      expect(isPersonal(s)).toBe(true)
    }
  })

  it('обычные дела личными не считает', () => {
    for (const s of ['Аптека', 'Забрать посылку', 'Оплатить флориста', 'Выгулять Раду']) {
      expect(isPersonal(s)).toBe(false)
    }
  })
})
