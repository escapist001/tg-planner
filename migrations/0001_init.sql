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
