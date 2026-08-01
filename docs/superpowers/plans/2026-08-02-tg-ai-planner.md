# AI-планер в Telegram — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Telegram-бот в общем чате Дани и Жени, который принимает дела человеческим языком, напоминает в срок, ведёт расписание на день/неделю и присылает утренний дайджест — при нулевой стоимости эксплуатации.

**Architecture:** Cloudflare Worker принимает webhook от Telegram и сигнал Cron раз в минуту. Данные — в D1 (SQLite). Разбор текста гибридный: собственный парсер русских дат, Workers AI как подстраховка. Чистые функции (парсер, форматтер, повторы, время) отделены от ввода-вывода и покрываются тестами без инфраструктуры.

**Tech Stack:** JavaScript (ES modules), Cloudflare Workers, D1, Cron Triggers, Workers AI (`@cf/meta/llama-3.1-8b-instruct`), Telegram Bot API, vitest, wrangler.

## Global Constraints

- Стоимость эксплуатации: **0 ₽**. Никаких платных тарифов, никакой привязки карты. Любая зависимость, требующая оплаты, — нарушение.
- Часовой пояс чата по умолчанию: `Europe/Moscow`. Время в базе — **строго UTC ISO-8601** (`2026-08-05T12:00:00Z`), в интерфейсе — местное.
- Дайджест по умолчанию: `10:00` местного времени. Напоминание заранее по умолчанию: `30` минут.
- Язык интерфейса бота — русский. Обращение к пользователям — на «ты».
- Никаких ИИ-клише и канцелярита в текстах бота. Числительные склонять правильно: «1 дело», «2 дела», «5 дел».
- Секреты (`BOT_TOKEN`, `WEBHOOK_SECRET`) — только в секретах Cloudflare, никогда в git.
- Роли пользователей: `danya` | `zhenya`. Ответственный (`assignee`): `danya` | `zhenya` | `both`.
- Статусы задач: `open` | `done` | `cancelled`.
- Формат `repeat_rule`: `daily` | `weekly:<0-6>` (0=воскресенье) | `monthly:<1-31>` | `weekdays`.
- Каждый модуль в `src/` экспортирует только именованные экспорты (named exports), без `default`.
- Тесты рядом с кодом: `test/<имя-модуля>.test.js`.

---

## Файловая структура

| Файл | Ответственность |
|---|---|
| `wrangler.toml` | Конфигурация Worker: биндинги D1, AI, cron, переменные |
| `migrations/0001_init.sql` | Схема базы |
| `src/time.js` | Работа с часовыми поясами: местное ↔ UTC, начало дня, форматирование |
| `src/parse/ru-dates.js` | Парсер русских дат, времени и повторов. Чистая функция |
| `src/repeat.js` | Следующий срок для повторяющегося дела. Чистая функция |
| `src/format.js` | Тексты и клавиатуры сообщений. Чистые функции |
| `src/db.js` | Все SQL-запросы к D1 |
| `src/telegram.js` | Клиент Bot API |
| `src/parse/ai.js` | Разбор через Workers AI, строгий JSON |
| `src/parse/index.js` | Оркестратор разбора: свой парсер → AI → переспросить |
| `src/assignee.js` | Определение ответственного по тексту и автору |
| `src/tasks.js` | Создание дела из текста — общая логика для бота и для внешнего API |
| `src/router.js` | Маршрутизация: команды, новое дело, нажатия кнопок |
| `src/reminders.js` | Напоминания и дайджест по cron |
| `src/api.js` | HTTP API: добавление и просмотр дел извне (из Claude Code) |
| `src/index.js` | Точка входа, проверка секрета и белого списка |
| `scripts/planer.mjs` | CLI: `npm run add -- "текст"`, `npm run list` |
| `SETUP.md` | Инструкция для Дани: BotFather, Cloudflare, деплой |

---

### Task 1: Скелет проекта и база

**Files:**
- Create: `package.json`, `wrangler.toml`, `vitest.config.js`, `migrations/0001_init.sql`, `src/index.js`, `test/smoke.test.js`

**Interfaces:**
- Consumes: ничего
- Produces: рабочий `npm test`, схема БД, заготовка `fetch`/`scheduled` в `src/index.js`

- [ ] **Step 1: Создать `package.json`**

```json
{
  "name": "tg-planner",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "db:local": "wrangler d1 migrations apply tg-planner --local",
    "db:remote": "wrangler d1 migrations apply tg-planner --remote"
  },
  "devDependencies": {
    "vitest": "^3.2.4",
    "wrangler": "^4.42.0"
  }
}
```

- [ ] **Step 2: Создать `wrangler.toml`**

`database_id` заполняется на Task 12 после создания базы — до тех пор оставить строку как есть.

```toml
name = "tg-planner"
main = "src/index.js"
compatibility_date = "2026-01-01"

[vars]
DEFAULT_TZ = "Europe/Moscow"
DEFAULT_DIGEST_TIME = "10:00"
DEFAULT_REMIND_BEFORE_MIN = "30"
AI_MODEL = "@cf/meta/llama-3.1-8b-instruct"
AI_ENABLED = "true"

[[d1_databases]]
binding = "DB"
database_name = "tg-planner"
database_id = "PLACEHOLDER_FILL_ON_DEPLOY"

[ai]
binding = "AI"

[triggers]
crons = ["* * * * *"]
```

- [ ] **Step 3: Создать `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
})
```

- [ ] **Step 4: Создать `migrations/0001_init.sql`**

```sql
CREATE TABLE IF NOT EXISTS chats (
  chat_id            INTEGER PRIMARY KEY,
  tz                 TEXT    NOT NULL DEFAULT 'Europe/Moscow',
  digest_time        TEXT    NOT NULL DEFAULT '10:00',
  digest_enabled     INTEGER NOT NULL DEFAULT 1,
  remind_before_min  INTEGER NOT NULL DEFAULT 30,
  last_digest_date   TEXT
);

CREATE TABLE IF NOT EXISTS users (
  tg_user_id INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  alias      TEXT    NOT NULL,
  role       TEXT    NOT NULL,
  PRIMARY KEY (tg_user_id, chat_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       INTEGER NOT NULL,
  title         TEXT    NOT NULL,
  due_at        TEXT,
  remind_at     TEXT,
  assignee      TEXT    NOT NULL DEFAULT 'both',
  created_by    INTEGER NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'open',
  repeat_rule   TEXT,
  parent_id     INTEGER,
  notified_pre  INTEGER NOT NULL DEFAULT 0,
  notified_due  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_due   ON tasks (chat_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_pre   ON tasks (status, notified_pre, remind_at);
CREATE INDEX IF NOT EXISTS idx_tasks_fire  ON tasks (status, notified_due, due_at);

CREATE TABLE IF NOT EXISTS seen_updates (
  update_id INTEGER PRIMARY KEY,
  seen_at   TEXT NOT NULL
);
```

- [ ] **Step 5: Создать заготовку `src/index.js`**

```js
export default {
  async fetch(request, env, ctx) {
    return new Response('ok')
  },
  async scheduled(event, env, ctx) {
    // наполняется в Task 11
  },
}
```

- [ ] **Step 6: Написать проверочный тест `test/smoke.test.js`**

```js
import { describe, it, expect } from 'vitest'
import worker from '../src/index.js'

describe('worker', () => {
  it('отвечает на любой запрос', async () => {
    const res = await worker.fetch(new Request('https://x/'), {}, {})
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 7: Установить зависимости и запустить тесты**

Run: `npm install && npm test`
Expected: PASS, 1 тест

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: скелет проекта, конфиг Worker и схема базы"
```

---

### Task 2: Модуль времени

**Files:**
- Create: `src/time.js`, `test/time.test.js`

**Interfaces:**
- Consumes: ничего
- Produces:
  - `tzOffsetMinutes(tz, date) -> number` — смещение зоны в минутах относительно UTC
  - `localParts(iso, tz) -> {year, month, day, hour, minute, weekday}` (month 1-12, weekday 0=вс)
  - `localToUtcIso({year, month, day, hour, minute}, tz) -> string` — ISO с `Z`
  - `startOfLocalDay(iso, tz) -> string` — UTC ISO момента 00:00 местного дня
  - `addDays(iso, n) -> string`, `addMinutes(iso, n) -> string`
  - `localDateKey(iso, tz) -> string` — `'2026-08-05'`
  - `formatTime(iso, tz) -> string` — `'15:00'`
  - `formatDateHuman(iso, tz, nowIso) -> string` — `'сегодня, 5 августа'` / `'завтра, 6 августа'` / `'вторник, 12 августа'`

- [ ] **Step 1: Написать падающие тесты `test/time.test.js`**

```js
import { describe, it, expect } from 'vitest'
import {
  tzOffsetMinutes, localParts, localToUtcIso, startOfLocalDay,
  addDays, addMinutes, localDateKey, formatTime, formatDateHuman,
} from '../src/time.js'

const MSK = 'Europe/Moscow'

describe('time', () => {
  it('смещение Москвы +180 минут', () => {
    expect(tzOffsetMinutes(MSK, new Date('2026-08-02T12:00:00Z'))).toBe(180)
    expect(tzOffsetMinutes(MSK, new Date('2026-01-02T12:00:00Z'))).toBe(180)
  })

  it('разбирает UTC в местные части', () => {
    expect(localParts('2026-08-05T12:00:00Z', MSK)).toEqual({
      year: 2026, month: 8, day: 5, hour: 15, minute: 0, weekday: 3,
    })
  })

  it('собирает местное время обратно в UTC', () => {
    expect(localToUtcIso({ year: 2026, month: 8, day: 5, hour: 15, minute: 0 }, MSK))
      .toBe('2026-08-05T12:00:00.000Z')
  })

  it('переход через полночь местного времени', () => {
    expect(localToUtcIso({ year: 2026, month: 8, day: 5, hour: 1, minute: 30 }, MSK))
      .toBe('2026-08-04T22:30:00.000Z')
  })

  it('начало местного дня', () => {
    expect(startOfLocalDay('2026-08-05T12:00:00Z', MSK)).toBe('2026-08-04T21:00:00.000Z')
  })

  it('сдвиги', () => {
    expect(addDays('2026-08-05T12:00:00Z', 1)).toBe('2026-08-06T12:00:00.000Z')
    expect(addMinutes('2026-08-05T12:00:00Z', 90)).toBe('2026-08-05T13:30:00.000Z')
  })

  it('ключ местной даты', () => {
    expect(localDateKey('2026-08-05T22:30:00Z', MSK)).toBe('2026-08-06')
  })

  it('время местное', () => {
    expect(formatTime('2026-08-05T12:00:00Z', MSK)).toBe('15:00')
  })

  it('человеческая дата', () => {
    const now = '2026-08-05T09:00:00Z'
    expect(formatDateHuman('2026-08-05T12:00:00Z', MSK, now)).toBe('сегодня, 5 августа')
    expect(formatDateHuman('2026-08-06T12:00:00Z', MSK, now)).toBe('завтра, 6 августа')
    expect(formatDateHuman('2026-08-12T12:00:00Z', MSK, now)).toBe('среда, 12 августа')
  })
})
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npx vitest run test/time.test.js`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/time.js`**

Смещение зоны считается через `Intl.DateTimeFormat` с `timeZone` — так работает в Workers и не требует таблиц зон.

```js
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const WEEKDAYS_NOM = ['воскресенье', 'понедельник', 'вторник', 'среда',
  'четверг', 'пятница', 'суббота']

const fmtCache = new Map()
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }))
  }
  return fmtCache.get(tz)
}

function partsMap(tz, date) {
  const out = {}
  for (const p of fmt(tz).formatToParts(date)) {
    if (p.type !== 'literal') out[p.type] = p.value
  }
  return out
}

export function tzOffsetMinutes(tz, date = new Date()) {
  const p = partsMap(tz, date)
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    hour, Number(p.minute), Number(p.second))
  return Math.round((asUtc - date.getTime()) / 60000)
}

export function localParts(iso, tz) {
  const date = new Date(iso)
  const p = partsMap(tz, date)
  const hour = p.hour === '24' ? 0 : Number(p.hour)
  const shifted = new Date(date.getTime() + tzOffsetMinutes(tz, date) * 60000)
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day),
    hour, minute: Number(p.minute), weekday: shifted.getUTCDay(),
  }
}

export function localToUtcIso({ year, month, day, hour = 0, minute = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  let ts = guess - tzOffsetMinutes(tz, new Date(guess)) * 60000
  ts = guess - tzOffsetMinutes(tz, new Date(ts)) * 60000
  return new Date(ts).toISOString()
}

export function startOfLocalDay(iso, tz) {
  const { year, month, day } = localParts(iso, tz)
  return localToUtcIso({ year, month, day, hour: 0, minute: 0 }, tz)
}

export function addDays(iso, n) {
  return new Date(new Date(iso).getTime() + n * 86400000).toISOString()
}

export function addMinutes(iso, n) {
  return new Date(new Date(iso).getTime() + n * 60000).toISOString()
}

export function localDateKey(iso, tz) {
  const { year, month, day } = localParts(iso, tz)
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function formatTime(iso, tz) {
  const { hour, minute } = localParts(iso, tz)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function formatDateHuman(iso, tz, nowIso) {
  const target = localDateKey(iso, tz)
  const today = localDateKey(nowIso, tz)
  const tomorrow = localDateKey(addDays(startOfLocalDay(nowIso, tz), 1), tz)
  const { day, month, weekday } = localParts(iso, tz)
  const tail = `${day} ${MONTHS_GEN[month - 1]}`
  if (target === today) return `сегодня, ${tail}`
  if (target === tomorrow) return `завтра, ${tail}`
  return `${WEEKDAYS_NOM[weekday]}, ${tail}`
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npx vitest run test/time.test.js`
Expected: PASS, 9 тестов

- [ ] **Step 5: Commit**

```bash
git add src/time.js test/time.test.js
git commit -m "feat: модуль работы с часовыми поясами"
```

---

### Task 3: Парсер русских дат

**Files:**
- Create: `src/parse/ru-dates.js`, `test/ru-dates.test.js`

**Interfaces:**
- Consumes: `src/time.js` (`localParts`, `localToUtcIso`, `addDays`, `startOfLocalDay`)
- Produces: `parseRu(text, nowIso, tz) -> {title, dueAt, repeatRule, matched} | null`
  - `dueAt` — UTC ISO или `null`; `repeatRule` — строка формата из Global Constraints или `null`
  - `matched: true`, если распознана дата **или** повтор; `null` возвращается только если текст пустой
  - `title` — исходный текст без распознанных временных фрагментов, с заглавной буквы

- [ ] **Step 1: Написать падающие тесты `test/ru-dates.test.js`**

Все тесты с зафиксированным «сейчас»: среда 5 августа 2026, 12:00 МСК (`2026-08-05T09:00:00Z`).

```js
import { describe, it, expect } from 'vitest'
import { parseRu } from '../src/parse/ru-dates.js'

const TZ = 'Europe/Moscow'
const NOW = '2026-08-05T09:00:00Z' // ср, 5 авг 2026, 12:00 МСК

const p = (text) => parseRu(text, NOW, TZ)

describe('parseRu: относительные дни', () => {
  it('завтра в 15:00', () => {
    const r = p('завтра в 15:00 к врачу')
    expect(r.dueAt).toBe('2026-08-06T12:00:00.000Z')
    expect(r.title).toBe('К врачу')
  })

  it('сегодня вечером -> 19:00', () => {
    expect(p('сегодня вечером позвонить маме').dueAt).toBe('2026-08-05T16:00:00.000Z')
  })

  it('послезавтра без времени -> 09:00 по умолчанию', () => {
    expect(p('послезавтра забрать посылку').dueAt).toBe('2026-08-07T06:00:00.000Z')
  })

  it('через 2 часа', () => {
    expect(p('через 2 часа выключить духовку').dueAt).toBe('2026-08-05T11:00:00.000Z')
  })

  it('через 20 минут', () => {
    expect(p('через 20 минут проверить тесто').dueAt).toBe('2026-08-05T09:20:00.000Z')
  })

  it('через неделю', () => {
    expect(p('через неделю оплатить интернет').dueAt).toBe('2026-08-12T09:00:00.000Z')
  })
})

describe('parseRu: дни недели', () => {
  it('в пятницу -> ближайшая будущая пятница', () => {
    expect(p('в пятницу в 18:00 ужин').dueAt).toBe('2026-08-07T15:00:00.000Z')
  })

  it('в среду, когда сегодня среда и время уже прошло -> следующая среда', () => {
    expect(p('в среду в 10:00 созвон').dueAt).toBe('2026-08-12T07:00:00.000Z')
  })

  it('в среду, когда сегодня среда и время ещё впереди -> сегодня', () => {
    expect(p('в среду в 20:00 созвон').dueAt).toBe('2026-08-05T17:00:00.000Z')
  })

  it('сокращение «в пн»', () => {
    expect(p('в пн в 9 к стоматологу').dueAt).toBe('2026-08-10T06:00:00.000Z')
  })
})

describe('parseRu: явные даты', () => {
  it('5 марта -> следующий год, т.к. дата прошла', () => {
    expect(p('5 марта день рождения').dueAt).toBe('2027-03-05T06:00:00.000Z')
  })

  it('31 декабря', () => {
    expect(p('31 декабря в 23:00 шампанское').dueAt).toBe('2026-12-31T20:00:00.000Z')
  })

  it('15.08 в 16:00', () => {
    expect(p('15.08 в 16:00 свадьба').dueAt).toBe('2026-08-15T13:00:00.000Z')
  })

  it('15.08.2027', () => {
    expect(p('15.08.2027 годовщина').dueAt).toBe('2027-08-15T06:00:00.000Z')
  })
})

describe('parseRu: время', () => {
  it('«в 15» без минут', () => {
    expect(p('завтра в 15 к врачу').dueAt).toBe('2026-08-06T12:00:00.000Z')
  })

  it('«в 15.30»', () => {
    expect(p('завтра в 15.30 к врачу').dueAt).toBe('2026-08-06T12:30:00.000Z')
  })

  it('«в полтретьего» -> 14:30', () => {
    expect(p('завтра в полтретьего кофе').dueAt).toBe('2026-08-06T11:30:00.000Z')
  })

  it('«утром» -> 09:00', () => {
    expect(p('завтра утром зарядка').dueAt).toBe('2026-08-06T06:00:00.000Z')
  })

  it('«днём» -> 14:00', () => {
    expect(p('завтра днём обед с Лерой').dueAt).toBe('2026-08-06T11:00:00.000Z')
  })

  it('«ночью» -> 23:00', () => {
    expect(p('завтра ночью посмотреть метеоры').dueAt).toBe('2026-08-06T20:00:00.000Z')
  })
})

describe('parseRu: повторы', () => {
  it('каждый вторник', () => {
    const r = p('каждый вторник вынести мусор')
    expect(r.repeatRule).toBe('weekly:2')
    expect(r.title).toBe('Вынести мусор')
    expect(r.dueAt).toBe('2026-08-11T06:00:00.000Z')
  })

  it('каждый день в 8', () => {
    const r = p('каждый день в 8 витамины')
    expect(r.repeatRule).toBe('daily')
    expect(r.dueAt).toBe('2026-08-06T05:00:00.000Z')
  })

  it('каждое 5-е число', () => {
    const r = p('каждое 5-е число оплатить квартиру')
    expect(r.repeatRule).toBe('monthly:5')
    expect(r.dueAt).toBe('2026-09-05T06:00:00.000Z')
  })

  it('по будням', () => {
    expect(p('по будням в 7:30 будильник').repeatRule).toBe('weekdays')
  })
})

describe('parseRu: без даты', () => {
  it('дело без срока', () => {
    const r = p('купить корм коту')
    expect(r.dueAt).toBeNull()
    expect(r.matched).toBe(false)
    expect(r.title).toBe('Купить корм коту')
  })

  it('пустой текст', () => {
    expect(p('   ')).toBeNull()
  })

  it('не съедает часть названия', () => {
    expect(p('завтра в 15:00 к врачу на приём').title).toBe('К врачу на приём')
  })
})
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npx vitest run test/ru-dates.test.js`
Expected: FAIL — модуль не найден

- [ ] **Step 3: Реализовать `src/parse/ru-dates.js`**

Порядок работы: сначала вырезаем повтор, затем дату, затем время; остаток — название.
Время по умолчанию, если дата есть, а времени нет: 09:00 местного.

```js
import { localParts, localToUtcIso, addDays, addMinutes, startOfLocalDay } from '../time.js'

const DEFAULT_HOUR = 9
const WEEKDAYS = {
  'воскресень': 0, 'вс': 0, 'понедельник': 1, 'понедельника': 1, 'пн': 1,
  'вторник': 2, 'вторника': 2, 'вт': 2, 'сред': 3, 'ср': 3,
  'четверг': 4, 'четверга': 4, 'чт': 4, 'пятниц': 5, 'пт': 5,
  'суббот': 6, 'сб': 6,
}
const MONTHS = {
  'январ': 1, 'феврал': 2, 'март': 3, 'апрел': 4, 'ма': 5, 'июн': 6,
  'июл': 7, 'август': 8, 'сентябр': 9, 'октябр': 10, 'ноябр': 11, 'декабр': 12,
}
const DAYPARTS = { 'утром': 9, 'днём': 14, 'днем': 14, 'вечером': 19, 'ночью': 23 }
const HALF_HOURS = {
  'полпервого': 0.5, 'полвторого': 1.5, 'полтретьего': 2.5, 'полчетвёртого': 3.5,
  'полчетвертого': 3.5, 'полпятого': 4.5, 'полшестого': 5.5, 'полседьмого': 6.5,
  'полвосьмого': 7.5, 'полдевятого': 8.5, 'полдесятого': 9.5,
  'полодиннадцатого': 10.5, 'полдвенадцатого': 11.5,
}

const cut = (text, re) => {
  const m = text.match(re)
  if (!m) return [null, text]
  return [m, text.replace(m[0], ' ')]
}

function weekdayCode(word) {
  const w = word.toLowerCase()
  for (const [stem, code] of Object.entries(WEEKDAYS)) {
    if (w.startsWith(stem)) return code
  }
  return null
}

function monthCode(word) {
  const w = word.toLowerCase()
  for (const [stem, code] of Object.entries(MONTHS)) {
    if (w.startsWith(stem)) return code
  }
  return null
}

function extractRepeat(text) {
  let rest = text
  let rule = null
  let weekday = null
  let monthDay = null

  let m
  ;[m, rest] = cut(rest, /\bпо\s+будням\b/i)
  if (m) rule = 'weekdays'

  if (!rule) {
    ;[m, rest] = cut(rest, /\bкажд(?:ый|ую|ое|ые)\s+(\d{1,2})[-\s]?[ое]?\s*числ[оа]\b/i)
    if (m) { rule = `monthly:${Number(m[1])}`; monthDay = Number(m[1]) }
  }
  if (!rule) {
    ;[m, rest] = cut(rest, /\bкажд(?:ый|ую|ое)\s+([а-яё]+)/i)
    if (m) {
      const word = m[1].toLowerCase()
      if (word === 'день' || word === 'дня') rule = 'daily'
      else {
        const wd = weekdayCode(word)
        if (wd !== null) { rule = `weekly:${wd}`; weekday = wd }
        else rest = text // не поняли — вернуть как было
      }
    }
  }
  return { rule, rest, weekday, monthDay }
}

function extractTime(text) {
  let rest = text
  let m

  ;[m, rest] = cut(rest, new RegExp(`\\b(${Object.keys(HALF_HOURS).join('|')})\\b`, 'i'))
  if (m) {
    const v = HALF_HOURS[m[1].toLowerCase()]
    let hour = Math.floor(v)
    if (hour < 8) hour += 12 // полтретьего — про день
    return { hour, minute: 30, rest }
  }

  ;[m, rest] = cut(rest, /\bв\s+(\d{1,2})[:.](\d{2})\b/i)
  if (m) return { hour: Number(m[1]), minute: Number(m[2]), rest }

  ;[m, rest] = cut(rest, /\b(\d{1,2})[:.](\d{2})\b/)
  if (m) return { hour: Number(m[1]), minute: Number(m[2]), rest }

  ;[m, rest] = cut(rest, /\bв\s+(\d{1,2})(?!\d)\b/i)
  if (m) return { hour: Number(m[1]), minute: 0, rest }

  ;[m, rest] = cut(rest, new RegExp(`\\b(${Object.keys(DAYPARTS).join('|')})\\b`, 'i'))
  if (m) return { hour: DAYPARTS[m[1].toLowerCase()], minute: 0, rest }

  return { hour: null, minute: null, rest }
}

function extractDate(text, nowIso, tz) {
  let rest = text
  let m

  ;[m, rest] = cut(rest, /\bпослезавтра\b/i)
  if (m) return { kind: 'day', shift: 2, rest }

  ;[m, rest] = cut(rest, /\bзавтра\b/i)
  if (m) return { kind: 'day', shift: 1, rest }

  ;[m, rest] = cut(rest, /\bсегодня\b/i)
  if (m) return { kind: 'day', shift: 0, rest }

  ;[m, rest] = cut(rest, /\bчерез\s+(\d+)\s*(минут|минуты|мин|час|часа|часов|день|дня|дней|недел[юия]|месяц[а]?)\b/i)
  if (m) return { kind: 'relative', amount: Number(m[1]), unit: m[2].toLowerCase(), rest }

  ;[m, rest] = cut(rest, /\bчерез\s+(недел[юи]|час|день|месяц)\b/i)
  if (m) return { kind: 'relative', amount: 1, unit: m[1].toLowerCase(), rest }

  ;[m, rest] = cut(rest, /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/)
  if (m) return { kind: 'exact', day: +m[1], month: +m[2], year: +m[3], rest }

  ;[m, rest] = cut(rest, /\b(\d{1,2})\.(\d{1,2})(?!\d)\b/)
  if (m) return { kind: 'exact', day: +m[1], month: +m[2], rest }

  ;[m, rest] = cut(rest, /\b(\d{1,2})\s+([а-яё]{3,})\b/i)
  if (m) {
    const month = monthCode(m[2])
    if (month) return { kind: 'exact', day: +m[1], month, rest }
    rest = text
  }

  ;[m, rest] = cut(rest, /\b(?:в|во)\s+([а-яё]{2,})\b/i)
  if (m) {
    const wd = weekdayCode(m[1])
    if (wd !== null) return { kind: 'weekday', weekday: wd, rest }
    rest = text
  }

  return { kind: null, rest }
}

function cleanTitle(text) {
  const t = text.replace(/\s+/g, ' ').replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, '')
  return t ? t[0].toUpperCase() + t.slice(1) : ''
}

export function parseRu(text, nowIso, tz) {
  if (!text || !text.trim()) return null

  const rep = extractRepeat(text)
  const dateRes = extractDate(rep.rest, nowIso, tz)
  const timeRes = extractTime(dateRes.rest)
  const title = cleanTitle(timeRes.rest)

  const now = localParts(nowIso, tz)
  const hour = timeRes.hour ?? DEFAULT_HOUR
  const minute = timeRes.minute ?? 0
  const hasTime = timeRes.hour !== null

  let dueAt = null

  if (dateRes.kind === 'relative') {
    const u = dateRes.unit
    if (u.startsWith('мин')) dueAt = addMinutes(nowIso, dateRes.amount)
    else if (u.startsWith('час')) dueAt = addMinutes(nowIso, dateRes.amount * 60)
    else if (u.startsWith('д')) dueAt = addDays(nowIso, dateRes.amount)
    else if (u.startsWith('недел')) dueAt = addDays(nowIso, dateRes.amount * 7)
    else if (u.startsWith('месяц')) dueAt = addDays(nowIso, dateRes.amount * 30)
    if (hasTime) {
      const d = localParts(dueAt, tz)
      dueAt = localToUtcIso({ year: d.year, month: d.month, day: d.day, hour, minute }, tz)
    }
  } else if (dateRes.kind === 'day') {
    const base = localParts(addDays(startOfLocalDay(nowIso, tz), dateRes.shift), tz)
    dueAt = localToUtcIso({ year: base.year, month: base.month, day: base.day, hour, minute }, tz)
  } else if (dateRes.kind === 'weekday') {
    let shift = (dateRes.weekday - now.weekday + 7) % 7
    const candidate = localParts(addDays(startOfLocalDay(nowIso, tz), shift), tz)
    let iso = localToUtcIso({ year: candidate.year, month: candidate.month, day: candidate.day, hour, minute }, tz)
    if (new Date(iso) <= new Date(nowIso)) {
      const next = localParts(addDays(startOfLocalDay(nowIso, tz), shift + 7), tz)
      iso = localToUtcIso({ year: next.year, month: next.month, day: next.day, hour, minute }, tz)
    }
    dueAt = iso
  } else if (dateRes.kind === 'exact') {
    const year = dateRes.year ?? now.year
    let iso = localToUtcIso({ year, month: dateRes.month, day: dateRes.day, hour, minute }, tz)
    if (!dateRes.year && new Date(iso) < new Date(nowIso)) {
      iso = localToUtcIso({ year: year + 1, month: dateRes.month, day: dateRes.day, hour, minute }, tz)
    }
    dueAt = iso
  } else if (rep.rule) {
    dueAt = firstOccurrence(rep, { hour, minute }, nowIso, tz)
  } else if (hasTime) {
    let iso = localToUtcIso({ year: now.year, month: now.month, day: now.day, hour, minute }, tz)
    if (new Date(iso) <= new Date(nowIso)) iso = addDays(iso, 1)
    dueAt = iso
  }

  if (rep.rule && dateRes.kind === null && dueAt === null) {
    dueAt = firstOccurrence(rep, { hour, minute }, nowIso, tz)
  }

  return {
    title,
    dueAt,
    repeatRule: rep.rule,
    matched: Boolean(dueAt || rep.rule),
  }
}

function firstOccurrence(rep, { hour, minute }, nowIso, tz) {
  const now = localParts(nowIso, tz)
  const at = (shiftDays) => {
    const d = localParts(addDays(startOfLocalDay(nowIso, tz), shiftDays), tz)
    return localToUtcIso({ year: d.year, month: d.month, day: d.day, hour, minute }, tz)
  }
  if (rep.rule === 'daily' || rep.rule === 'weekdays') {
    for (let i = 0; i < 8; i++) {
      const iso = at(i)
      if (new Date(iso) > new Date(nowIso)) {
        if (rep.rule === 'weekdays') {
          const wd = localParts(iso, tz).weekday
          if (wd === 0 || wd === 6) continue
        }
        return iso
      }
    }
  }
  if (rep.rule?.startsWith('weekly:')) {
    const target = Number(rep.rule.split(':')[1])
    for (let i = 0; i < 15; i++) {
      const iso = at(i)
      if (localParts(iso, tz).weekday === target && new Date(iso) > new Date(nowIso)) return iso
    }
  }
  if (rep.rule?.startsWith('monthly:')) {
    const day = Number(rep.rule.split(':')[1])
    let iso = localToUtcIso({ year: now.year, month: now.month, day, hour, minute }, tz)
    if (new Date(iso) <= new Date(nowIso)) {
      const nextMonth = now.month === 12 ? 1 : now.month + 1
      const nextYear = now.month === 12 ? now.year + 1 : now.year
      iso = localToUtcIso({ year: nextYear, month: nextMonth, day, hour, minute }, tz)
    }
    return iso
  }
  return null
}
```

- [ ] **Step 4: Запустить тесты и довести до зелёного**

Run: `npx vitest run test/ru-dates.test.js`
Expected: PASS, 24 теста. Если какой-то кейс падает — чинить реализацию, а не подгонять тест под неё.

- [ ] **Step 5: Commit**

```bash
git add src/parse/ru-dates.js test/ru-dates.test.js
git commit -m "feat: парсер русских дат, времени и повторов"
```

---

### Task 4: Повторяющиеся дела

**Files:**
- Create: `src/repeat.js`, `test/repeat.test.js`

**Interfaces:**
- Consumes: `src/time.js`
- Produces: `nextOccurrence(dueAtIso, repeatRule, tz) -> string | null` — следующий срок строго после `dueAtIso`, время суток сохраняется

- [ ] **Step 1: Написать падающие тесты `test/repeat.test.js`**

```js
import { describe, it, expect } from 'vitest'
import { nextOccurrence } from '../src/repeat.js'

const TZ = 'Europe/Moscow'

describe('nextOccurrence', () => {
  it('ежедневно', () => {
    expect(nextOccurrence('2026-08-05T05:00:00Z', 'daily', TZ)).toBe('2026-08-06T05:00:00.000Z')
  })

  it('еженедельно во вторник', () => {
    expect(nextOccurrence('2026-08-11T06:00:00Z', 'weekly:2', TZ)).toBe('2026-08-18T06:00:00.000Z')
  })

  it('по будням: с пятницы на понедельник', () => {
    expect(nextOccurrence('2026-08-07T04:30:00Z', 'weekdays', TZ)).toBe('2026-08-10T04:30:00.000Z')
  })

  it('ежемесячно 5-го', () => {
    expect(nextOccurrence('2026-08-05T06:00:00Z', 'monthly:5', TZ)).toBe('2026-09-05T06:00:00.000Z')
  })

  it('ежемесячно 31-го: в коротком месяце берём последний день', () => {
    expect(nextOccurrence('2026-08-31T06:00:00Z', 'monthly:31', TZ)).toBe('2026-09-30T06:00:00.000Z')
  })

  it('декабрь -> январь следующего года', () => {
    expect(nextOccurrence('2026-12-05T06:00:00Z', 'monthly:5', TZ)).toBe('2027-01-05T06:00:00.000Z')
  })

  it('без правила -> null', () => {
    expect(nextOccurrence('2026-08-05T06:00:00Z', null, TZ)).toBeNull()
  })
})
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npx vitest run test/repeat.test.js`
Expected: FAIL

- [ ] **Step 3: Реализовать `src/repeat.js`**

```js
import { localParts, localToUtcIso, addDays } from './time.js'

const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate()

export function nextOccurrence(dueAtIso, repeatRule, tz) {
  if (!dueAtIso || !repeatRule) return null
  const { hour, minute } = localParts(dueAtIso, tz)

  if (repeatRule === 'daily') return addDays(dueAtIso, 1)

  if (repeatRule === 'weekdays') {
    let iso = addDays(dueAtIso, 1)
    for (let i = 0; i < 7; i++) {
      const wd = localParts(iso, tz).weekday
      if (wd !== 0 && wd !== 6) return iso
      iso = addDays(iso, 1)
    }
    return null
  }

  if (repeatRule.startsWith('weekly:')) return addDays(dueAtIso, 7)

  if (repeatRule.startsWith('monthly:')) {
    const wanted = Number(repeatRule.split(':')[1])
    const { year, month } = localParts(dueAtIso, tz)
    const nextMonth = month === 12 ? 1 : month + 1
    const nextYear = month === 12 ? year + 1 : year
    const day = Math.min(wanted, daysInMonth(nextYear, nextMonth))
    return localToUtcIso({ year: nextYear, month: nextMonth, day, hour, minute }, tz)
  }

  return null
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npx vitest run test/repeat.test.js`
Expected: PASS, 7 тестов

- [ ] **Step 5: Commit**

```bash
git add src/repeat.js test/repeat.test.js
git commit -m "feat: расчёт следующего срока для повторяющихся дел"
```

---

### Task 5: Оформление сообщений

**Files:**
- Create: `src/format.js`, `test/format.test.js`

**Interfaces:**
- Consumes: `src/time.js`
- Produces:
  - `plural(n, one, few, many) -> string` — «1 дело», «2 дела», «5 дел»
  - `taskCard(task, {tz, nowIso}) -> {text, reply_markup}`
  - `taskKeyboard(taskId) -> object`
  - `snoozeKeyboard(taskId) -> object`
  - `dayList(tasks, {tz, nowIso, title}) -> string`
  - `weekList(tasks, {tz, nowIso}) -> string`
  - `digest(tasks, overdue, {tz, nowIso}) -> string`
  - `reminderText(task, {tz, nowIso, kind}) -> string` — `kind`: `'pre'` | `'due'`
  - `ASSIGNEE_LABEL = {danya: 'Даня', zhenya: 'Женя', both: 'Оба'}`

Тексты — с эмодзи, HTML-разметка Telegram (`parse_mode: 'HTML'`), без ИИ-клише.

- [ ] **Step 1: Написать падающие тесты `test/format.test.js`**

```js
import { describe, it, expect } from 'vitest'
import { plural, taskCard, dayList, weekList, digest, reminderText } from '../src/format.js'

const TZ = 'Europe/Moscow'
const NOW = '2026-08-05T09:00:00Z'

const task = (over = {}) => ({
  id: 1, title: 'К врачу', due_at: '2026-08-06T12:00:00Z',
  assignee: 'danya', status: 'open', repeat_rule: null, ...over,
})

describe('plural', () => {
  it('склоняет дела', () => {
    expect(plural(1, 'дело', 'дела', 'дел')).toBe('1 дело')
    expect(plural(2, 'дело', 'дела', 'дел')).toBe('2 дела')
    expect(plural(5, 'дело', 'дела', 'дел')).toBe('5 дел')
    expect(plural(11, 'дело', 'дела', 'дел')).toBe('11 дел')
    expect(plural(22, 'дело', 'дела', 'дел')).toBe('22 дела')
    expect(plural(101, 'дело', 'дела', 'дел')).toBe('101 дело')
  })
})

describe('taskCard', () => {
  it('содержит название, дату и ответственного', () => {
    const card = taskCard(task(), { tz: TZ, nowIso: NOW })
    expect(card.text).toContain('К врачу')
    expect(card.text).toContain('завтра, 6 августа')
    expect(card.text).toContain('15:00')
    expect(card.text).toContain('Даня')
    expect(card.reply_markup.inline_keyboard[0][0].callback_data).toBe('done:1')
  })

  it('дело без срока не показывает время', () => {
    const card = taskCard(task({ due_at: null }), { tz: TZ, nowIso: NOW })
    expect(card.text).toContain('без срока')
  })

  it('повторяющееся дело помечено', () => {
    const card = taskCard(task({ repeat_rule: 'weekly:2' }), { tz: TZ, nowIso: NOW })
    expect(card.text).toContain('каждый вторник')
  })
})

describe('dayList', () => {
  it('пустой день', () => {
    expect(dayList([], { tz: TZ, nowIso: NOW, title: 'Сегодня' })).toContain('пусто')
  })

  it('сортирует по времени', () => {
    const text = dayList([
      task({ id: 2, title: 'Вечер', due_at: '2026-08-05T16:00:00Z' }),
      task({ id: 3, title: 'Утро', due_at: '2026-08-05T06:00:00Z' }),
    ], { tz: TZ, nowIso: NOW, title: 'Сегодня' })
    expect(text.indexOf('Утро')).toBeLessThan(text.indexOf('Вечер'))
  })
})

describe('weekList', () => {
  it('группирует по дням', () => {
    const text = weekList([
      task({ id: 2, title: 'Первое', due_at: '2026-08-05T06:00:00Z' }),
      task({ id: 3, title: 'Второе', due_at: '2026-08-07T06:00:00Z' }),
    ], { tz: TZ, nowIso: NOW })
    expect(text).toContain('Первое')
    expect(text).toContain('Второе')
    expect(text).toContain('5 августа')
    expect(text).toContain('7 августа')
  })
})

describe('digest', () => {
  it('показывает просроченное отдельно', () => {
    const text = digest(
      [task({ id: 2, title: 'Сегодняшнее', due_at: '2026-08-05T12:00:00Z' })],
      [task({ id: 3, title: 'Забытое', due_at: '2026-08-01T12:00:00Z' })],
      { tz: TZ, nowIso: NOW },
    )
    expect(text).toContain('Забытое')
    expect(text).toContain('Сегодняшнее')
    expect(text.indexOf('Забытое')).toBeLessThan(text.indexOf('Сегодняшнее'))
  })

  it('пустой день — короткое сообщение', () => {
    expect(digest([], [], { tz: TZ, nowIso: NOW })).toContain('свободен')
  })
})

describe('reminderText', () => {
  it('предупреждение заранее', () => {
    expect(reminderText(task(), { tz: TZ, nowIso: NOW, kind: 'pre' })).toContain('через')
  })

  it('напоминание в момент', () => {
    expect(reminderText(task(), { tz: TZ, nowIso: NOW, kind: 'due' })).toContain('Пора')
  })
})
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npx vitest run test/format.test.js`
Expected: FAIL

- [ ] **Step 3: Реализовать `src/format.js`**

```js
import { formatTime, formatDateHuman, localDateKey, localParts, addDays, startOfLocalDay } from './time.js'

export const ASSIGNEE_LABEL = { danya: 'Даня', zhenya: 'Женя', both: 'Оба' }
const ASSIGNEE_ICON = { danya: '👤', zhenya: '👩', both: '👫' }
const WEEKDAY_ACC = ['воскресенье', 'понедельник', 'вторник', 'среду',
  'четверг', 'пятницу', 'субботу']

export function plural(n, one, few, many) {
  const mod10 = n % 10
  const mod100 = n % 100
  let word = many
  if (mod10 === 1 && mod100 !== 11) word = one
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) word = few
  return `${n} ${word}`
}

export function repeatLabel(rule) {
  if (!rule) return null
  if (rule === 'daily') return 'каждый день'
  if (rule === 'weekdays') return 'по будням'
  if (rule.startsWith('weekly:')) return `каждый ${WEEKDAY_ACC[Number(rule.split(':')[1])]}`
  if (rule.startsWith('monthly:')) return `каждое ${rule.split(':')[1]}-е число`
  return null
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function taskKeyboard(taskId) {
  return {
    inline_keyboard: [[
      { text: '✅ Готово', callback_data: `done:${taskId}` },
      { text: '⏰ Перенести', callback_data: `snooze:${taskId}` },
      { text: '🗑', callback_data: `del:${taskId}` },
    ], [
      { text: '👤 Даня', callback_data: `as:${taskId}:danya` },
      { text: '👩 Женя', callback_data: `as:${taskId}:zhenya` },
      { text: '👫 Оба', callback_data: `as:${taskId}:both` },
    ]],
  }
}

export function snoozeKeyboard(taskId) {
  return {
    inline_keyboard: [[
      { text: '+15 мин', callback_data: `sn:${taskId}:15` },
      { text: '+1 час', callback_data: `sn:${taskId}:60` },
      { text: 'Вечером', callback_data: `sn:${taskId}:evening` },
      { text: 'Завтра', callback_data: `sn:${taskId}:tomorrow` },
    ]],
  }
}

export function taskCard(task, { tz, nowIso }) {
  const lines = [`📌 <b>${esc(task.title)}</b>`]
  if (task.due_at) {
    lines.push(`🗓 ${formatDateHuman(task.due_at, tz, nowIso)}, ${formatTime(task.due_at, tz)}`)
  } else {
    lines.push('🗓 без срока')
  }
  const rep = repeatLabel(task.repeat_rule)
  if (rep) lines.push(`🔁 ${rep}`)
  lines.push(`${ASSIGNEE_ICON[task.assignee]} ${ASSIGNEE_LABEL[task.assignee]}`)
  return { text: lines.join('\n'), reply_markup: taskKeyboard(task.id) }
}

const byTime = (a, b) => String(a.due_at ?? '').localeCompare(String(b.due_at ?? ''))

function taskLine(task, tz) {
  const time = task.due_at ? `<b>${formatTime(task.due_at, tz)}</b> ` : '· '
  return `${time}${esc(task.title)} ${ASSIGNEE_ICON[task.assignee]}`
}

export function dayList(tasks, { tz, nowIso, title }) {
  if (!tasks.length) return `📅 <b>${esc(title)}</b>\n\nПока пусто.`
  const sorted = [...tasks].sort(byTime)
  const head = `📅 <b>${esc(title)}</b> — ${plural(sorted.length, 'дело', 'дела', 'дел')}`
  return [head, '', ...sorted.map((t) => taskLine(t, tz))].join('\n')
}

export function weekList(tasks, { tz, nowIso }) {
  if (!tasks.length) return '🗓 <b>Неделя</b>\n\nПусто. Можно выдохнуть.'
  const groups = new Map()
  for (const t of [...tasks].sort(byTime)) {
    const key = t.due_at ? localDateKey(t.due_at, tz) : 'later'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }
  const out = [`🗓 <b>Неделя</b> — ${plural(tasks.length, 'дело', 'дела', 'дел')}`, '']
  for (const [key, items] of groups) {
    const label = key === 'later'
      ? 'Без срока'
      : capitalize(formatDateHuman(items[0].due_at, tz, nowIso))
    out.push(`<b>${esc(label)}</b>`)
    out.push(...items.map((t) => `  ${taskLine(t, tz)}`))
    out.push('')
  }
  return out.join('\n').trim()
}

const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

export function digest(todayTasks, overdueTasks, { tz, nowIso }) {
  if (!todayTasks.length && !overdueTasks.length) {
    return '☀️ Доброе утро!\n\nНа сегодня ничего не запланировано — день свободен.'
  }
  const out = ['☀️ <b>Доброе утро!</b>', '']
  if (overdueTasks.length) {
    out.push(`❗️ <b>Просрочено</b> — ${plural(overdueTasks.length, 'дело', 'дела', 'дел')}`)
    out.push(...[...overdueTasks].sort(byTime).map((t) => `  ${taskLine(t, tz)}`))
    out.push('')
  }
  if (todayTasks.length) {
    out.push(`Сегодня — ${plural(todayTasks.length, 'дело', 'дела', 'дел')}:`)
    out.push(...[...todayTasks].sort(byTime).map((t) => `  ${taskLine(t, tz)}`))
  } else {
    out.push('На сегодня ничего нового.')
  }
  return out.join('\n')
}

export function reminderText(task, { tz, nowIso, kind }) {
  const who = ASSIGNEE_LABEL[task.assignee]
  const time = task.due_at ? formatTime(task.due_at, tz) : ''
  if (kind === 'pre') {
    const mins = Math.max(1, Math.round((new Date(task.due_at) - new Date(nowIso)) / 60000))
    return `🔔 <b>${esc(task.title)}</b>\nЧерез ${plural(mins, 'минуту', 'минуты', 'минут')}, в ${time} · ${who}`
  }
  return `⏰ Пора: <b>${esc(task.title)}</b>\n${time} · ${who}`
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npx vitest run test/format.test.js`
Expected: PASS, 11 тестов

- [ ] **Step 5: Commit**

```bash
git add src/format.js test/format.test.js
git commit -m "feat: оформление карточек, списков и напоминаний"
```

---

### Task 6: Слой базы данных

**Files:**
- Create: `src/db.js`, `test/db.test.js`, `test/helpers/fake-d1.js`

**Interfaces:**
- Consumes: ничего (принимает биндинг `DB` снаружи)
- Produces:
  - `getChat(db, chatId, defaults) -> chat` — создаёт запись при первом обращении
  - `setChatSetting(db, chatId, field, value) -> void` (белый список полей)
  - `upsertUser(db, chatId, tgUserId, alias, role) -> void`
  - `getUserRole(db, chatId, tgUserId) -> 'danya'|'zhenya'|null`
  - `createTask(db, task) -> {id, ...task}`
  - `getTask(db, id) -> task | null`
  - `updateTask(db, id, patch) -> void` (белый список полей)
  - `markDone(db, id) -> void`
  - `tasksBetween(db, chatId, fromIso, toIso) -> task[]`
  - `overdueTasks(db, chatId, nowIso) -> task[]`
  - `undatedTasks(db, chatId) -> task[]`
  - `duePre(db, nowIso) -> task[]`, `dueNow(db, nowIso) -> task[]`
  - `markNotified(db, id, kind) -> void` (`'pre'|'due'`)
  - `chatsForDigest(db, todayKeyByChat) -> chat[]` — все чаты с включённым дайджестом
  - `markDigestSent(db, chatId, dateKey) -> void`
  - `isDuplicateUpdate(db, updateId, nowIso) -> boolean`

- [ ] **Step 1: Написать поддельный D1 `test/helpers/fake-d1.js`**

Полноценный SQLite в тестах не нужен: проверяем, что формируются правильные запросы и что слой корректно разбирает ответ.

```js
export function fakeD1(responses = []) {
  const calls = []
  let i = 0
  const next = () => (i < responses.length ? responses[i++] : { results: [] })
  return {
    calls,
    prepare(sql) {
      const call = { sql, params: null }
      calls.push(call)
      return {
        bind(...params) { call.params = params; return this },
        async all() { return next() },
        async first() { const r = next(); return r.results ? r.results[0] ?? null : r },
        async run() { return next() },
      }
    },
    async batch(stmts) { return stmts.map(() => ({ results: [] })) },
  }
}
```

- [ ] **Step 2: Написать падающие тесты `test/db.test.js`**

```js
import { describe, it, expect } from 'vitest'
import { fakeD1 } from './helpers/fake-d1.js'
import {
  createTask, tasksBetween, duePre, dueNow, markNotified,
  updateTask, isDuplicateUpdate,
} from '../src/db.js'

describe('db', () => {
  it('createTask вставляет и возвращает id', async () => {
    const db = fakeD1([{ results: [{ id: 42 }] }])
    const task = await createTask(db, {
      chat_id: -100, title: 'К врачу', due_at: '2026-08-06T12:00:00Z',
      remind_at: '2026-08-06T11:30:00Z', assignee: 'danya', created_by: 7,
      repeat_rule: null, created_at: '2026-08-05T09:00:00Z',
    })
    expect(task.id).toBe(42)
    expect(db.calls[0].sql).toContain('INSERT INTO tasks')
    expect(db.calls[0].params).toContain('К врачу')
  })

  it('tasksBetween фильтрует по чату, статусу и диапазону', async () => {
    const db = fakeD1([{ results: [{ id: 1 }] }])
    const rows = await tasksBetween(db, -100, '2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z')
    expect(rows).toHaveLength(1)
    expect(db.calls[0].sql).toContain("status = 'open'")
    expect(db.calls[0].params).toEqual([-100, '2026-08-05T00:00:00Z', '2026-08-06T00:00:00Z'])
  })

  it('duePre берёт только неотправленные', async () => {
    const db = fakeD1([{ results: [] }])
    await duePre(db, '2026-08-05T09:00:00Z')
    expect(db.calls[0].sql).toContain('notified_pre = 0')
    expect(db.calls[0].sql).toContain('remind_at <= ?')
  })

  it('dueNow берёт просроченные по due_at', async () => {
    const db = fakeD1([{ results: [] }])
    await dueNow(db, '2026-08-05T09:00:00Z')
    expect(db.calls[0].sql).toContain('notified_due = 0')
    expect(db.calls[0].sql).toContain('due_at <= ?')
  })

  it('markNotified обновляет нужное поле', async () => {
    const db = fakeD1([{}])
    await markNotified(db, 5, 'pre')
    expect(db.calls[0].sql).toContain('notified_pre = 1')
  })

  it('updateTask отвергает поля вне белого списка', async () => {
    const db = fakeD1([{}])
    await expect(updateTask(db, 1, { chat_id: 999 })).rejects.toThrow()
  })

  it('isDuplicateUpdate: первый раз false', async () => {
    const db = fakeD1([{ results: [] }, {}])
    expect(await isDuplicateUpdate(db, 123, '2026-08-05T09:00:00Z')).toBe(false)
  })

  it('isDuplicateUpdate: повтор true', async () => {
    const db = fakeD1([{ results: [{ update_id: 123 }] }])
    expect(await isDuplicateUpdate(db, 123, '2026-08-05T09:00:00Z')).toBe(true)
  })
})
```

- [ ] **Step 3: Запустить, убедиться что падает**

Run: `npx vitest run test/db.test.js`
Expected: FAIL

- [ ] **Step 4: Реализовать `src/db.js`**

```js
const TASK_FIELDS = 'id, chat_id, title, due_at, remind_at, assignee, created_by, status, repeat_rule, parent_id, notified_pre, notified_due, created_at'
const UPDATABLE = new Set(['title', 'due_at', 'remind_at', 'assignee', 'status',
  'repeat_rule', 'notified_pre', 'notified_due'])
const CHAT_SETTINGS = new Set(['tz', 'digest_time', 'digest_enabled', 'remind_before_min'])

export async function getChat(db, chatId, defaults) {
  const row = await db.prepare('SELECT * FROM chats WHERE chat_id = ?').bind(chatId).first()
  if (row) return row
  await db.prepare(
    'INSERT INTO chats (chat_id, tz, digest_time, digest_enabled, remind_before_min) VALUES (?, ?, ?, 1, ?)',
  ).bind(chatId, defaults.tz, defaults.digestTime, defaults.remindBeforeMin).run()
  return {
    chat_id: chatId, tz: defaults.tz, digest_time: defaults.digestTime,
    digest_enabled: 1, remind_before_min: defaults.remindBeforeMin, last_digest_date: null,
  }
}

export async function setChatSetting(db, chatId, field, value) {
  if (!CHAT_SETTINGS.has(field)) throw new Error(`поле ${field} менять нельзя`)
  await db.prepare(`UPDATE chats SET ${field} = ? WHERE chat_id = ?`).bind(value, chatId).run()
}

export async function upsertUser(db, chatId, tgUserId, alias, role) {
  await db.prepare(
    `INSERT INTO users (tg_user_id, chat_id, alias, role) VALUES (?, ?, ?, ?)
     ON CONFLICT(tg_user_id, chat_id) DO UPDATE SET alias = excluded.alias, role = excluded.role`,
  ).bind(tgUserId, chatId, alias, role).run()
}

export async function getUserRole(db, chatId, tgUserId) {
  const row = await db.prepare('SELECT role FROM users WHERE chat_id = ? AND tg_user_id = ?')
    .bind(chatId, tgUserId).first()
  return row?.role ?? null
}

export async function createTask(db, t) {
  const row = await db.prepare(
    `INSERT INTO tasks (chat_id, title, due_at, remind_at, assignee, created_by, status, repeat_rule, parent_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) RETURNING id`,
  ).bind(t.chat_id, t.title, t.due_at ?? null, t.remind_at ?? null, t.assignee,
    t.created_by, t.repeat_rule ?? null, t.parent_id ?? null, t.created_at).first()
  return { ...t, id: row.id, status: 'open', notified_pre: 0, notified_due: 0 }
}

export async function getTask(db, id) {
  return db.prepare(`SELECT ${TASK_FIELDS} FROM tasks WHERE id = ?`).bind(id).first()
}

export async function updateTask(db, id, patch) {
  const keys = Object.keys(patch)
  for (const k of keys) if (!UPDATABLE.has(k)) throw new Error(`поле ${k} менять нельзя`)
  if (!keys.length) return
  const set = keys.map((k) => `${k} = ?`).join(', ')
  await db.prepare(`UPDATE tasks SET ${set} WHERE id = ?`)
    .bind(...keys.map((k) => patch[k]), id).run()
}

export async function markDone(db, id) {
  await db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").bind(id).run()
}

export async function tasksBetween(db, chatId, fromIso, toIso) {
  const { results } = await db.prepare(
    `SELECT ${TASK_FIELDS} FROM tasks
     WHERE chat_id = ? AND status = 'open' AND due_at >= ? AND due_at < ?
     ORDER BY due_at`,
  ).bind(chatId, fromIso, toIso).all()
  return results ?? []
}

export async function overdueTasks(db, chatId, nowIso) {
  const { results } = await db.prepare(
    `SELECT ${TASK_FIELDS} FROM tasks
     WHERE chat_id = ? AND status = 'open' AND due_at IS NOT NULL AND due_at < ?
     ORDER BY due_at`,
  ).bind(chatId, nowIso).all()
  return results ?? []
}

export async function undatedTasks(db, chatId) {
  const { results } = await db.prepare(
    `SELECT ${TASK_FIELDS} FROM tasks
     WHERE chat_id = ? AND status = 'open' AND due_at IS NULL ORDER BY id DESC`,
  ).bind(chatId).all()
  return results ?? []
}

export async function duePre(db, nowIso) {
  const { results } = await db.prepare(
    `SELECT ${TASK_FIELDS} FROM tasks
     WHERE status = 'open' AND notified_pre = 0 AND remind_at IS NOT NULL
       AND remind_at <= ? AND due_at > ? LIMIT 50`,
  ).bind(nowIso, nowIso).all()
  return results ?? []
}

export async function dueNow(db, nowIso) {
  const { results } = await db.prepare(
    `SELECT ${TASK_FIELDS} FROM tasks
     WHERE status = 'open' AND notified_due = 0 AND due_at IS NOT NULL
       AND due_at <= ? LIMIT 50`,
  ).bind(nowIso).all()
  return results ?? []
}

export async function markNotified(db, id, kind) {
  const field = kind === 'pre' ? 'notified_pre' : 'notified_due'
  await db.prepare(`UPDATE tasks SET ${field} = 1 WHERE id = ?`).bind(id).run()
}

export async function chatsForDigest(db) {
  const { results } = await db.prepare('SELECT * FROM chats WHERE digest_enabled = 1').all()
  return results ?? []
}

export async function markDigestSent(db, chatId, dateKey) {
  await db.prepare('UPDATE chats SET last_digest_date = ? WHERE chat_id = ?')
    .bind(dateKey, chatId).run()
}

export async function isDuplicateUpdate(db, updateId, nowIso) {
  const row = await db.prepare('SELECT update_id FROM seen_updates WHERE update_id = ?')
    .bind(updateId).first()
  if (row) return true
  await db.prepare('INSERT OR IGNORE INTO seen_updates (update_id, seen_at) VALUES (?, ?)')
    .bind(updateId, nowIso).run()
  return false
}
```

- [ ] **Step 5: Запустить тесты**

Run: `npx vitest run test/db.test.js`
Expected: PASS, 8 тестов

- [ ] **Step 6: Commit**

```bash
git add src/db.js test/db.test.js test/helpers/fake-d1.js
git commit -m "feat: слой доступа к базе"
```

---

### Task 7: Клиент Telegram и определение ответственного

**Files:**
- Create: `src/telegram.js`, `src/assignee.js`, `test/assignee.test.js`

**Interfaces:**
- Consumes: ничего
- Produces:
  - `tg(env, method, payload) -> Promise<object>` — вызов Bot API, бросает при `ok: false`
  - `sendMessage(env, chatId, text, extra) -> Promise<object>`
  - `editMessageText(env, chatId, messageId, text, extra) -> Promise<object>`
  - `answerCallback(env, callbackId, text) -> Promise<object>`
  - `detectAssignee(text, authorRole) -> {assignee, text}` — вырезает обращение из текста

- [ ] **Step 1: Написать падающие тесты `test/assignee.test.js`**

```js
import { describe, it, expect } from 'vitest'
import { detectAssignee } from '../src/assignee.js'

describe('detectAssignee', () => {
  it('по умолчанию — автор', () => {
    expect(detectAssignee('купить корм', 'danya').assignee).toBe('danya')
    expect(detectAssignee('купить корм', 'zhenya').assignee).toBe('zhenya')
  })

  it('обращение к Жене', () => {
    const r = detectAssignee('Жень, купи корм коту', 'danya')
    expect(r.assignee).toBe('zhenya')
    expect(r.text).toBe('купи корм коту')
  })

  it('обращение к Дане', () => {
    expect(detectAssignee('Дань, забери посылку', 'zhenya').assignee).toBe('danya')
  })

  it('«нам надо» -> оба', () => {
    expect(detectAssignee('нам надо к нотариусу', 'danya').assignee).toBe('both')
  })

  it('«вместе» -> оба', () => {
    expect(detectAssignee('вместе выбрать торт', 'zhenya').assignee).toBe('both')
  })

  it('не путает имя внутри слова', () => {
    expect(detectAssignee('купить женьшень', 'danya').assignee).toBe('danya')
  })
})
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npx vitest run test/assignee.test.js`
Expected: FAIL

- [ ] **Step 3: Реализовать `src/assignee.js`**

```js
const ZHENYA = /^\s*(жен[яеь]|женёк|женька|жека)\s*[,:]?\s+/i
const DANYA = /^\s*(дан[яеь]|данила|даня|данёк)\s*[,:]?\s+/i
const BOTH = /\b(нам\s+надо|нам\s+нужно|вместе|обоим|вдвоём|вдвоем)\b/i

export function detectAssignee(text, authorRole) {
  const both = text.match(BOTH)
  if (both) return { assignee: 'both', text: text.trim() }

  const z = text.match(ZHENYA)
  if (z) return { assignee: 'zhenya', text: text.slice(z[0].length).trim() }

  const d = text.match(DANYA)
  if (d) return { assignee: 'danya', text: text.slice(d[0].length).trim() }

  return { assignee: authorRole ?? 'both', text: text.trim() }
}
```

- [ ] **Step 4: Реализовать `src/telegram.js`**

```js
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
```

- [ ] **Step 5: Запустить тесты**

Run: `npx vitest run test/assignee.test.js`
Expected: PASS, 6 тестов

- [ ] **Step 6: Commit**

```bash
git add src/telegram.js src/assignee.js test/assignee.test.js
git commit -m "feat: клиент Telegram и определение ответственного"
```

---

### Task 8: Разбор через Workers AI

**Files:**
- Create: `src/parse/ai.js`, `src/parse/index.js`, `test/parse-index.test.js`

**Interfaces:**
- Consumes: `src/parse/ru-dates.js`, `src/time.js`
- Produces:
  - `parseWithAi(env, text, nowIso, tz) -> {title, dueAt, repeatRule} | null` — `null` при любой ошибке
  - `parseTask(env, text, nowIso, tz) -> {title, dueAt, repeatRule, source}` — `source`: `'local' | 'ai' | 'none'`

Правило: AI вызывается только если свой парсер не нашёл ни даты, ни повтора, и `AI_ENABLED === 'true'`. Любая ошибка AI не ломает сценарий — возвращается результат своего парсера.

- [ ] **Step 1: Написать падающие тесты `test/parse-index.test.js`**

```js
import { describe, it, expect, vi } from 'vitest'
import { parseTask } from '../src/parse/index.js'

const TZ = 'Europe/Moscow'
const NOW = '2026-08-05T09:00:00Z'

describe('parseTask', () => {
  it('свой парсер справился — AI не зовём', async () => {
    const env = { AI_ENABLED: 'true', AI: { run: vi.fn() } }
    const r = await parseTask(env, 'завтра в 15:00 к врачу', NOW, TZ)
    expect(r.source).toBe('local')
    expect(r.dueAt).toBe('2026-08-06T12:00:00.000Z')
    expect(env.AI.run).not.toHaveBeenCalled()
  })

  it('свой не справился — идём в AI', async () => {
    const env = {
      AI_ENABLED: 'true', AI_MODEL: 'm',
      AI: {
        run: vi.fn().mockResolvedValue({
          response: '{"title":"К нотариусу","due_at":"2026-08-12T09:00:00Z","repeat_rule":null}',
        }),
      },
    }
    const r = await parseTask(env, 'надо бы к нотариусу где-то в середине недели', NOW, TZ)
    expect(env.AI.run).toHaveBeenCalled()
    expect(r.source).toBe('ai')
    expect(r.title).toBe('К нотариусу')
    expect(r.dueAt).toBe('2026-08-12T09:00:00.000Z')
  })

  it('AI упал — возвращаем результат своего парсера', async () => {
    const env = {
      AI_ENABLED: 'true', AI_MODEL: 'm',
      AI: { run: vi.fn().mockRejectedValue(new Error('boom')) },
    }
    const r = await parseTask(env, 'купить корм коту', NOW, TZ)
    expect(r.source).toBe('none')
    expect(r.title).toBe('Купить корм коту')
    expect(r.dueAt).toBeNull()
  })

  it('AI вернул мусор — не падаем', async () => {
    const env = {
      AI_ENABLED: 'true', AI_MODEL: 'm',
      AI: { run: vi.fn().mockResolvedValue({ response: 'я не понял, извините' }) },
    }
    const r = await parseTask(env, 'что-то невнятное', NOW, TZ)
    expect(r.source).toBe('none')
    expect(r.dueAt).toBeNull()
  })

  it('AI выключен — не зовём вовсе', async () => {
    const env = { AI_ENABLED: 'false', AI: { run: vi.fn() } }
    const r = await parseTask(env, 'купить корм коту', NOW, TZ)
    expect(env.AI.run).not.toHaveBeenCalled()
    expect(r.source).toBe('none')
  })
})
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npx vitest run test/parse-index.test.js`
Expected: FAIL

- [ ] **Step 3: Реализовать `src/parse/ai.js`**

```js
import { localParts } from '../time.js'

const SYSTEM = `Ты разбираешь короткие бытовые заметки на русском и превращаешь их в задачу.
Отвечай ТОЛЬКО одним JSON-объектом без пояснений и без markdown.
Поля:
  "title" — суть дела без даты и времени, с заглавной буквы, до 80 символов
  "due_at" — срок в формате YYYY-MM-DDTHH:MM:SSZ (UTC) или null
  "repeat_rule" — "daily" | "weekly:N" (N: 0=вс..6=сб) | "monthly:D" | "weekdays" | null
Если срок не указан и не подразумевается — due_at: null. Ничего не выдумывай.`

function extractJson(raw) {
  if (!raw) return null
  const text = typeof raw === 'string' ? raw : raw.response ?? ''
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

export async function parseWithAi(env, text, nowIso, tz) {
  if (env.AI_ENABLED !== 'true' || !env.AI) return null
  const p = localParts(nowIso, tz)
  const nowLine = `Сейчас: ${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')} `
    + `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}, зона ${tz}.`

  try {
    const out = await env.AI.run(env.AI_MODEL, {
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `${nowLine}\nЗаметка: ${text}` },
      ],
      max_tokens: 256,
      temperature: 0.1,
    })
    const parsed = extractJson(out)
    if (!parsed || !parsed.title) return null
    let dueAt = null
    if (parsed.due_at) {
      const d = new Date(parsed.due_at)
      if (!Number.isNaN(d.getTime())) dueAt = d.toISOString()
    }
    return {
      title: String(parsed.title).slice(0, 200),
      dueAt,
      repeatRule: parsed.repeat_rule ?? null,
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Реализовать `src/parse/index.js`**

```js
import { parseRu } from './ru-dates.js'
import { parseWithAi } from './ai.js'

export async function parseTask(env, text, nowIso, tz) {
  const local = parseRu(text, nowIso, tz)
  if (!local) return { title: '', dueAt: null, repeatRule: null, source: 'none' }
  if (local.matched) {
    return { title: local.title, dueAt: local.dueAt, repeatRule: local.repeatRule, source: 'local' }
  }

  const ai = await parseWithAi(env, text, nowIso, tz)
  if (ai && (ai.dueAt || ai.repeatRule)) {
    return { title: ai.title, dueAt: ai.dueAt, repeatRule: ai.repeatRule, source: 'ai' }
  }

  return { title: local.title, dueAt: null, repeatRule: local.repeatRule, source: 'none' }
}
```

- [ ] **Step 5: Запустить тесты**

Run: `npx vitest run test/parse-index.test.js`
Expected: PASS, 5 тестов

- [ ] **Step 6: Commit**

```bash
git add src/parse/ai.js src/parse/index.js test/parse-index.test.js
git commit -m "feat: разбор сложных формулировок через Workers AI"
```

---

### Task 9: Маршрутизация сообщений и кнопок

**Files:**
- Create: `src/router.js`, `test/router.test.js`

**Interfaces:**
- Consumes: `db.js`, `parse/index.js`, `format.js`, `telegram.js`, `assignee.js`, `time.js`, `repeat.js`
- Produces: `handleUpdate(update, env, nowIso) -> Promise<void>`

Команды: `/start`, `/help`, `/добавить`, `/день`, `/завтра`, `/неделя`, `/мои`, `/все`, `/настройки`.
Латинские синонимы: `/add`, `/today`, `/tomorrow`, `/week`, `/mine`, `/all`, `/settings`.
Callback-действия: `done:<id>`, `snooze:<id>`, `sn:<id>:<15|60|evening|tomorrow>`, `del:<id>`, `as:<id>:<role>`.

- [ ] **Step 1: Написать падающие тесты `test/router.test.js`**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleUpdate } from '../src/router.js'
import * as tg from '../src/telegram.js'
import * as db from '../src/db.js'

const NOW = '2026-08-05T09:00:00Z'
const CHAT = -1001
const env = {
  BOT_TOKEN: 't', BOT_USERNAME: 'planer_bot', DEFAULT_TZ: 'Europe/Moscow',
  DEFAULT_DIGEST_TIME: '10:00', DEFAULT_REMIND_BEFORE_MIN: '30',
  AI_ENABLED: 'false', DB: {},
}

const message = (text, extra = {}) => ({
  update_id: 1,
  message: {
    message_id: 10, text, chat: { id: CHAT, type: 'supergroup' },
    from: { id: 7, first_name: 'Даня' }, ...extra,
  },
})

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(tg, 'sendMessage').mockResolvedValue({ message_id: 11 })
  vi.spyOn(tg, 'editMessageText').mockResolvedValue({})
  vi.spyOn(tg, 'answerCallback').mockResolvedValue({})
  vi.spyOn(db, 'getChat').mockResolvedValue({
    chat_id: CHAT, tz: 'Europe/Moscow', digest_time: '10:00',
    digest_enabled: 1, remind_before_min: 30,
  })
  vi.spyOn(db, 'getUserRole').mockResolvedValue('danya')
  vi.spyOn(db, 'isDuplicateUpdate').mockResolvedValue(false)
})

describe('handleUpdate: добавление дела', () => {
  it('по упоминанию создаёт задачу и отвечает карточкой', async () => {
    const create = vi.spyOn(db, 'createTask').mockResolvedValue({
      id: 1, title: 'К врачу', due_at: '2026-08-06T12:00:00.000Z',
      assignee: 'danya', repeat_rule: null,
    })
    await handleUpdate(message('@planer_bot завтра в 15:00 к врачу'), env, NOW)
    expect(create).toHaveBeenCalled()
    const arg = create.mock.calls[0][1]
    expect(arg.title).toBe('К врачу')
    expect(arg.due_at).toBe('2026-08-06T12:00:00.000Z')
    expect(arg.remind_at).toBe('2026-08-06T11:30:00.000Z')
    expect(tg.sendMessage).toHaveBeenCalled()
    expect(tg.sendMessage.mock.calls[0][2]).toContain('К врачу')
  })

  it('дубль апдейта игнорируется', async () => {
    vi.spyOn(db, 'isDuplicateUpdate').mockResolvedValue(true)
    const create = vi.spyOn(db, 'createTask')
    await handleUpdate(message('@planer_bot завтра в 15 к врачу'), env, NOW)
    expect(create).not.toHaveBeenCalled()
  })

  it('без обращения к боту ничего не делает', async () => {
    const create = vi.spyOn(db, 'createTask')
    await handleUpdate(message('слушай, а что там с ремонтом'), env, NOW)
    expect(create).not.toHaveBeenCalled()
    expect(tg.sendMessage).not.toHaveBeenCalled()
  })

  it('дело без даты — спрашивает срок кнопками', async () => {
    vi.spyOn(db, 'createTask').mockResolvedValue({
      id: 2, title: 'Купить корм коту', due_at: null, assignee: 'danya', repeat_rule: null,
    })
    await handleUpdate(message('@planer_bot купить корм коту'), env, NOW)
    const extra = tg.sendMessage.mock.calls[0][3]
    const flat = JSON.stringify(extra.reply_markup)
    expect(flat).toContain('Сегодня')
    expect(flat).toContain('Завтра')
    expect(flat).toContain('Без срока')
  })
})

describe('handleUpdate: команды', () => {
  it('/день показывает список на сегодня', async () => {
    vi.spyOn(db, 'tasksBetween').mockResolvedValue([
      { id: 1, title: 'Зарядка', due_at: '2026-08-05T06:00:00Z', assignee: 'danya' },
    ])
    await handleUpdate(message('/день'), env, NOW)
    expect(tg.sendMessage.mock.calls[0][2]).toContain('Зарядка')
  })

  it('/неделя берёт диапазон в 7 дней', async () => {
    const between = vi.spyOn(db, 'tasksBetween').mockResolvedValue([])
    await handleUpdate(message('/неделя'), env, NOW)
    const [, , from, to] = between.mock.calls[0]
    expect(new Date(to) - new Date(from)).toBe(7 * 86400000)
  })

  it('/мои фильтрует по автору', async () => {
    vi.spyOn(db, 'tasksBetween').mockResolvedValue([
      { id: 1, title: 'Моё', due_at: '2026-08-05T06:00:00Z', assignee: 'danya' },
      { id: 2, title: 'Женино', due_at: '2026-08-05T07:00:00Z', assignee: 'zhenya' },
    ])
    vi.spyOn(db, 'undatedTasks').mockResolvedValue([])
    await handleUpdate(message('/мои'), env, NOW)
    const text = tg.sendMessage.mock.calls[0][2]
    expect(text).toContain('Моё')
    expect(text).not.toContain('Женино')
  })
})

describe('handleUpdate: кнопки', () => {
  const callback = (data) => ({
    update_id: 2,
    callback_query: {
      id: 'cb1', data,
      from: { id: 7, first_name: 'Даня' },
      message: { message_id: 10, chat: { id: CHAT } },
    },
  })

  it('done закрывает дело', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: CHAT, title: 'К врачу', due_at: '2026-08-06T12:00:00Z',
      assignee: 'danya', repeat_rule: null, status: 'open',
    })
    const done = vi.spyOn(db, 'markDone').mockResolvedValue()
    await handleUpdate(callback('done:1'), env, NOW)
    expect(done).toHaveBeenCalledWith(env.DB, 1)
    expect(tg.editMessageText).toHaveBeenCalled()
  })

  it('done у повторяющегося дела создаёт следующее', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: CHAT, title: 'Мусор', due_at: '2026-08-11T06:00:00Z',
      assignee: 'both', repeat_rule: 'weekly:2', status: 'open', created_by: 7,
    })
    vi.spyOn(db, 'markDone').mockResolvedValue()
    const create = vi.spyOn(db, 'createTask').mockResolvedValue({ id: 9 })
    await handleUpdate(callback('done:1'), env, NOW)
    expect(create.mock.calls[0][1].due_at).toBe('2026-08-18T06:00:00.000Z')
  })

  it('перенос на час двигает срок и сбрасывает флаги', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: CHAT, title: 'К врачу', due_at: '2026-08-06T12:00:00Z',
      assignee: 'danya', repeat_rule: null, status: 'open',
    })
    const upd = vi.spyOn(db, 'updateTask').mockResolvedValue()
    await handleUpdate(callback('sn:1:60'), env, NOW)
    expect(upd.mock.calls[0][2].due_at).toBe('2026-08-06T13:00:00.000Z')
    expect(upd.mock.calls[0][2].notified_due).toBe(0)
  })

  it('назначение ответственного', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: CHAT, title: 'К врачу', due_at: '2026-08-06T12:00:00Z',
      assignee: 'danya', repeat_rule: null, status: 'open',
    })
    const upd = vi.spyOn(db, 'updateTask').mockResolvedValue()
    await handleUpdate(callback('as:1:zhenya'), env, NOW)
    expect(upd.mock.calls[0][2].assignee).toBe('zhenya')
  })

  it('чужой чат не может трогать задачу', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({
      id: 1, chat_id: -999, title: 'Чужое', due_at: null,
      assignee: 'danya', repeat_rule: null, status: 'open',
    })
    const done = vi.spyOn(db, 'markDone')
    await handleUpdate(callback('done:1'), env, NOW)
    expect(done).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npx vitest run test/router.test.js`
Expected: FAIL

- [ ] **Step 3: Реализовать `src/router.js`**

Важно: модули импортируются как пространства имён (`import * as db`), иначе `vi.spyOn` в тестах не перехватит вызовы.

```js
import * as db from './db.js'
import * as tg from './telegram.js'
import { parseTask } from './parse/index.js'
import { detectAssignee } from './assignee.js'
import { nextOccurrence } from './repeat.js'
import {
  taskCard, dayList, weekList, snoozeKeyboard, taskKeyboard, ASSIGNEE_LABEL, plural,
} from './format.js'
import {
  addDays, addMinutes, startOfLocalDay, localParts, localToUtcIso, formatDateHuman, formatTime,
} from './time.js'

const HELP = `Я веду ваши дела.

<b>Как добавить</b>
Напиши мне с упоминанием: «@BOT завтра в 15 к врачу»
или ответь реплаем на любое моё сообщение.
Понимаю: «через 2 часа», «в пятницу вечером», «5 марта»,
«каждый вторник», «каждое 5-е число», «по будням».

<b>Команды</b>
/день — что сегодня
/завтра — что завтра
/неделя — расписание на 7 дней
/мои — только мои дела
/все — дела без срока
/настройки — время дайджеста и напоминаний

Напомню за 30 минут до срока и в сам момент.`

function chatDefaults(env) {
  return {
    tz: env.DEFAULT_TZ,
    digestTime: env.DEFAULT_DIGEST_TIME,
    remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN),
  }
}

function roleFromName(from) {
  const name = `${from.first_name ?? ''} ${from.username ?? ''}`.toLowerCase()
  if (/жен|zhen|evgen/.test(name)) return 'zhenya'
  return 'danya'
}

function addressedText(msg, env) {
  const text = (msg.text ?? msg.caption ?? '').trim()
  if (!text) return null

  if (text.startsWith('/')) return null

  const mention = new RegExp(`@${env.BOT_USERNAME}\\b`, 'i')
  if (mention.test(text)) return text.replace(mention, ' ').trim()

  if (msg.reply_to_message?.from?.is_bot) return text

  if (msg.chat.type === 'private') return text

  return null
}

function parseCommand(text) {
  if (!text?.startsWith('/')) return null
  const raw = text.split(/\s+/)[0].slice(1).split('@')[0].toLowerCase()
  const rest = text.slice(text.split(/\s+/)[0].length).trim()
  const map = {
    'start': 'start', 'help': 'help', 'помощь': 'help',
    'добавить': 'add', 'add': 'add',
    'день': 'today', 'today': 'today', 'сегодня': 'today',
    'завтра': 'tomorrow', 'tomorrow': 'tomorrow',
    'неделя': 'week', 'week': 'week',
    'мои': 'mine', 'mine': 'mine',
    'все': 'all', 'всё': 'all', 'all': 'all',
    'настройки': 'settings', 'settings': 'settings',
  }
  return map[raw] ? { cmd: map[raw], rest } : null
}

export async function handleUpdate(update, env, nowIso) {
  if (update.update_id != null && await db.isDuplicateUpdate(env.DB, update.update_id, nowIso)) return

  if (update.callback_query) return handleCallback(update.callback_query, env, nowIso)
  if (update.message) return handleMessage(update.message, env, nowIso)
}

async function handleMessage(msg, env, nowIso) {
  const chatId = msg.chat.id
  const command = parseCommand(msg.text ?? '')
  const addressed = addressedText(msg, env)
  if (!command && !addressed) return

  const chat = await db.getChat(env.DB, chatId, chatDefaults(env))
  const role = (await db.getUserRole(env.DB, chatId, msg.from.id)) ?? roleFromName(msg.from)
  await db.upsertUser(env.DB, chatId, msg.from.id, msg.from.first_name ?? '', role)

  if (command) return runCommand(command, msg, chat, role, env, nowIso)
  return createFromText(addressed, msg, chat, role, env, nowIso)
}

async function createFromText(text, msg, chat, role, env, nowIso) {
  const { assignee, text: cleaned } = detectAssignee(text, role)
  const parsed = await parseTask(env, cleaned, nowIso, chat.tz)

  if (!parsed.title) {
    await tg.sendMessage(env, chat.chat_id, 'Не понял, что за дело. Напиши коротко: что и когда.')
    return
  }

  const remindAt = parsed.dueAt
    ? addMinutes(parsed.dueAt, -chat.remind_before_min)
    : null

  const task = await db.createTask(env.DB, {
    chat_id: chat.chat_id,
    title: parsed.title,
    due_at: parsed.dueAt,
    remind_at: remindAt,
    assignee,
    created_by: msg.from.id,
    repeat_rule: parsed.repeatRule,
    created_at: nowIso,
  })

  if (!parsed.dueAt) {
    await tg.sendMessage(env, chat.chat_id, `📌 <b>${task.title}</b>\n\nКогда напомнить?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Сегодня', callback_data: `when:${task.id}:today` },
          { text: 'Завтра', callback_data: `when:${task.id}:tomorrow` },
          { text: 'В выходные', callback_data: `when:${task.id}:weekend` },
          { text: 'Без срока', callback_data: `when:${task.id}:none` },
        ]],
      },
    })
    return
  }

  const card = taskCard({ ...task, assignee, repeat_rule: parsed.repeatRule },
    { tz: chat.tz, nowIso })
  await tg.sendMessage(env, chat.chat_id, card.text, { reply_markup: card.reply_markup })
}

async function runCommand({ cmd, rest }, msg, chat, role, env, nowIso) {
  const chatId = chat.chat_id
  const tz = chat.tz

  if (cmd === 'start' || cmd === 'help') {
    await tg.sendMessage(env, chatId, HELP.replace(/@BOT/g, `@${env.BOT_USERNAME}`))
    return
  }

  if (cmd === 'add') {
    if (!rest) {
      await tg.sendMessage(env, chatId, 'Напиши так: /добавить завтра в 15 к врачу')
      return
    }
    return createFromText(rest, msg, chat, role, env, nowIso)
  }

  if (cmd === 'today' || cmd === 'tomorrow') {
    const shift = cmd === 'today' ? 0 : 1
    const from = addDays(startOfLocalDay(nowIso, tz), shift)
    const to = addDays(from, 1)
    const tasks = await db.tasksBetween(env.DB, chatId, from, to)
    const title = cmd === 'today' ? 'Сегодня' : 'Завтра'
    await tg.sendMessage(env, chatId, dayList(tasks, { tz, nowIso, title }))
    return
  }

  if (cmd === 'week') {
    const from = startOfLocalDay(nowIso, tz)
    const to = addDays(from, 7)
    const tasks = await db.tasksBetween(env.DB, chatId, from, to)
    await tg.sendMessage(env, chatId, weekList(tasks, { tz, nowIso }))
    return
  }

  if (cmd === 'mine') {
    const from = startOfLocalDay(nowIso, tz)
    const to = addDays(from, 7)
    const all = await db.tasksBetween(env.DB, chatId, from, to)
    const undated = await db.undatedTasks(env.DB, chatId)
    const mine = [...all, ...undated].filter((t) => t.assignee === role || t.assignee === 'both')
    await tg.sendMessage(env, chatId, dayList(mine, { tz, nowIso, title: `Дела: ${ASSIGNEE_LABEL[role]}` }))
    return
  }

  if (cmd === 'all') {
    const undated = await db.undatedTasks(env.DB, chatId)
    await tg.sendMessage(env, chatId, dayList(undated, { tz, nowIso, title: 'Без срока' }))
    return
  }

  if (cmd === 'settings') {
    const text = `⚙️ <b>Настройки</b>\n\n`
      + `Часовой пояс: ${chat.tz}\n`
      + `Утренний дайджест: ${chat.digest_enabled ? chat.digest_time : 'выключен'}\n`
      + `Напоминание заранее: ${plural(chat.remind_before_min, 'минута', 'минуты', 'минут')}`
    await tg.sendMessage(env, chatId, text, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Дайджест 8:00', callback_data: 'set:digest:08:00' },
            { text: '10:00', callback_data: 'set:digest:10:00' },
            { text: 'Выключить', callback_data: 'set:digest:off' },
          ],
          [
            { text: 'Напоминать за 15 мин', callback_data: 'set:pre:15' },
            { text: '30', callback_data: 'set:pre:30' },
            { text: '60', callback_data: 'set:pre:60' },
          ],
        ],
      },
    })
  }
}

async function handleCallback(cb, env, nowIso) {
  const chatId = cb.message.chat.id
  const chat = await db.getChat(env.DB, chatId, chatDefaults(env))
  const [action, ...args] = cb.data.split(':')

  if (action === 'set') return handleSettings(cb, chat, args, env, nowIso)

  const taskId = Number(args[0])
  const task = await db.getTask(env.DB, taskId)
  if (!task || task.chat_id !== chatId) {
    await tg.answerCallback(env, cb.id, 'Дело не найдено')
    return
  }

  if (action === 'done') {
    await db.markDone(env.DB, taskId)
    if (task.repeat_rule) {
      const next = nextOccurrence(task.due_at, task.repeat_rule, chat.tz)
      if (next) {
        await db.createTask(env.DB, {
          chat_id: chatId, title: task.title, due_at: next,
          remind_at: addMinutes(next, -chat.remind_before_min),
          assignee: task.assignee, created_by: task.created_by,
          repeat_rule: task.repeat_rule, parent_id: task.parent_id ?? task.id,
          created_at: nowIso,
        })
      }
    }
    const suffix = task.repeat_rule
      ? `\n\n✅ Готово. Следующий раз — ${formatDateHuman(nextOccurrence(task.due_at, task.repeat_rule, chat.tz), chat.tz, nowIso)}.`
      : '\n\n✅ Готово.'
    await tg.editMessageText(env, chatId, cb.message.message_id,
      `<s>${task.title}</s>${suffix}`, { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id, 'Отметил')
    return
  }

  if (action === 'del') {
    await db.updateTask(env.DB, taskId, { status: 'cancelled' })
    await tg.editMessageText(env, chatId, cb.message.message_id,
      `<s>${task.title}</s>\n\n🗑 Удалено.`, { reply_markup: { inline_keyboard: [] } })
    await tg.answerCallback(env, cb.id, 'Удалил')
    return
  }

  if (action === 'snooze') {
    await tg.editMessageText(env, chatId, cb.message.message_id,
      `📌 <b>${task.title}</b>\n\nНа когда перенести?`,
      { reply_markup: snoozeKeyboard(taskId) })
    await tg.answerCallback(env, cb.id)
    return
  }

  if (action === 'sn') {
    const mode = args[1]
    const base = task.due_at ?? nowIso
    let due
    if (mode === 'evening') {
      const p = localParts(nowIso, chat.tz)
      due = localToUtcIso({ year: p.year, month: p.month, day: p.day, hour: 19, minute: 0 }, chat.tz)
      if (new Date(due) <= new Date(nowIso)) due = addDays(due, 1)
    } else if (mode === 'tomorrow') {
      const p = localParts(addDays(startOfLocalDay(nowIso, chat.tz), 1), chat.tz)
      const hour = task.due_at ? localParts(task.due_at, chat.tz).hour : 9
      const minute = task.due_at ? localParts(task.due_at, chat.tz).minute : 0
      due = localToUtcIso({ year: p.year, month: p.month, day: p.day, hour, minute }, chat.tz)
    } else {
      due = addMinutes(base, Number(mode))
    }
    await db.updateTask(env.DB, taskId, {
      due_at: due,
      remind_at: addMinutes(due, -chat.remind_before_min),
      notified_pre: 0,
      notified_due: 0,
    })
    const card = taskCard({ ...task, due_at: due }, { tz: chat.tz, nowIso })
    await tg.editMessageText(env, chatId, cb.message.message_id, card.text,
      { reply_markup: card.reply_markup })
    await tg.answerCallback(env, cb.id, `Перенёс на ${formatTime(due, chat.tz)}`)
    return
  }

  if (action === 'as') {
    const role = args[1]
    await db.updateTask(env.DB, taskId, { assignee: role })
    const card = taskCard({ ...task, assignee: role }, { tz: chat.tz, nowIso })
    await tg.editMessageText(env, chatId, cb.message.message_id, card.text,
      { reply_markup: card.reply_markup })
    await tg.answerCallback(env, cb.id, `Теперь на ${ASSIGNEE_LABEL[role]}`)
    return
  }

  if (action === 'when') {
    const mode = args[1]
    if (mode === 'none') {
      await tg.answerCallback(env, cb.id, 'Оставил без срока')
      await tg.editMessageText(env, chatId, cb.message.message_id,
        `📌 <b>${task.title}</b>\n🗓 без срока`, { reply_markup: taskKeyboard(taskId) })
      return
    }
    const p0 = localParts(nowIso, chat.tz)
    let due
    if (mode === 'today') {
      due = localToUtcIso({ year: p0.year, month: p0.month, day: p0.day, hour: 19, minute: 0 }, chat.tz)
      if (new Date(due) <= new Date(nowIso)) due = addMinutes(nowIso, 60)
    } else if (mode === 'tomorrow') {
      const p = localParts(addDays(startOfLocalDay(nowIso, chat.tz), 1), chat.tz)
      due = localToUtcIso({ year: p.year, month: p.month, day: p.day, hour: 9, minute: 0 }, chat.tz)
    } else {
      const shift = (6 - p0.weekday + 7) % 7 || 7
      const p = localParts(addDays(startOfLocalDay(nowIso, chat.tz), shift), chat.tz)
      due = localToUtcIso({ year: p.year, month: p.month, day: p.day, hour: 12, minute: 0 }, chat.tz)
    }
    await db.updateTask(env.DB, taskId, {
      due_at: due, remind_at: addMinutes(due, -chat.remind_before_min),
    })
    const card = taskCard({ ...task, due_at: due }, { tz: chat.tz, nowIso })
    await tg.editMessageText(env, chatId, cb.message.message_id, card.text,
      { reply_markup: card.reply_markup })
    await tg.answerCallback(env, cb.id, 'Записал')
  }
}

async function handleSettings(cb, chat, args, env, nowIso) {
  const [kind, ...value] = args
  if (kind === 'digest') {
    if (value[0] === 'off') {
      await db.setChatSetting(env.DB, chat.chat_id, 'digest_enabled', 0)
      await tg.answerCallback(env, cb.id, 'Дайджест выключен')
    } else {
      await db.setChatSetting(env.DB, chat.chat_id, 'digest_enabled', 1)
      await db.setChatSetting(env.DB, chat.chat_id, 'digest_time', value.join(':'))
      await tg.answerCallback(env, cb.id, `Дайджест в ${value.join(':')}`)
    }
    return
  }
  if (kind === 'pre') {
    await db.setChatSetting(env.DB, chat.chat_id, 'remind_before_min', Number(value[0]))
    await tg.answerCallback(env, cb.id, `Напомню за ${value[0]} мин`)
  }
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npx vitest run test/router.test.js`
Expected: PASS, 11 тестов

- [ ] **Step 5: Commit**

```bash
git add src/router.js test/router.test.js
git commit -m "feat: маршрутизация команд, сообщений и кнопок"
```

---

### Task 10: Напоминания и утренний дайджест

**Files:**
- Create: `src/reminders.js`, `test/reminders.test.js`

**Interfaces:**
- Consumes: `db.js`, `telegram.js`, `format.js`, `time.js`
- Produces: `runTick(env, nowIso) -> Promise<{pre: number, due: number, digests: number}>`

Правила: флаг ставится только после успешной отправки; дайджест шлётся один раз в день на чат (`last_digest_date`); в выборку попадают все просроченные неотправленные, а не только текущая минута.

- [ ] **Step 1: Написать падающие тесты `test/reminders.test.js`**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runTick } from '../src/reminders.js'
import * as tg from '../src/telegram.js'
import * as db from '../src/db.js'

const env = { BOT_TOKEN: 't', DB: {} }
const CHAT = -1001
const NOW = '2026-08-05T09:00:00Z' // 12:00 МСК

const chat = {
  chat_id: CHAT, tz: 'Europe/Moscow', digest_time: '10:00',
  digest_enabled: 1, remind_before_min: 30, last_digest_date: '2026-08-05',
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(tg, 'sendMessage').mockResolvedValue({})
  vi.spyOn(db, 'duePre').mockResolvedValue([])
  vi.spyOn(db, 'dueNow').mockResolvedValue([])
  vi.spyOn(db, 'chatsForDigest').mockResolvedValue([chat])
  vi.spyOn(db, 'markNotified').mockResolvedValue()
  vi.spyOn(db, 'markDigestSent').mockResolvedValue()
  vi.spyOn(db, 'tasksBetween').mockResolvedValue([])
  vi.spyOn(db, 'overdueTasks').mockResolvedValue([])
})

describe('runTick: напоминания', () => {
  const task = {
    id: 1, chat_id: CHAT, title: 'К врачу', due_at: '2026-08-05T09:30:00Z',
    remind_at: '2026-08-05T09:00:00Z', assignee: 'danya', repeat_rule: null,
  }

  it('шлёт предупреждение и помечает', async () => {
    vi.spyOn(db, 'duePre').mockResolvedValue([task])
    const res = await runTick(env, NOW)
    expect(res.pre).toBe(1)
    expect(tg.sendMessage.mock.calls[0][2]).toContain('К врачу')
    expect(db.markNotified).toHaveBeenCalledWith(env.DB, 1, 'pre')
  })

  it('шлёт напоминание в момент срока', async () => {
    vi.spyOn(db, 'dueNow').mockResolvedValue([{ ...task, due_at: '2026-08-05T09:00:00Z' }])
    const res = await runTick(env, NOW)
    expect(res.due).toBe(1)
    expect(db.markNotified).toHaveBeenCalledWith(env.DB, 1, 'due')
  })

  it('если отправка упала — флаг не ставим', async () => {
    vi.spyOn(db, 'duePre').mockResolvedValue([task])
    vi.spyOn(tg, 'sendMessage').mockRejectedValue(new Error('network'))
    const res = await runTick(env, NOW)
    expect(res.pre).toBe(0)
    expect(db.markNotified).not.toHaveBeenCalled()
  })
})

describe('runTick: дайджест', () => {
  it('в 10:00 по местному шлёт дайджест один раз', async () => {
    const at10 = '2026-08-05T07:00:00Z' // 10:00 МСК
    vi.spyOn(db, 'chatsForDigest').mockResolvedValue([{ ...chat, last_digest_date: null }])
    vi.spyOn(db, 'tasksBetween').mockResolvedValue([
      { id: 5, title: 'Зарядка', due_at: '2026-08-05T09:00:00Z', assignee: 'danya' },
    ])
    const res = await runTick(env, at10)
    expect(res.digests).toBe(1)
    expect(tg.sendMessage.mock.calls[0][2]).toContain('Зарядка')
    expect(db.markDigestSent).toHaveBeenCalledWith(env.DB, CHAT, '2026-08-05')
  })

  it('повторно в тот же день не шлёт', async () => {
    const at10 = '2026-08-05T07:00:00Z'
    vi.spyOn(db, 'chatsForDigest').mockResolvedValue([{ ...chat, last_digest_date: '2026-08-05' }])
    const res = await runTick(env, at10)
    expect(res.digests).toBe(0)
  })

  it('не в час дайджеста — молчит', async () => {
    vi.spyOn(db, 'chatsForDigest').mockResolvedValue([{ ...chat, last_digest_date: null }])
    const res = await runTick(env, NOW) // 12:00 МСК
    expect(res.digests).toBe(0)
  })

  it('догоняет пропущенный дайджест позже в тот же день', async () => {
    const at11 = '2026-08-05T08:05:00Z' // 11:05 МСК
    vi.spyOn(db, 'chatsForDigest').mockResolvedValue([{ ...chat, last_digest_date: '2026-08-04' }])
    const res = await runTick(env, at11)
    expect(res.digests).toBe(1)
  })
})
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npx vitest run test/reminders.test.js`
Expected: FAIL

- [ ] **Step 3: Реализовать `src/reminders.js`**

Догоняющая логика дайджеста: шлём, если местное время не раньше назначенного и сегодня ещё не слали, но не позже 3 часов после назначенного (чтобы ночной сбой не выстрелил в полночь).

```js
import * as db from './db.js'
import * as tg from './telegram.js'
import { reminderText, digest, taskKeyboard } from './format.js'
import { localParts, localDateKey, startOfLocalDay, addDays } from './time.js'

const DIGEST_CATCHUP_MIN = 180

async function notify(env, task, nowIso, tz, kind) {
  const text = reminderText(task, { tz, nowIso, kind })
  await tg.sendMessage(env, task.chat_id, text, { reply_markup: taskKeyboard(task.id) })
  await db.markNotified(env.DB, task.id, kind)
}

export async function runTick(env, nowIso) {
  const stats = { pre: 0, due: 0, digests: 0 }
  const chatTz = new Map()

  const chats = await db.chatsForDigest(env.DB)
  for (const c of chats) chatTz.set(c.chat_id, c.tz)
  const tzOf = (chatId) => chatTz.get(chatId) ?? env.DEFAULT_TZ ?? 'Europe/Moscow'

  for (const task of await db.duePre(env.DB, nowIso)) {
    try {
      await notify(env, task, nowIso, tzOf(task.chat_id), 'pre')
      stats.pre++
    } catch (e) {
      console.error('pre-напоминание не ушло', task.id, e.message)
    }
  }

  for (const task of await db.dueNow(env.DB, nowIso)) {
    try {
      await notify(env, task, nowIso, tzOf(task.chat_id), 'due')
      stats.due++
    } catch (e) {
      console.error('напоминание не ушло', task.id, e.message)
    }
  }

  for (const chat of chats) {
    try {
      if (await maybeDigest(env, chat, nowIso)) stats.digests++
    } catch (e) {
      console.error('дайджест не ушёл', chat.chat_id, e.message)
    }
  }

  return stats
}

async function maybeDigest(env, chat, nowIso) {
  const tz = chat.tz
  const today = localDateKey(nowIso, tz)
  if (chat.last_digest_date === today) return false

  const { hour, minute } = localParts(nowIso, tz)
  const [dh, dm] = String(chat.digest_time).split(':').map(Number)
  const nowMin = hour * 60 + minute
  const targetMin = dh * 60 + dm
  if (nowMin < targetMin || nowMin > targetMin + DIGEST_CATCHUP_MIN) return false

  const from = startOfLocalDay(nowIso, tz)
  const to = addDays(from, 1)
  const todayTasks = await db.tasksBetween(env.DB, chat.chat_id, from, to)
  const overdue = await db.overdueTasks(env.DB, chat.chat_id, from)

  await tg.sendMessage(env, chat.chat_id, digest(todayTasks, overdue, { tz, nowIso }))
  await db.markDigestSent(env.DB, chat.chat_id, today)
  return true
}
```

- [ ] **Step 4: Запустить тесты**

Run: `npx vitest run test/reminders.test.js`
Expected: PASS, 7 тестов

- [ ] **Step 5: Commit**

```bash
git add src/reminders.js test/reminders.test.js
git commit -m "feat: напоминания по cron и утренний дайджест"
```

---

### Task 11: Точка входа и защита

**Files:**
- Modify: `src/index.js`
- Create: `test/index.test.js`

**Interfaces:**
- Consumes: `router.js`, `reminders.js`
- Produces: `export default { fetch, scheduled }`

Проверки на входе: путь `/tg`, заголовок `X-Telegram-Bot-Api-Secret-Token` совпадает с `WEBHOOK_SECRET`, `chat_id` входит в `ALLOWED_CHATS` (список через запятую; пустая переменная — режим первичной настройки, когда бот отвечает своим chat_id и ничего не делает).

Ответ Telegram всегда `200` — иначе Telegram будет слать апдейт повторно.

- [ ] **Step 1: Написать падающие тесты `test/index.test.js`**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker from '../src/index.js'
import * as router from '../src/router.js'
import * as reminders from '../src/reminders.js'

const env = {
  BOT_TOKEN: 't', BOT_USERNAME: 'planer_bot', WEBHOOK_SECRET: 'secret',
  ALLOWED_CHATS: '-1001', DB: {},
}

const post = (body, secret = 'secret') => new Request('https://x/tg', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret },
  body: JSON.stringify(body),
})

const update = { update_id: 1, message: { message_id: 1, text: '/день', chat: { id: -1001, type: 'supergroup' }, from: { id: 7 } } }

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(router, 'handleUpdate').mockResolvedValue()
  vi.spyOn(reminders, 'runTick').mockResolvedValue({ pre: 0, due: 0, digests: 0 })
})

describe('fetch', () => {
  it('передаёт апдейт роутеру', async () => {
    const res = await worker.fetch(post(update), env, { waitUntil: (p) => p })
    expect(res.status).toBe(200)
    expect(router.handleUpdate).toHaveBeenCalled()
  })

  it('без секрета — 401 и роутер не зовём', async () => {
    const res = await worker.fetch(post(update, 'wrong'), env, { waitUntil: (p) => p })
    expect(res.status).toBe(401)
    expect(router.handleUpdate).not.toHaveBeenCalled()
  })

  it('чужой чат игнорируется', async () => {
    const foreign = { ...update, message: { ...update.message, chat: { id: -999, type: 'group' } } }
    const res = await worker.fetch(post(foreign), env, { waitUntil: (p) => p })
    expect(res.status).toBe(200)
    expect(router.handleUpdate).not.toHaveBeenCalled()
  })

  it('ошибка внутри роутера не роняет ответ', async () => {
    vi.spyOn(router, 'handleUpdate').mockRejectedValue(new Error('boom'))
    const res = await worker.fetch(post(update), env, { waitUntil: (p) => p })
    expect(res.status).toBe(200)
  })

  it('GET / отвечает без секрета', async () => {
    const res = await worker.fetch(new Request('https://x/'), env, { waitUntil: (p) => p })
    expect(res.status).toBe(200)
  })
})

describe('scheduled', () => {
  it('запускает тик напоминаний', async () => {
    await worker.scheduled({ scheduledTime: Date.parse('2026-08-05T09:00:00Z') }, env, { waitUntil: (p) => p })
    expect(reminders.runTick).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Запустить, убедиться что падает**

Run: `npx vitest run test/index.test.js`
Expected: FAIL

- [ ] **Step 3: Реализовать `src/index.js`**

```js
import * as router from './router.js'
import * as reminders from './reminders.js'

function chatIdOf(update) {
  return update?.message?.chat?.id
    ?? update?.edited_message?.chat?.id
    ?? update?.callback_query?.message?.chat?.id
    ?? null
}

function allowed(env, chatId) {
  const list = (env.ALLOWED_CHATS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (!list.length) return true
  return list.includes(String(chatId))
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    if (request.method === 'GET') {
      return new Response('tg-planner жив')
    }

    if (url.pathname !== '/tg') return new Response('not found', { status: 404 })

    if (request.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
      return new Response('unauthorized', { status: 401 })
    }

    let update
    try {
      update = await request.json()
    } catch {
      return new Response('ok')
    }

    const chatId = chatIdOf(update)
    if (chatId == null || !allowed(env, chatId)) {
      console.log('апдейт из неразрешённого чата', chatId)
      return new Response('ok')
    }

    const nowIso = new Date().toISOString()
    try {
      await router.handleUpdate(update, env, nowIso)
    } catch (e) {
      console.error('ошибка обработки апдейта', e.message, e.stack)
    }
    return new Response('ok')
  },

  async scheduled(event, env, ctx) {
    const nowIso = new Date(event.scheduledTime ?? Date.now()).toISOString()
    try {
      const stats = await reminders.runTick(env, nowIso)
      if (stats.pre || stats.due || stats.digests) console.log('tick', JSON.stringify(stats))
    } catch (e) {
      console.error('ошибка тика', e.message, e.stack)
    }
  },
}
```

- [ ] **Step 4: Запустить весь набор тестов**

Run: `npm test`
Expected: PASS, все файлы зелёные

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: точка входа, проверка секрета и белый список чатов"
```

---

### Task 12: HTTP API и CLI — добавление дел из Claude Code

**Files:**
- Create: `src/tasks.js`, `src/api.js`, `scripts/planer.mjs`, `test/api.test.js`
- Modify: `src/router.js` (создание дела переезжает в `tasks.js`), `src/index.js` (маршрут `/api/*`), `package.json`

**Interfaces:**
- Consumes: `db.js`, `parse/index.js`, `format.js`, `telegram.js`, `assignee.js`, `time.js`
- Produces:
  - `addTaskFromText(env, {chatId, text, authorRole, authorId, nowIso}) -> {task, chat, parsed}` — создаёт дело и шлёт карточку в чат
  - `handleApi(request, env, nowIso) -> Response`
  - CLI: `npm run add -- "завтра в 15 к врачу"`, `npm run list -- week`

**Контракт API** (авторизация: заголовок `Authorization: Bearer <API_TOKEN>`):

| Метод | Путь | Тело / параметры | Ответ |
|---|---|---|---|
| POST | `/api/tasks` | `{text, assignee?, chat_id?, notify?}` | `{ok: true, task}` |
| GET | `/api/tasks` | `?range=day\|tomorrow\|week\|undated` | `{ok: true, tasks: [...]}` |
| POST | `/api/tasks/:id/done` | — | `{ok: true}` |

`assignee` по умолчанию `danya` (пишу от имени Дани), `chat_id` по умолчанию — первый из `ALLOWED_CHATS`,
`notify: false` создаёт дело молча, без карточки в чат.

- [ ] **Step 1: Вынести создание дела в `src/tasks.js`**

```js
import * as db from './db.js'
import * as tg from './telegram.js'
import { parseTask } from './parse/index.js'
import { detectAssignee } from './assignee.js'
import { taskCard } from './format.js'
import { addMinutes } from './time.js'

export async function addTaskFromText(env, { chatId, text, authorRole, authorId, nowIso, notify = true, assignee: forced = null }) {
  const chat = await db.getChat(env.DB, chatId, {
    tz: env.DEFAULT_TZ,
    digestTime: env.DEFAULT_DIGEST_TIME,
    remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN),
  })

  const detected = detectAssignee(text, authorRole)
  const assignee = forced ?? detected.assignee
  const parsed = await parseTask(env, detected.text, nowIso, chat.tz)
  if (!parsed.title) return { task: null, chat, parsed }

  const task = await db.createTask(env.DB, {
    chat_id: chatId,
    title: parsed.title,
    due_at: parsed.dueAt,
    remind_at: parsed.dueAt ? addMinutes(parsed.dueAt, -chat.remind_before_min) : null,
    assignee,
    created_by: authorId,
    repeat_rule: parsed.repeatRule,
    created_at: nowIso,
  })

  const full = { ...task, assignee, repeat_rule: parsed.repeatRule }

  if (notify && parsed.dueAt) {
    const card = taskCard(full, { tz: chat.tz, nowIso })
    await tg.sendMessage(env, chatId, card.text, { reply_markup: card.reply_markup })
  }

  return { task: full, chat, parsed }
}
```

- [ ] **Step 2: Переключить `src/router.js` на `tasks.js`**

Заменить тело функции `createFromText` в `src/router.js` на вызов общей логики. Остальной код роутера не трогать.

```js
import { addTaskFromText } from './tasks.js'

async function createFromText(text, msg, chat, role, env, nowIso) {
  const { task } = await addTaskFromText(env, {
    chatId: chat.chat_id, text, authorRole: role, authorId: msg.from.id, nowIso,
  })

  if (!task) {
    await tg.sendMessage(env, chat.chat_id, 'Не понял, что за дело. Напиши коротко: что и когда.')
    return
  }

  if (!task.due_at) {
    await tg.sendMessage(env, chat.chat_id, `📌 <b>${task.title}</b>\n\nКогда напомнить?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: 'Сегодня', callback_data: `when:${task.id}:today` },
          { text: 'Завтра', callback_data: `when:${task.id}:tomorrow` },
          { text: 'В выходные', callback_data: `when:${task.id}:weekend` },
          { text: 'Без срока', callback_data: `when:${task.id}:none` },
        ]],
      },
    })
  }
}
```

Убрать из `src/router.js` ставшие лишними импорты `parseTask`, `detectAssignee` и `taskCard`, если они больше не используются.

- [ ] **Step 3: Написать падающие тесты `test/api.test.js`**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleApi } from '../src/api.js'
import * as tasks from '../src/tasks.js'
import * as db from '../src/db.js'

const env = {
  API_TOKEN: 'sekret', ALLOWED_CHATS: '-1001', DEFAULT_TZ: 'Europe/Moscow',
  DEFAULT_DIGEST_TIME: '10:00', DEFAULT_REMIND_BEFORE_MIN: '30', DB: {},
}
const NOW = '2026-08-05T09:00:00Z'

const req = (path, { method = 'GET', body, token = 'sekret' } = {}) =>
  new Request(`https://x${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(tasks, 'addTaskFromText').mockResolvedValue({
    task: { id: 7, title: 'К врачу', due_at: '2026-08-06T12:00:00.000Z', assignee: 'danya' },
    chat: { chat_id: -1001, tz: 'Europe/Moscow' },
    parsed: { source: 'local' },
  })
})

describe('handleApi', () => {
  it('без токена — 401', async () => {
    const res = await handleApi(req('/api/tasks', { method: 'POST', body: { text: 'x' }, token: null }), env, NOW)
    expect(res.status).toBe(401)
  })

  it('с неверным токеном — 401', async () => {
    const res = await handleApi(req('/api/tasks', { method: 'POST', body: { text: 'x' }, token: 'wrong' }), env, NOW)
    expect(res.status).toBe(401)
  })

  it('создаёт дело и возвращает его', async () => {
    const res = await handleApi(req('/api/tasks', { method: 'POST', body: { text: 'завтра в 15 к врачу' } }), env, NOW)
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.ok).toBe(true)
    expect(data.task.title).toBe('К врачу')
    expect(tasks.addTaskFromText).toHaveBeenCalled()
    expect(tasks.addTaskFromText.mock.calls[0][1].chatId).toBe(-1001)
  })

  it('пустой текст — 400', async () => {
    const res = await handleApi(req('/api/tasks', { method: 'POST', body: { text: '  ' } }), env, NOW)
    expect(res.status).toBe(400)
  })

  it('уважает assignee и notify', async () => {
    await handleApi(req('/api/tasks', {
      method: 'POST', body: { text: 'купить корм', assignee: 'zhenya', notify: false },
    }), env, NOW)
    const arg = tasks.addTaskFromText.mock.calls[0][1]
    expect(arg.assignee).toBe('zhenya')
    expect(arg.notify).toBe(false)
  })

  it('список на неделю', async () => {
    const between = vi.spyOn(db, 'tasksBetween').mockResolvedValue([{ id: 1, title: 'Дело' }])
    vi.spyOn(db, 'getChat').mockResolvedValue({ chat_id: -1001, tz: 'Europe/Moscow' })
    const res = await handleApi(req('/api/tasks?range=week'), env, NOW)
    const data = await res.json()
    expect(data.tasks).toHaveLength(1)
    const [, , from, to] = between.mock.calls[0]
    expect(new Date(to) - new Date(from)).toBe(7 * 86400000)
  })

  it('отметка выполнения', async () => {
    vi.spyOn(db, 'getTask').mockResolvedValue({ id: 7, chat_id: -1001, title: 'Дело', repeat_rule: null })
    const done = vi.spyOn(db, 'markDone').mockResolvedValue()
    const res = await handleApi(req('/api/tasks/7/done', { method: 'POST' }), env, NOW)
    expect(res.status).toBe(200)
    expect(done).toHaveBeenCalledWith(env.DB, 7)
  })

  it('неизвестный путь — 404', async () => {
    const res = await handleApi(req('/api/nope'), env, NOW)
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 4: Запустить, убедиться что падает**

Run: `npx vitest run test/api.test.js`
Expected: FAIL

- [ ] **Step 5: Реализовать `src/api.js`**

```js
import * as db from './db.js'
import * as tasks from './tasks.js'
import { startOfLocalDay, addDays } from './time.js'

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8' },
})

function authorized(request, env) {
  const header = request.headers.get('authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  return Boolean(env.API_TOKEN) && token === env.API_TOKEN
}

function defaultChatId(env, explicit) {
  if (explicit) return Number(explicit)
  const first = (env.ALLOWED_CHATS ?? '').split(',')[0]?.trim()
  return first ? Number(first) : null
}

export async function handleApi(request, env, nowIso) {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401)

  const url = new URL(request.url)
  const parts = url.pathname.split('/').filter(Boolean) // ['api','tasks',...]

  if (parts[1] !== 'tasks') return json({ ok: false, error: 'not found' }, 404)

  if (parts.length === 2 && request.method === 'POST') {
    const body = await request.json().catch(() => ({}))
    const text = String(body.text ?? '').trim()
    if (!text) return json({ ok: false, error: 'пустой текст' }, 400)

    const chatId = defaultChatId(env, body.chat_id)
    if (!chatId) return json({ ok: false, error: 'не задан chat_id' }, 400)

    const { task, parsed } = await tasks.addTaskFromText(env, {
      chatId, text, authorRole: 'danya', authorId: 0, nowIso,
      notify: body.notify !== false,
      assignee: body.assignee ?? null,
    })
    if (!task) return json({ ok: false, error: 'не понял текст' }, 400)
    return json({ ok: true, task, source: parsed.source })
  }

  if (parts.length === 2 && request.method === 'GET') {
    const chatId = defaultChatId(env, url.searchParams.get('chat_id'))
    const chat = await db.getChat(env.DB, chatId, {
      tz: env.DEFAULT_TZ, digestTime: env.DEFAULT_DIGEST_TIME,
      remindBeforeMin: Number(env.DEFAULT_REMIND_BEFORE_MIN),
    })
    const range = url.searchParams.get('range') ?? 'week'

    if (range === 'undated') return json({ ok: true, tasks: await db.undatedTasks(env.DB, chatId) })

    const shift = range === 'tomorrow' ? 1 : 0
    const span = range === 'week' ? 7 : 1
    const from = addDays(startOfLocalDay(nowIso, chat.tz), shift)
    const to = addDays(from, span)
    return json({ ok: true, tasks: await db.tasksBetween(env.DB, chatId, from, to) })
  }

  if (parts.length === 4 && parts[3] === 'done' && request.method === 'POST') {
    const id = Number(parts[2])
    const task = await db.getTask(env.DB, id)
    if (!task) return json({ ok: false, error: 'дело не найдено' }, 404)
    await db.markDone(env.DB, id)
    return json({ ok: true })
  }

  return json({ ok: false, error: 'not found' }, 404)
}
```

- [ ] **Step 6: Подключить маршрут в `src/index.js`**

Вставить в `fetch` сразу после разбора `url`, до проверки `/tg`:

```js
    if (url.pathname.startsWith('/api/')) {
      const nowIso = new Date().toISOString()
      try {
        return await api.handleApi(request, env, nowIso)
      } catch (e) {
        console.error('ошибка API', e.message, e.stack)
        return new Response(JSON.stringify({ ok: false, error: 'internal' }), {
          status: 500, headers: { 'content-type': 'application/json' },
        })
      }
    }
```

и добавить импорт `import * as api from './api.js'`. Проверку `request.method === 'GET'` для корня перенести ниже блока `/api/`, чтобы `GET /api/tasks` не перехватывался.

- [ ] **Step 7: Создать CLI `scripts/planer.mjs`**

Настройки читаются из `.env.local` (в `.gitignore`), чтобы токен не попал в git и в историю команд.

```js
import { readFileSync } from 'node:fs'

function loadEnv() {
  try {
    const text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
      if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '')
    }
  } catch { /* переменные могут прийти из окружения */ }
}

loadEnv()
const base = process.env.WORKER_URL
const token = process.env.API_TOKEN
if (!base || !token) {
  console.error('Нужны WORKER_URL и API_TOKEN в .env.local')
  process.exit(1)
}

const call = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
  })
  const data = await res.json()
  if (!data.ok) {
    console.error('Ошибка:', data.error)
    process.exit(1)
  }
  return data
}

const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'add') {
  const text = rest.join(' ')
  const { task } = await call('/api/tasks', { method: 'POST', body: JSON.stringify({ text }) })
  console.log(`✅ ${task.title} — ${task.due_at ?? 'без срока'} (${task.assignee})`)
} else if (cmd === 'list') {
  const range = rest[0] ?? 'week'
  const { tasks } = await call(`/api/tasks?range=${range}`)
  if (!tasks.length) console.log('Пусто')
  for (const t of tasks) console.log(`#${t.id} ${t.due_at ?? '—'} · ${t.title} · ${t.assignee}`)
} else if (cmd === 'done') {
  await call(`/api/tasks/${rest[0]}/done`, { method: 'POST' })
  console.log('✅ Отметил')
} else {
  console.log('Команды: add "текст" | list [day|tomorrow|week|undated] | done <id>')
}
```

- [ ] **Step 8: Добавить скрипты в `package.json`**

```json
"add": "node scripts/planer.mjs add",
"list": "node scripts/planer.mjs list",
"done": "node scripts/planer.mjs done"
```

- [ ] **Step 9: Запустить весь набор тестов**

Run: `npm test`
Expected: PASS — включая `test/api.test.js` (8 тестов) и не сломанный `test/router.test.js`

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: HTTP API и CLI для добавления дел извне"
```

---

### Task 13: Развёртывание и инструкция

**Files:**
- Create: `SETUP.md`, `scripts/set-webhook.mjs`
- Modify: `wrangler.toml` (реальный `database_id`), `package.json` (скрипт `webhook`)

**Interfaces:**
- Consumes: готовый Worker
- Produces: работающий бот в тестовой группе

- [ ] **Step 1: Создать `scripts/set-webhook.mjs`**

Скрипт вызывается вручную после деплоя. Токен и секрет передаются переменными окружения, чтобы не попасть в историю команд.

```js
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
```

- [ ] **Step 2: Добавить скрипт в `package.json`**

```json
"webhook": "node scripts/set-webhook.mjs"
```

- [ ] **Step 3: Создать базу и применить миграции**

```bash
npx wrangler d1 create tg-planner
```

Вывод содержит `database_id` — вписать его в `wrangler.toml` вместо `PLACEHOLDER_FILL_ON_DEPLOY`, затем:

```bash
npx wrangler d1 migrations apply tg-planner --remote
```

- [ ] **Step 4: Записать секреты**

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put BOT_USERNAME
npx wrangler secret put ALLOWED_CHATS
npx wrangler secret put API_TOKEN
```

`WEBHOOK_SECRET` и `API_TOKEN` — случайные строки, сгенерировать: `node -e "console.log(crypto.randomUUID())"`.
`ALLOWED_CHATS` на первом шаге оставить пустым, заполнить после Шага 6.

Создать `.env.local` (уже в `.gitignore`) для CLI:

```
WORKER_URL=https://tg-planner.<аккаунт>.workers.dev
API_TOKEN=<тот же API_TOKEN>
```

- [ ] **Step 5: Задеплоить**

```bash
npx wrangler deploy
```

Expected: в выводе адрес вида `https://tg-planner.<аккаунт>.workers.dev`

- [ ] **Step 6: Подключить вебхук и узнать chat_id**

```bash
BOT_TOKEN=... WEBHOOK_SECRET=... WORKER_URL=https://tg-planner.<аккаунт>.workers.dev npm run webhook
```

Expected: `{"ok":true,"result":true,"description":"Webhook was set"}`

Добавить бота в тестовую группу, отправить `/день`. В логах (`npx wrangler tail`) появится chat_id — записать его в секрет `ALLOWED_CHATS`.

- [ ] **Step 7: Живая проверка сценариев**

Проверить в тестовой группе по очереди:

1. `@bot завтра в 15:00 к врачу` → карточка с датой «завтра, … 15:00»
2. `@bot через 3 минуты проверить бота` → через 3 минуты приходит напоминание
3. Нажать «✅ Готово» → сообщение зачёркивается
4. `@bot каждый вторник вынести мусор` → карточка с пометкой «каждый вторник»; после «Готово» бот пишет следующий срок
5. `@bot Жень, купи корм` → ответственный Женя
6. `/день`, `/неделя`, `/мои`, `/настройки` → списки и настройки открываются
7. `@bot купить лампочки` → бот спрашивает срок кнопками
8. Кнопка «⏰ Перенести» → «+1 час» → срок сдвинулся
9. `npm run add -- "в субботу в 12 забрать костюм"` → карточка появилась в чате
10. `npm run list -- week` → в консоли список дел на неделю

- [ ] **Step 8: Написать `SETUP.md`**

Файл для Дани: как создать бота у @BotFather, как завести Cloudflare, как задеплоить, как поменять настройки, что делать при ошибках (`wrangler tail` для просмотра логов, `wrangler d1 execute tg-planner --remote --command "SELECT * FROM tasks"` для просмотра базы). Каждый термин объясняется одной фразой.

- [ ] **Step 9: Подключить рабочий чат**

Добавить бота в общий чат с Женей, добавить его chat_id в `ALLOWED_CHATS` (через запятую), передеплоить.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "chore: скрипт вебхука и инструкция по развёртыванию"
```

---

## Порядок исполнения

Задачи 2–8 независимы друг от друга и могут выполняться параллельно (каждая опирается только на `src/time.js` из Task 2 и на собственные тесты). Задачи 9–12 требуют готовых 2–8 и выполняются последовательно. Task 13 — последняя, выполняется вместе с Даней, поскольку требует его аккаунтов.
