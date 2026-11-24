const fail = (status, message) => Object.assign(new Error(message), { status });

export function initializeThreadWorkflow(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_thread_workflow (
      thread_id TEXT PRIMARY KEY, state TEXT NOT NULL, snooze_until TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_thread_completions (
      thread_id TEXT PRIMARY KEY, completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_offline_handled (message_id TEXT PRIMARY KEY);
    CREATE TRIGGER IF NOT EXISTS mail_completed_history AFTER INSERT ON mailbox_thread_messages
    WHEN json_extract(new.data,'$.direction')='inbound' BEGIN
      INSERT OR IGNORE INTO mail_offline_handled SELECT new.id FROM mail_thread_completions
        WHERE thread_id=new.thread_id AND julianday(completed_at)>=julianday(coalesce(
          json_extract(new.data,'$.receivedAt'),json_extract(new.data,'$.occurredAt')));
    END;
    CREATE TABLE IF NOT EXISTS mail_internal_notes (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS mail_internal_notes_thread ON mail_internal_notes(thread_id, created_at);
  `);
}

// The last workflow state is all that pre-migration databases retain.
export function backfillOfflineCompletions(db) {
  db.exec(`INSERT OR IGNORE INTO mail_thread_completions SELECT thread_id,updated_at
      FROM mail_thread_workflow WHERE state='done';
    INSERT OR IGNORE INTO mail_offline_handled SELECT h.id FROM mail_thread_completions c
      JOIN mailbox_reply_headers h ON h.thread_id=c.thread_id
      WHERE h.direction='inbound' AND julianday(h.stamp)<=julianday(c.completed_at)`);
}

// One expression is used by both the folder counts and the selected thread.
export const effectiveFolder = `CASE WHEN w.state='later' AND w.snooze_until<=?
  THEN 'open' ELSE coalesce(w.state,'open') END`;

export function threadWorkflow(db, id, now) {
  const status = db
    .prepare(
      `SELECT ${effectiveFolder} AS state,w.snooze_until AS snoozeUntil
    FROM mail_thread_workflow w WHERE w.thread_id=?`,
    )
    .get(new Date(now).toISOString(), id);
  const notes = db
    .prepare(
      `SELECT id,body,created_at AS createdAt FROM mail_internal_notes
    WHERE thread_id=? ORDER BY created_at,rowid`,
    )
    .all(id);
  return {
    state: status?.state || 'open',
    snoozeUntil: status?.state === 'later' ? status.snoozeUntil : null,
    notes,
  };
}

export function updateThreadWorkflow(db, id, input, now) {
  const state = input?.state;
  if (!['open', 'done', 'later'].includes(state)) throw fail(400, '请选择有效的会话状态');
  let until = null;
  if (state === 'later') {
    const time = typeof input.snoozeUntil === 'string' ? Date.parse(input.snoozeUntil) : NaN;
    if (!Number.isFinite(time) || time <= now) throw fail(400, '请选择未来的提醒时间');
    until = new Date(time).toISOString();
  }
  db.exec('SAVEPOINT update_workflow');
  try {
    if (state === 'done') {
      db.prepare(
        `INSERT INTO mail_thread_completions VALUES(?,?)
        ON CONFLICT(thread_id) DO UPDATE SET completed_at=max(completed_at,excluded.completed_at)`,
      ).run(id, new Date(now).toISOString());
      db.prepare(
        `INSERT OR IGNORE INTO mail_offline_handled SELECT id FROM mailbox_reply_headers
        WHERE thread_id=? AND direction='inbound'`,
      ).run(id);
    }
    db.prepare(
      `INSERT INTO mail_thread_workflow VALUES(?,?,?,?)
    ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state,snooze_until=excluded.snooze_until,updated_at=excluded.updated_at`,
    ).run(id, state, until, new Date(now).toISOString());
    db.exec('RELEASE update_workflow');
  } catch (error) {
    db.exec('ROLLBACK TO update_workflow; RELEASE update_workflow');
    throw error;
  }
  return threadWorkflow(db, id, now);
}

export function addInternalNote(db, id, input, now) {
  const body = typeof input?.body === 'string' ? input.body.trim() : '';
  if (!body || body.length > 4000) throw fail(400, '内部备注应为 1 至 4000 字');
  if (typeof input.clientId !== 'string' || !/^[\w-]{8,128}$/u.test(input.clientId))
    throw fail(400, '备注编号无效');
  db.prepare('INSERT INTO mail_internal_notes VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING').run(
    input.clientId,
    id,
    body,
    new Date(now).toISOString(),
  );
  const saved = db
    .prepare('SELECT thread_id,body FROM mail_internal_notes WHERE id=?')
    .get(input.clientId);
  if (saved.thread_id !== id || saved.body !== body) throw fail(409, '该备注编号已用于其他内容');
  return threadWorkflow(db, id, now);
}

export function mergeThreadWorkflow(db, from, to) {
  db.prepare(
    `INSERT INTO mail_thread_completions SELECT ?,completed_at FROM mail_thread_completions
    WHERE thread_id=? ON CONFLICT(thread_id) DO UPDATE SET completed_at=max(completed_at,excluded.completed_at)`,
  ).run(to, from);
  db.prepare('DELETE FROM mail_thread_completions WHERE thread_id=?').run(from);
  db.prepare('UPDATE mail_internal_notes SET thread_id=? WHERE thread_id=?').run(to, from);
  db.prepare(
    `INSERT INTO mail_thread_workflow SELECT ?,state,snooze_until,updated_at
    FROM mail_thread_workflow WHERE thread_id=?
    ON CONFLICT(thread_id) DO UPDATE SET state=excluded.state,snooze_until=excluded.snooze_until,updated_at=excluded.updated_at
    WHERE excluded.updated_at > mail_thread_workflow.updated_at`,
  ).run(to, from);
  db.prepare('DELETE FROM mail_thread_workflow WHERE thread_id=?').run(from);
}
