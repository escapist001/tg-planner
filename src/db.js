const TASK_FIELDS = 'id, chat_id, title, due_at, remind_at, assignee, created_by, status, repeat_rule, parent_id, notified_pre, notified_due, created_at, postpone_count, tag, hard_day, handoff_from, confirmed'
const UPDATABLE = new Set(['title', 'due_at', 'remind_at', 'assignee', 'status',
  'repeat_rule', 'notified_pre', 'notified_due', 'postpone_count', 'tag', 'hard_day',
  'handoff_from', 'confirmed', 'parent_id'])
const CHAT_SETTINGS = new Set(['tz', 'digest_time', 'digest_enabled', 'remind_before_min',
  'review_time', 'weekly_time'])

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
    `INSERT INTO tasks (chat_id, title, due_at, remind_at, assignee, created_by, status, repeat_rule, parent_id, created_at, tag)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?) RETURNING id`,
  ).bind(t.chat_id, t.title, t.due_at ?? null, t.remind_at ?? null, t.assignee,
    t.created_by, t.repeat_rule ?? null, t.parent_id ?? null, t.created_at, t.tag ?? null).first()
  return { ...t, id: row.id, status: 'open', notified_pre: 0, notified_due: 0, postpone_count: 0 }
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

// ─── Флаги чата: тихий день, защищённый вечер, состояние прогона ───

export async function getFlag(db, chatId, key) {
  const row = await db.prepare('SELECT value FROM chat_flags WHERE chat_id = ? AND key = ?')
    .bind(chatId, key).first()
  return row?.value ?? null
}

export async function setFlag(db, chatId, key, value) {
  await db.prepare(
    `INSERT INTO chat_flags (chat_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value`,
  ).bind(chatId, key, value == null ? null : String(value)).run()
}

export async function deleteFlag(db, chatId, key) {
  await db.prepare('DELETE FROM chat_flags WHERE chat_id = ? AND key = ?').bind(chatId, key).run()
}

// ─── Счётчики: полоса без просрочек, подхваты, прогулки ───

export async function getStat(db, chatId, key) {
  const row = await db.prepare('SELECT value FROM stats WHERE chat_id = ? AND key = ?')
    .bind(chatId, key).first()
  return row?.value ?? 0
}

export async function setStat(db, chatId, key, value, nowIso) {
  await db.prepare(
    `INSERT INTO stats (chat_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(chatId, key, value, nowIso).run()
}

export async function bumpStat(db, chatId, key, delta, nowIso) {
  await db.prepare(
    `INSERT INTO stats (chat_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(chat_id, key) DO UPDATE SET value = stats.value + excluded.value, updated_at = excluded.updated_at`,
  ).bind(chatId, key, delta, nowIso).run()
}

export async function allStats(db, chatId) {
  const { results } = await db.prepare('SELECT key, value FROM stats WHERE chat_id = ?')
    .bind(chatId).all()
  return Object.fromEntries((results ?? []).map((r) => [r.key, r.value]))
}

// ─── Закреплённые сообщения ───

export async function getPinned(db, chatId, kind) {
  const row = await db.prepare('SELECT message_id FROM pinned WHERE chat_id = ? AND kind = ?')
    .bind(chatId, kind).first()
  return row?.message_id ?? null
}

export async function setPinned(db, chatId, kind, messageId) {
  await db.prepare(
    `INSERT INTO pinned (chat_id, kind, message_id) VALUES (?, ?, ?)
     ON CONFLICT(chat_id, kind) DO UPDATE SET message_id = excluded.message_id`,
  ).bind(chatId, kind, messageId).run()
}

// ─── Дела по тегу ───

export async function tasksByTag(db, chatId, tag) {
  const { results } = await db.prepare(
    `SELECT ${TASK_FIELDS} FROM tasks WHERE chat_id = ? AND tag = ? AND status != 'cancelled'
     ORDER BY due_at IS NULL, due_at`,
  ).bind(chatId, tag).all()
  return results ?? []
}

export async function tagStats(db, chatId, tag) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
     FROM tasks WHERE chat_id = ? AND tag = ? AND status != 'cancelled'`,
  ).bind(chatId, tag).first()
  return { total: row?.total ?? 0, done: row?.done ?? 0 }
}

// ─── Дела дня для разбора и статистики ───

export async function tasksOfDay(db, chatId, fromIso, toIso) {
  const { results } = await db.prepare(
    `SELECT ${TASK_FIELDS} FROM tasks
     WHERE chat_id = ? AND due_at >= ? AND due_at < ? AND status != 'cancelled'
     ORDER BY due_at`,
  ).bind(chatId, fromIso, toIso).all()
  return results ?? []
}

// ─── Заметки к делу ───

export async function addNote(db, taskId, text, nowIso) {
  await db.prepare('INSERT INTO task_notes (task_id, text, created_at) VALUES (?, ?, ?)')
    .bind(taskId, text, nowIso).run()
}

export async function notesFor(db, taskId) {
  const { results } = await db.prepare(
    'SELECT text, created_at FROM task_notes WHERE task_id = ? ORDER BY id DESC LIMIT 10',
  ).bind(taskId).all()
  return results ?? []
}

// ─── Таймлайн дня свадьбы ───

export async function addTimelineItem(db, chatId, at, title, contact) {
  await db.prepare('INSERT INTO timeline (chat_id, at, title, contact) VALUES (?, ?, ?, ?)')
    .bind(chatId, at, title, contact ?? null).run()
}

export async function timelineForChat(db, chatId) {
  const { results } = await db.prepare('SELECT * FROM timeline WHERE chat_id = ? ORDER BY at')
    .bind(chatId).all()
  return results ?? []
}

export async function timelineDue(db, nowIso, aheadIso) {
  const { results } = await db.prepare(
    'SELECT * FROM timeline WHERE notified = 0 AND at > ? AND at <= ? ORDER BY at LIMIT 20',
  ).bind(nowIso, aheadIso).all()
  return results ?? []
}

export async function markTimelineNotified(db, id) {
  await db.prepare('UPDATE timeline SET notified = 1 WHERE id = ?').bind(id).run()
}

// Записи о виденных апдейтах нужны примерно на час (столько Telegram ретраит).
// Без уборки таблица растёт вечно.
export async function pruneSeenUpdates(db, beforeIso) {
  await db.prepare('DELETE FROM seen_updates WHERE seen_at < ?').bind(beforeIso).run()
}

export async function isDuplicateUpdate(db, updateId, nowIso) {
  const row = await db.prepare('SELECT update_id FROM seen_updates WHERE update_id = ?')
    .bind(updateId).first()
  if (row) return true
  await db.prepare('INSERT OR IGNORE INTO seen_updates (update_id, seen_at) VALUES (?, ?)')
    .bind(updateId, nowIso).run()
  return false
}
