import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as db from '../src/db.js'
import * as tg from '../src/telegram.js'
import {
  isPetDuty, petOf, dutyMessage, dutyKeyboard, parseDutyCallback, sendDutyQuestion,
  claimDuty, dutyClaimedText, dutyBalance, petsOverview,
  VET_TEMPLATES, vetTemplate, nextVetDue, setupVetSchedule, vetReminderText,
  parseNote, addTaskNote, PETS_TAG,
} from '../src/features/pets.js'

const env = { BOT_TOKEN: 't', DB: {}, DEFAULT_TZ: 'Europe/Moscow' }
const CHAT = -1001
const TZ = 'Europe/Moscow'
const NOW = '2026-08-05T09:00:00Z' // 12:00 МСК, среда

const chat = {
  chat_id: CHAT, tz: TZ, digest_time: '10:00',
  digest_enabled: 1, remind_before_min: 30, last_digest_date: null,
}

const walk = {
  id: 3, chat_id: CHAT, title: 'Прогулка с Радой', due_at: '2026-08-05T16:00:00Z',
  remind_at: '2026-08-05T15:30:00Z', assignee: 'both', created_by: 1,
  repeat_rule: 'daily', parent_id: null, status: 'open', tag: PETS_TAG,
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(db, 'getChat').mockResolvedValue(chat)
  vi.spyOn(db, 'updateTask').mockResolvedValue()
  vi.spyOn(db, 'markDone').mockResolvedValue()
  vi.spyOn(db, 'bumpStat').mockResolvedValue()
  vi.spyOn(db, 'allStats').mockResolvedValue({})
  vi.spyOn(db, 'tasksByTag').mockResolvedValue([])
  vi.spyOn(db, 'addNote').mockResolvedValue()
  vi.spyOn(db, 'notesFor').mockResolvedValue([])
  vi.spyOn(db, 'createTask').mockImplementation(async (_db, t) => ({ ...t, id: 900, status: 'open' }))
  vi.spyOn(tg, 'sendMessage').mockResolvedValue({ message_id: 55 })
})

describe('isPetDuty: кириллица без \\b', () => {
  it('находит «Прогулка с Радой»', () => {
    expect(isPetDuty({ title: 'Прогулка с Радой' })).toBe(true)
  })

  it('не срабатывает на «Прогулочная коляска»', () => {
    expect(isPetDuty({ title: 'Купить прогулочная коляска' })).toBe(false)
    expect(isPetDuty({ title: 'Прогулочная коляска' })).toBe(false)
  })

  it('ловит остальные дежурные слова в любом падеже', () => {
    const yes = ['Покормить Люсю', 'Выгулять Раду', 'Купить корм', 'Помыть лоток Масе',
      'Вечерний выгул', 'Почистить лотки']
    for (const title of yes) expect(isPetDuty({ title })).toBe(true)
  })

  it('мимо проходят похожие слова и обычные дела', () => {
    const no = ['Позвонить в банк', 'Реформа отдела', 'Радуга над домом', 'Кормушка для птиц']
    for (const title of no) expect(isPetDuty({ title })).toBe(false)
  })

  it('тег pets делает делом вахты что угодно', () => {
    expect(isPetDuty({ title: 'Записаться к грумеру', tag: PETS_TAG })).toBe(true)
    expect(isPetDuty(null)).toBe(false)
  })
})

describe('petOf: имя питомца в падежах', () => {
  it('различает троих и не путается с созвучным', () => {
    expect(petOf('Прогулка с Радой')).toBe('Рада')
    expect(petOf('Раде прививка')).toBe('Рада')
    expect(petOf('Покормить Люсю')).toBe('Люся')
    expect(petOf('Лоток Маси')).toBe('Мася')
    expect(petOf('Купить масло и радости немного')).toBe(null)
  })
})

describe('dutyMessage', () => {
  it('спрашивает «Кто идёт?» и даёт две кнопки', () => {
    const { text, reply_markup } = dutyMessage(walk, { tz: TZ, nowIso: NOW })
    expect(text).toContain('Прогулка с Радой')
    expect(text).toContain('Кто идёт?')
    expect(text).toContain('19:00') // 16:00Z = 19:00 МСК

    const row = reply_markup.inline_keyboard[0]
    expect(row).toHaveLength(2)
    expect(row[0]).toEqual({ text: 'Я 🐊', callback_data: 'pt:take:3:danya' })
    expect(row[1]).toEqual({ text: 'Я 🐈‍⬛', callback_data: 'pt:take:3:zhenya' })
  })

  it('экранирует название дела', () => {
    const { text } = dutyMessage({ ...walk, title: 'Корм <Рада> & Ко' }, { tz: TZ, nowIso: NOW })
    expect(text).toContain('&lt;Рада&gt; &amp; Ко')
    expect(text).not.toContain('<Рада>')
  })

  it('разбирает свой callback_data и отбивает чужой', () => {
    expect(parseDutyCallback('pt:take:3:danya')).toEqual({ taskId: 3, who: 'danya' })
    expect(parseDutyCallback('done:3')).toBe(null)
    expect(parseDutyCallback('pt:take:3:кто-то')).toBe(null)
    expect(parseDutyCallback(null)).toBe(null)
  })

  it('sendDutyQuestion отправляет вопрос с клавиатурой', async () => {
    await sendDutyQuestion(env, CHAT, walk, { tz: TZ, nowIso: NOW })
    expect(tg.sendMessage).toHaveBeenCalledTimes(1)
    const [, chatId, text, extra] = tg.sendMessage.mock.calls[0]
    expect(chatId).toBe(CHAT)
    expect(text).toContain('Кто идёт?')
    expect(extra.reply_markup).toEqual(dutyKeyboard(3))
  })
})

describe('claimDuty', () => {
  it('закрывает дело на нажавшего и растит его счётчик', async () => {
    await claimDuty(env, walk, 'danya', NOW)
    expect(db.updateTask).toHaveBeenCalledWith(env.DB, 3, { assignee: 'danya' })
    expect(db.markDone).toHaveBeenCalledWith(env.DB, 3)
    expect(db.bumpStat).toHaveBeenCalledWith(env.DB, CHAT, 'duty:danya', 1, NOW)
  })

  it('у повторяющегося дела заводит следующий раз', async () => {
    const { next } = await claimDuty(env, walk, 'zhenya', NOW)
    expect(next).toBe('2026-08-06T16:00:00.000Z')
    expect(db.createTask).toHaveBeenCalledTimes(1)

    const created = db.createTask.mock.calls[0][1]
    expect(created.title).toBe('Прогулка с Радой')
    expect(created.due_at).toBe(next)
    expect(created.remind_at).toBe('2026-08-06T15:30:00.000Z') // за 30 минут
    expect(created.assignee).toBe('both') // снова общее, снова с кнопками
    expect(created.repeat_rule).toBe('daily')
    expect(created.parent_id).toBe(3)
    expect(created.tag).toBe(PETS_TAG)
  })

  it('у разового дела ничего не заводит', async () => {
    const once = { ...walk, id: 7, repeat_rule: null }
    const { next } = await claimDuty(env, once, 'danya', NOW)
    expect(next).toBe(null)
    expect(db.createTask).not.toHaveBeenCalled()
    expect(db.markDone).toHaveBeenCalledWith(env.DB, 7)
  })

  it('подтверждение называет исполнителя и следующий раз', () => {
    const text = dutyClaimedText(walk, 'danya', '2026-08-06T16:00:00.000Z', { tz: TZ, nowIso: NOW })
    expect(text).toContain('🐊')
    expect(text).toContain('Следующий раз')
    expect(text).toContain('завтра')
  })
})

describe('dutyBalance', () => {
  it('при перекосе мягко его показывает', () => {
    const s = dutyBalance({ 'duty:danya': 9, 'duty:zhenya': 5 })
    expect(s).toContain('🐊 9')
    expect(s).toContain('🐈‍⬛ 5')
    expect(s).toContain('Всего 14 прогулок')
    expect(s).toContain('Рада не в претензии, но заметила')
  })

  it('при равном счёте говорит другое и тёплое', () => {
    const s = dutyBalance({ 'duty:danya': 7, 'duty:zhenya': 7 })
    expect(s).toContain('Ровно пополам')
    expect(s).toContain('14 прогулок')
    expect(s).not.toContain('не в претензии')
  })

  it('склоняет числительные', () => {
    expect(dutyBalance({ 'duty:danya': 1, 'duty:zhenya': 0 })).toContain('1 прогулка')
    expect(dutyBalance({ 'duty:danya': 2, 'duty:zhenya': 1 })).toContain('3 прогулки')
  })

  it('без данных возвращает null', () => {
    expect(dutyBalance({})).toBe(null)
    expect(dutyBalance(null)).toBe(null)
    expect(dutyBalance({ 'duty:danya': 0, 'duty:zhenya': 0 })).toBe(null)
  })
})

describe('petsOverview', () => {
  it('группирует дела по питомцам и добавляет баланс', async () => {
    vi.spyOn(db, 'tasksByTag').mockResolvedValue([
      { id: 1, title: 'Прогулка с Радой', due_at: '2026-08-05T16:00:00Z', assignee: 'both', status: 'open' },
      { id: 2, title: 'Раде обработка от клещей', due_at: '2026-08-07T09:00:00Z', assignee: 'both', status: 'open' },
      { id: 3, title: 'Покормить Люсю', due_at: '2026-08-05T05:00:00Z', assignee: 'zhenya', status: 'open' },
      { id: 4, title: 'Лоток Масе', due_at: null, assignee: 'danya', status: 'open' },
      { id: 5, title: 'Купить когтеточку', due_at: null, assignee: 'both', status: 'open' },
      { id: 6, title: 'Старая прогулка', due_at: '2026-08-01T16:00:00Z', assignee: 'danya', status: 'done' },
    ])
    vi.spyOn(db, 'allStats').mockResolvedValue({ 'duty:danya': 9, 'duty:zhenya': 5 })

    const text = await petsOverview(env, CHAT, NOW, TZ)

    expect(text).toContain('<b>Рада</b> — 2 дела')
    expect(text).toContain('<b>Люся</b> — 1 дело')
    expect(text).toContain('<b>Мася</b> — 1 дело')
    expect(text).toContain('<b>Общее</b> — 1 дело')
    expect(text).toContain('Рада не в претензии')
    expect(text).not.toContain('Старая прогулка') // закрытые в сводку не идут
    expect(db.tasksByTag).toHaveBeenCalledWith(env.DB, CHAT, PETS_TAG)
  })

  it('на пустом списке не выдумывает дела', async () => {
    const text = await petsOverview(env, CHAT, NOW, TZ)
    expect(text).toContain('Открытых дел нет')
    expect(text).toContain('🐾')
  })
})

describe('VET_TEMPLATES и setupVetSchedule', () => {
  it('набор из пяти дел в формате повторов проекта', () => {
    expect(VET_TEMPLATES).toHaveLength(5)
    for (const t of VET_TEMPLATES) {
      expect(t.repeat_rule).toBe('monthly:D')
      expect(t.daysBefore).toBeGreaterThan(0)
      expect(t.everyMonths).toBeGreaterThan(0)
      expect(typeof t.title).toBe('string')
    }
    expect(vetTemplate('ticks').everyMonths).toBe(1)
    expect(vetTemplate('vaccine').everyMonths).toBe(12)
    expect(vetTemplate('worms').everyMonths).toBe(3)
    expect(vetTemplate('grooming').everyMonths).toBe(2)
    expect(vetTemplate('checkup').everyMonths).toBe(12)
    expect(vetTemplate('ticks').seasonMonths).toEqual([4, 10])
    expect(vetTemplate('нет такого')).toBe(null)
  })

  it('заводит весь набор на питомца с тегом pets и общим владельцем', async () => {
    const start = '2026-04-15T09:00:00Z' // 15 апреля, 12:00 МСК
    const created = await setupVetSchedule(env, CHAT, 'Рада', start, TZ)

    expect(created).toHaveLength(5)
    expect(db.createTask).toHaveBeenCalledTimes(5)

    for (const call of db.createTask.mock.calls) {
      const t = call[1]
      expect(t.tag).toBe(PETS_TAG)
      expect(t.assignee).toBe('both')
      expect(t.chat_id).toBe(CHAT)
      expect(t.repeat_rule).toBe('monthly:15')
      expect(t.title.startsWith('Рада: ')).toBe(true)
    }

    const ticks = db.createTask.mock.calls[0][1]
    expect(ticks.title).toBe('Рада: обработка от клещей и блох')
    expect(ticks.due_at).toBe('2026-05-15T09:00:00.000Z') // +1 месяц, полдень МСК
    expect(ticks.remind_at).toBe('2026-05-08T09:00:00.000Z') // за 7 дней

    const vaccine = db.createTask.mock.calls[1][1]
    expect(vaccine.due_at).toBe('2027-04-15T09:00:00.000Z') // +год

    const worms = db.createTask.mock.calls[2][1]
    expect(worms.due_at).toBe('2026-07-15T09:00:00.000Z') // +квартал
  })

  it('nextVetDue набирает длинный интервал месячными шагами', () => {
    expect(nextVetDue('2026-05-15T09:00:00Z', 1, 'monthly:15', TZ)).toBe('2026-06-15T09:00:00.000Z')
    expect(nextVetDue('2026-05-15T09:00:00Z', 3, 'monthly:15', TZ)).toBe('2026-08-15T09:00:00.000Z')
    expect(nextVetDue('2027-04-15T09:00:00Z', 12, 'monthly:15', TZ)).toBe('2028-04-15T09:00:00.000Z')
    expect(nextVetDue('2026-05-15T09:00:00Z', 12, null, TZ)).toBe(null)
  })
})

describe('vetReminderText', () => {
  const vet = {
    id: 42, chat_id: CHAT, title: 'Рада: обработка от клещей и блох',
    due_at: '2026-05-15T09:00:00Z', assignee: 'both', tag: PETS_TAG,
  }
  const at = '2026-05-08T09:00:00Z'

  it('пишет в дательном падеже и склоняет дни', async () => {
    const text = await vetReminderText(vet, 7, { tz: TZ, nowIso: at })
    expect(text).toContain('Раде через 7 дней обработка от клещей')
    expect(text).toContain('12:00')
    expect(text).toContain('Сезон клещей') // май попадает в апрель–октябрь
  })

  it('в один день пишет «1 день»', async () => {
    const text = await vetReminderText(vet, 1, { tz: TZ, nowIso: at })
    expect(text).toContain('через 1 день ')
  })

  it('показывает последнюю заметку из базы', async () => {
    vi.spyOn(db, 'notesFor').mockResolvedValue([
      { text: 'вес 24 кг, клиника на Ленина', created_at: '2026-04-15T09:00:00Z' },
      { text: 'старая заметка', created_at: '2026-03-15T09:00:00Z' },
    ])
    const text = await vetReminderText(vet, 7, { tz: TZ, nowIso: at, env })
    expect(db.notesFor).toHaveBeenCalledWith(env.DB, 42)
    expect(text).toContain('В прошлый раз: вес 24 кг, клиника на Ленина')
    expect(text).not.toContain('старая заметка')
  })

  it('без имени питомца в названии обходится общей формой', async () => {
    const text = await vetReminderText(
      { id: 9, title: 'Свозить всех на осмотр', due_at: null }, 3, { tz: TZ, nowIso: at },
    )
    expect(text).toContain('Через 3 дня: Свозить всех на осмотр')
  })
})

describe('parseNote и addTaskNote', () => {
  it('берёт текст реплая как есть', () => {
    expect(parseNote('вес 24 кг')).toBe('вес 24 кг')
    expect(parseNote('клиника Айболит, вакцина Нобивак')).toBe('клиника Айболит, вакцина Нобивак')
  })

  it('на пустом возвращает null', () => {
    expect(parseNote('')).toBe(null)
    expect(parseNote('   \n  ')).toBe(null)
    expect(parseNote(null)).toBe(null)
    expect(parseNote(undefined)).toBe(null)
    expect(parseNote(42)).toBe(null)
  })

  it('длинное обрезает до 200 символов', () => {
    const long = 'а'.repeat(300)
    const note = parseNote(long)
    expect(note).toHaveLength(200)
    expect(parseNote(`вес 24 кг ${'!'.repeat(500)}`).length).toBe(200)
  })

  it('срезает служебный префикс и лишние пробелы', () => {
    expect(parseNote('заметка: вес 24 кг')).toBe('вес 24 кг')
    expect(parseNote('запиши вес   24   кг')).toBe('вес 24 кг')
    expect(parseNote('заметка')).toBe('заметка') // одно слово — это и есть заметка
  })

  it('addTaskNote сохраняет и подтверждает', async () => {
    const text = await addTaskNote(env, 42, 'вес 24 кг', NOW)
    expect(db.addNote).toHaveBeenCalledWith(env.DB, 42, 'вес 24 кг', NOW)
    expect(text).toContain('вес 24 кг')
    expect(text).toContain('📝')
  })

  it('addTaskNote на пустом ничего не пишет в базу', async () => {
    expect(await addTaskNote(env, 42, '   ', NOW)).toBe(null)
    expect(db.addNote).not.toHaveBeenCalled()
  })

  it('addTaskNote экранирует опасный текст', async () => {
    const text = await addTaskNote(env, 42, 'вес <b>24</b> кг', NOW)
    expect(text).toContain('&lt;b&gt;24&lt;/b&gt;')
  })
})
