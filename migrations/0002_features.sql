-- Поля под новые возможности: зомби-дела, теги, передача, заметки, подтверждение.
ALTER TABLE tasks ADD COLUMN postpone_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN tag           TEXT;
ALTER TABLE tasks ADD COLUMN hard_day      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN handoff_from  TEXT;
ALTER TABLE tasks ADD COLUMN confirmed     INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_tasks_tag ON tasks (chat_id, tag, status);

-- Настройки ритуалов.
ALTER TABLE chats ADD COLUMN review_time  TEXT NOT NULL DEFAULT '23:30';
ALTER TABLE chats ADD COLUMN weekly_time  TEXT NOT NULL DEFAULT '21:00';
ALTER TABLE chats ADD COLUMN last_review_date TEXT;
ALTER TABLE chats ADD COLUMN last_weekly_date TEXT;

-- Счётчики: полоса без просрочек, подхваты, прогулки.
CREATE TABLE IF NOT EXISTS stats (
  chat_id    INTEGER NOT NULL,
  key        TEXT    NOT NULL,
  value      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (chat_id, key)
);

-- Закреплённые сообщения бота, чтобы обновлять их на месте.
CREATE TABLE IF NOT EXISTS pinned (
  chat_id    INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  message_id INTEGER NOT NULL,
  PRIMARY KEY (chat_id, kind)
);

-- Таймлайн дня свадьбы: по часам, с контактами подрядчиков.
CREATE TABLE IF NOT EXISTS timeline (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id  INTEGER NOT NULL,
  at       TEXT    NOT NULL,
  title    TEXT    NOT NULL,
  contact  TEXT,
  notified INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_timeline_at ON timeline (chat_id, notified, at);

-- Произвольные флаги чата: тихий день, защищённый вечер, состояние прогона.
CREATE TABLE IF NOT EXISTS chat_flags (
  chat_id INTEGER NOT NULL,
  key     TEXT    NOT NULL,
  value   TEXT,
  PRIMARY KEY (chat_id, key)
);

-- Заметки к делу: вес собаки, клиника, вакцина.
CREATE TABLE IF NOT EXISTS task_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_task ON task_notes (task_id);
