import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as db from '../src/db.js'
import {
  looksLikeIntegration, buildIntegrationChain, parseIntegration, chainPreview,
  PLATFORMS, crosspostChain, crosspostPreview,
  dumpToTasks, dumpPreview, DUMP_LIMIT,
  draftKey, saveDraft, loadDraft, dropDraft, applyDraft,
} from '../src/features/content.js'

const TZ = 'Europe/Moscow'
const NOW = '2026-08-02T09:00:00Z' // 12:00 МСК, воскресенье
const CHAT = -1001

const ms = (iso) => new Date(iso).getTime()
const days = (from, to) => (ms(to) - ms(from)) / 86400000

function aiEnv(response) {
  const run = vi.fn().mockResolvedValue(
    typeof response === 'string' ? { response } : response,
  )
  return { AI_ENABLED: 'true', AI: { run }, AI_MODEL: 'llama', DB: {} }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

// ─────────────────────── 1. Раскрутка дедлайна ───────────────────────

describe('looksLikeIntegration', () => {
  it('ловит ключевые слова во всех падежах', () => {
    expect(looksLikeIntegration('интеграция с Medipeel, пост 10 августа')).toBe(true)
    expect(looksLikeIntegration('обсудили интеграцию на сентябрь')).toBe(true)
    expect(looksLikeIntegration('Реклама тонера')).toBe(true)
    expect(looksLikeIntegration('пришёл бриф от бренда')).toBe(true)
    expect(looksLikeIntegration('коллаборация с маркой')).toBe(true)
    expect(looksLikeIntegration('инт. Medipeel 10 авг')).toBe(true)
  })

  it('не срабатывает на середину слова и на посторонний текст', () => {
    expect(looksLikeIntegration('дезинтеграционный процесс')).toBe(false)
    expect(looksLikeIntegration('дезинтеграция общества')).toBe(false)
    expect(looksLikeIntegration('снять сторис про тонер')).toBe(false)
    expect(looksLikeIntegration('')).toBe(false)
    expect(looksLikeIntegration(null)).toBe(false)
  })
})

describe('buildIntegrationChain', () => {
  const DEADLINE = '2026-08-22T09:00:00Z' // 20 дней от NOW — места хватает

  it('шесть шагов с брендом в названии и полными зазорами', () => {
    const steps = buildIntegrationChain('Medipeel', DEADLINE, TZ, NOW)
    expect(steps).toHaveLength(6)
    expect(steps.map((s) => s.title)).toEqual([
      'Medipeel: получить бриф и продукт',
      'Medipeel: снять',
      'Medipeel: смонтировать',
      'Medipeel: отправить на согласование',
      'Medipeel: опубликовать',
      'Medipeel: отчёт бренду',
    ])
    expect(steps.map((s) => days(DEADLINE, s.dueAt))).toEqual([-9, -6, -4, -3, 0, 1])
    expect(steps.every((s) => s.tag === 'content')).toBe(true)
  })

  it('без nowIso строит ту же полную цепочку', () => {
    const steps = buildIntegrationChain('Medipeel', DEADLINE, TZ)
    expect(days(DEADLINE, steps[0].dueAt)).toBe(-9)
  })

  it('близкий дедлайн: сжимает пропорционально и не уходит в прошлое', () => {
    const soon = '2026-08-04T09:00:00Z' // всего 2 дня
    const steps = buildIntegrationChain('Medipeel', soon, TZ, NOW)

    expect(steps).toHaveLength(6)
    for (const s of steps) {
      expect(ms(s.dueAt)).toBeGreaterThanOrEqual(ms(NOW))
    }
    // порядок шагов сохранён
    const times = steps.map((s) => ms(s.dueAt))
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    // публикация ровно в дедлайн, отчёт — на следующий день
    expect(ms(steps[4].dueAt)).toBe(ms(soon))
    expect(days(soon, steps[5].dueAt)).toBe(1)
    // сжатие пропорциональное: 9:6:4:3 сохраняют пропорции внутри двух суток
    expect(days(steps[0].dueAt, soon)).toBeCloseTo(2, 3)
    expect(days(steps[1].dueAt, soon)).toBeCloseTo(2 * 6 / 9, 3)
  })

  it('дедлайн уже прошёл: всё падает на «сейчас», порядок цел', () => {
    const past = '2026-07-20T09:00:00Z'
    const steps = buildIntegrationChain('Medipeel', past, TZ, NOW)
    const times = steps.map((s) => ms(s.dueAt))
    expect(times.every((t) => t >= ms(NOW))).toBe(true)
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })

  it('мусорная дата даёт пустую цепочку, пустой бренд — запасное имя', () => {
    expect(buildIntegrationChain('Medipeel', 'позавчера', TZ, NOW)).toEqual([])
    expect(buildIntegrationChain('', DEADLINE, TZ, NOW)[1].title).toBe('Интеграция: снять')
  })
})

describe('parseIntegration', () => {
  it('достаёт бренд и дедлайн из свободной фразы', async () => {
    const env = aiEnv('{"brand": "Medipeel", "deadline": "2026-08-10T09:00:00Z"}')
    const res = await parseIntegration(env, 'интеграция с Medipeel, пост 10 августа', NOW, TZ)
    expect(res).toEqual({ brand: 'Medipeel', deadline: '2026-08-10T09:00:00.000Z' })
    expect(env.AI.run).toHaveBeenCalledOnce()
    // в промпт уходит текущая дата и зона
    expect(env.AI.run.mock.calls[0][1].messages[1].content).toContain('2026-08-02')
  })

  it('нейросеть вернула мусор — null', async () => {
    for (const junk of [
      'Конечно! Сейчас всё сделаю.',
      '{"brand": "", "deadline": "2026-08-10T09:00:00Z"}',
      '{"brand": "Medipeel", "deadline": null}',
      '{"brand": "Medipeel", "deadline": "как-нибудь на той неделе"}',
      '{"brand": "null", "deadline": "2026-08-10T09:00:00Z"}',
      '{сломанный json',
    ]) {
      expect(await parseIntegration(aiEnv(junk), 'интеграция', NOW, TZ)).toBeNull()
    }
  })

  it('нейросеть упала или выключена — null, функциональность цела', async () => {
    const broken = { AI_ENABLED: 'true', AI: { run: vi.fn().mockRejectedValue(new Error('429')) }, AI_MODEL: 'm' }
    expect(await parseIntegration(broken, 'интеграция с Medipeel', NOW, TZ)).toBeNull()

    const off = { AI_ENABLED: 'false', AI: { run: vi.fn() }, AI_MODEL: 'm' }
    expect(await parseIntegration(off, 'интеграция с Medipeel', NOW, TZ)).toBeNull()
    expect(off.AI.run).not.toHaveBeenCalled()

    const noBinding = { AI_ENABLED: 'true' }
    expect(await parseIntegration(noBinding, 'интеграция с Medipeel', NOW, TZ)).toBeNull()
  })
})

describe('chainPreview', () => {
  const steps = buildIntegrationChain('Medipeel', '2026-08-22T09:00:00Z', TZ, NOW)

  it('показывает цепочку с датами и двумя кнопками', () => {
    const { text, reply_markup: kb } = chainPreview('Medipeel', steps, { tz: TZ, nowIso: NOW, key: 'k1' })
    expect(text).toContain('Medipeel')
    expect(text).toContain('1. получить бриф и продукт')
    expect(text).toContain('6. отчёт бренду')
    expect(text).toContain('6 дел')
    expect(text).toContain('12:00')
    // бренд в шапке, в строках его уже не дублируем
    expect(text).not.toContain('Medipeel: снять')

    expect(kb.inline_keyboard[0][0]).toEqual({ text: '✅ Завести все 6', callback_data: 'ct:chain:k1' })
    expect(kb.inline_keyboard[0][1]).toEqual({ text: 'Отмена', callback_data: 'ct:cancel:k1' })
  })

  it('ключ по умолчанию считается из nowIso и экранирует бренд', () => {
    const { text, reply_markup: kb } = chainPreview('Kiehl<s>', steps, { tz: TZ, nowIso: NOW })
    expect(kb.inline_keyboard[0][0].callback_data).toBe(`ct:chain:${draftKey(NOW)}`)
    expect(text).toContain('Kiehl&lt;s&gt;')
    expect(text).not.toContain('<s>')
  })
})

// ─────────────────────────── 2. Четыре ленты ───────────────────────────

describe('PLATFORMS и crosspostChain', () => {
  it('четыре площадки с конкретными подсказками', () => {
    expect(PLATFORMS.map((p) => p.id)).toEqual(['tiktok', 'instagram', 'threads', 'pinterest'])
    for (const p of PLATFORMS) {
      expect(p.name).toBeTruthy()
      expect(p.emoji).toBeTruthy()
      expect(p.hint.length).toBeGreaterThan(20)
    }
    expect(PLATFORMS[0].hint).toMatch(/9:16/)
    expect(PLATFORMS[3].hint).toMatch(/2:3/)
  })

  it('четыре зеркальных дела со сдвигом на день', () => {
    const base = '2026-08-05T09:00:00Z'
    const steps = crosspostChain('Обзор тонера', base, TZ)
    expect(steps.map((s) => s.title)).toEqual([
      'TikTok: Обзор тонера',
      'Instagram: Обзор тонера',
      'Threads: Обзор тонера',
      'Pinterest: Обзор тонера',
    ])
    expect(steps.map((s) => days(base, s.dueAt))).toEqual([0, 1, 2, 3])
    expect(steps.every((s) => s.tag === 'content')).toBe(true)
    expect(steps[0].hint).toBe(PLATFORMS[0].hint)
  })

  it('пустое название или битая дата — пустой список', () => {
    expect(crosspostChain('', '2026-08-05T09:00:00Z', TZ)).toEqual([])
    expect(crosspostChain('Обзор', 'когда-нибудь', TZ)).toEqual([])
  })
})

describe('crosspostPreview', () => {
  it('перечисляет площадки с подсказками и даёт две кнопки', () => {
    const steps = crosspostChain('Обзор тонера', '2026-08-05T09:00:00Z', TZ)
    const { text, reply_markup: kb } = crosspostPreview('Обзор тонера', steps, { tz: TZ, nowIso: NOW, key: 'k2' })
    expect(text).toContain('Обзор тонера')
    expect(text).toContain('TikTok')
    expect(text).toContain('Pinterest')
    expect(text).toContain('крючок в первые 2 секунды')
    expect(text).toContain('4 дела')
    expect(kb.inline_keyboard[0][0]).toEqual({ text: '✅ Раскидать по всем', callback_data: 'ct:cross:k2' })
    expect(kb.inline_keyboard[0][1]).toEqual({ text: 'Не надо', callback_data: 'ct:cancel:k2' })
  })
})

// ─────────────────────────── 3. Свалка → список ───────────────────────────

describe('dumpToTasks', () => {
  const FLOW = 'надо ответить двум брендам снять сторис про тонер забрать платье в четверг'

  it('режет поток на дела и подставляет исполнителя по умолчанию', async () => {
    const env = aiEnv(`Вот дела:
{"items": [
  {"title": "Ответить брендам", "due_at": "2026-08-02T15:00:00Z", "assignee": "zhenya"},
  {"title": "Сторис про тонер", "due_at": null, "assignee": "кот"},
  {"title": "Забрать платье", "due_at": "2026-08-06T09:00:00Z", "assignee": "both"}
]}`)
    const items = await dumpToTasks(env, FLOW, NOW, TZ, 'zhenya')
    expect(items).toHaveLength(3)
    expect(items[0]).toEqual({
      title: 'Ответить брендам', dueAt: '2026-08-02T15:00:00.000Z', assignee: 'zhenya',
    })
    expect(items[1].dueAt).toBeNull()
    expect(items[1].assignee).toBe('zhenya') // «кот» не исполнитель
    expect(items[2].assignee).toBe('both')
    // промпт по-русски и запрещает выдумывать даты
    const sys = env.AI.run.mock.calls[0][1].messages[0].content
    expect(sys).toContain('дат не выдумывай')
    expect(sys).toContain('JSON')
  })

  it('принимает и голый массив, и режет хвост после 15 дел', async () => {
    const many = Array.from({ length: 22 }, (_, i) => (
      `{"title": "Дело ${i + 1}", "due_at": null, "assignee": "zhenya"}`
    )).join(',')
    const items = await dumpToTasks(aiEnv(`[${many}]`), FLOW, NOW, TZ, 'zhenya')
    expect(items).toHaveLength(DUMP_LIMIT)
    expect(items[14].title).toBe('Дело 15')
  })

  it('мусор, пустота и падение нейросети дают null', async () => {
    expect(await dumpToTasks(aiEnv('извините, не понял'), FLOW, NOW, TZ, 'zhenya')).toBeNull()
    expect(await dumpToTasks(aiEnv('{"items": "потом"}'), FLOW, NOW, TZ, 'zhenya')).toBeNull()
    expect(await dumpToTasks(aiEnv('{"items": [{"title": "  "}]}'), FLOW, NOW, TZ, 'zhenya')).toBeNull()

    const broken = { AI_ENABLED: 'true', AI: { run: vi.fn().mockRejectedValue(new Error('boom')) }, AI_MODEL: 'm' }
    expect(await dumpToTasks(broken, FLOW, NOW, TZ, 'zhenya')).toBeNull()
  })
})

describe('dumpPreview', () => {
  const items = [
    { title: 'Ответить брендам', dueAt: '2026-08-02T15:00:00Z', assignee: 'zhenya' },
    { title: 'Сторис про тонер', dueAt: null, assignee: 'zhenya' },
    { title: 'Забрать платье', dueAt: '2026-08-06T09:00:00Z', assignee: 'danya' },
    { title: 'Брови 3<5 мм', dueAt: '2026-08-13T09:00:00Z', assignee: 'both' },
  ]

  it('нумерует дела, ставит даты и эмодзи исполнителя', () => {
    const { text } = dumpPreview(items, { tz: TZ, nowIso: NOW, key: 'k3' })
    expect(text).toContain('4 дела')
    expect(text).toContain('1. Ответить брендам — сегодня, 2 августа, 18:00 🐈‍⬛')
    expect(text).toContain('2. Сторис про тонер — без срока')
    expect(text).toContain('🐊')
    expect(text).toContain('👫')
    expect(text).toContain('Брови 3&lt;5 мм')
  })

  it('кнопки: завести все, по одной на дело и отмена', () => {
    const { reply_markup: kb } = dumpPreview(items, { tz: TZ, nowIso: NOW, key: 'k3' })
    expect(kb.inline_keyboard[0]).toEqual([{ text: '✅ Завести все', callback_data: 'ct:dump:k3' }])
    expect(kb.inline_keyboard[1]).toEqual([
      { text: '1', callback_data: 'ct:dumpone:k3:0' },
      { text: '2', callback_data: 'ct:dumpone:k3:1' },
      { text: '3', callback_data: 'ct:dumpone:k3:2' },
      { text: '4', callback_data: 'ct:dumpone:k3:3' },
    ])
    expect(kb.inline_keyboard.at(-1)).toEqual([{ text: 'Отмена', callback_data: 'ct:cancel:k3' }])
  })

  it('длинный список бьёт номера по рядам не длиннее пяти', () => {
    const many = Array.from({ length: 12 }, (_, i) => (
      { title: `Дело ${i + 1}`, dueAt: null, assignee: 'zhenya' }
    ))
    const rows = dumpPreview(many, { tz: TZ, nowIso: NOW }).reply_markup.inline_keyboard
    const numberRows = rows.slice(1, -1)
    expect(numberRows.map((r) => r.length)).toEqual([5, 5, 2])
    expect(numberRows[2][1].callback_data).toBe(`ct:dumpone:${draftKey(NOW)}:11`)
  })
})

// ─────────────────────────── черновики и заведение ───────────────────────────

describe('черновики во флагах чата', () => {
  it('сохраняет, читает и удаляет по ключу draft:<key>', async () => {
    const store = new Map()
    vi.spyOn(db, 'setFlag').mockImplementation(async (_d, chatId, key, value) => {
      store.set(`${chatId}|${key}`, value)
    })
    vi.spyOn(db, 'getFlag').mockImplementation(async (_d, chatId, key) => store.get(`${chatId}|${key}`) ?? null)
    vi.spyOn(db, 'deleteFlag').mockImplementation(async (_d, chatId, key) => {
      store.delete(`${chatId}|${key}`)
    })

    const env = { DB: {} }
    const items = [{ title: 'Medipeel: снять', dueAt: NOW, tag: 'content' }]
    const key = await saveDraft(env, CHAT, { kind: 'chain', items }, NOW)

    expect(key).toBe(draftKey(NOW))
    expect(db.setFlag).toHaveBeenCalledWith(env.DB, CHAT, `draft:${key}`, expect.any(String))

    const loaded = await loadDraft(env, CHAT, key)
    expect(loaded.kind).toBe('chain')
    expect(loaded.items).toEqual(items)
    expect(loaded.createdAt).toBe(NOW)

    await dropDraft(env, CHAT, key)
    expect(await loadDraft(env, CHAT, key)).toBeNull()
  })

  it('битый JSON во флаге не роняет чтение', async () => {
    vi.spyOn(db, 'getFlag').mockResolvedValue('{это не json')
    expect(await loadDraft({ DB: {} }, CHAT, 'k')).toBeNull()
  })
})

describe('applyDraft', () => {
  beforeEach(() => {
    vi.spyOn(db, 'createTask').mockImplementation(async (_d, t) => ({ ...t, id: 7 }))
  })

  it('заводит дела цепочки с тегом content', async () => {
    const env = { DB: {} }
    const steps = buildIntegrationChain('Medipeel', '2026-08-22T09:00:00Z', TZ, NOW)
    const created = await applyDraft(env, CHAT, steps, NOW, 'zhenya')

    expect(created).toHaveLength(6)
    expect(db.createTask).toHaveBeenCalledTimes(6)
    const first = db.createTask.mock.calls[0][1]
    expect(first).toMatchObject({
      chat_id: CHAT,
      title: 'Medipeel: получить бриф и продукт',
      assignee: 'zhenya',
      tag: 'content',
      created_at: NOW,
      created_by: 0,
      repeat_rule: null,
      remind_at: null,
    })
    expect(first.due_at).toBe('2026-08-13T09:00:00.000Z')
    expect(db.createTask.mock.calls.every((c) => c[1].tag === 'content')).toBe(true)
  })

  it('дела из свалки идут без тега, с личным исполнителем и пустым сроком', async () => {
    const env = { DB: {} }
    const items = [
      { title: 'Ответить брендам', dueAt: null, assignee: 'zhenya' },
      { title: 'Забрать платье', dueAt: '2026-08-06T09:00:00Z', assignee: 'danya' },
      { title: '   ', dueAt: null, assignee: 'zhenya' }, // пустышку пропускаем
      { title: 'Без исполнителя', dueAt: null },
    ]
    const created = await applyDraft(env, CHAT, items, NOW, 'both')

    expect(created).toHaveLength(3)
    expect(db.createTask.mock.calls[0][1]).toMatchObject({ tag: null, due_at: null, assignee: 'zhenya' })
    expect(db.createTask.mock.calls[1][1].due_at).toBe('2026-08-06T09:00:00.000Z')
    expect(db.createTask.mock.calls[2][1].assignee).toBe('both')
  })

  it('пустой список ничего не заводит', async () => {
    expect(await applyDraft({ DB: {} }, CHAT, [], NOW, 'zhenya')).toEqual([])
    expect(await applyDraft({ DB: {} }, CHAT, null, NOW, 'zhenya')).toEqual([])
    expect(db.createTask).not.toHaveBeenCalled()
  })
})
