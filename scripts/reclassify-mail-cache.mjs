import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { incomingClassification } from '../server/communication-rounds.mjs';
import { initializeReplyHistory } from '../server/mail-reply-history.mjs';

export function reclassifyMailCache(path, apply = false) {
  if (!path || !isAbsolute(path)) throw Error('请指定隔离副本的绝对路径 --db');
  const file = realpathSync(path);
  const production = fileURLToPath(new URL('../.data/outreach/outreach.sqlite', import.meta.url));
  const primary = apply && statSync(production, { throwIfNoEntry: false, bigint: true });
  const stat = statSync(file, { bigint: true });
  if (!stat.isFile() || (primary && primary.dev === stat.dev && primary.ino === stat.ino))
    throw Error('只允许更新独立 SQLite 副本，所选文件为正式数据库');
  const db = new DatabaseSync(file, { readOnly: !apply });
  const report = { apply, considered: 0, changes: 0, transitions: {} };
  try {
    db.exec('PRAGMA busy_timeout=10000');
    db.exec(apply ? 'BEGIN IMMEDIATE' : 'BEGIN');
    if (apply) initializeReplyHistory(db);
    const update =
      apply &&
      db.prepare(
        "UPDATE mailbox_thread_messages SET data=json_set(data,'$.classification',?) WHERE id=?",
      );
    const rows =
      db.prepare(`SELECT id,coalesce(json_extract(data,'$.classification'),'normal') AS previous,
      json_extract(data,'$.from') AS sender,json_extract(data,'$.subject') AS subject,
      json_extract(data,'$.bodyText') AS bodyText,json_extract(data,'$.bodyHtml') AS bodyHtml
      FROM mailbox_thread_messages WHERE json_extract(data,'$.direction')='inbound'
      AND json_extract(data,'$.source')='imap'
      AND coalesce(json_extract(data,'$.classification'),'normal') IN ('normal','unverified')
      ORDER BY rowid`);
    for (const row of rows.iterate()) {
      report.considered++;
      const next = incomingClassification({ ...row, from: row.sender });
      if (row.previous === next) continue;
      const transition = row.previous + ' → ' + next;
      report.transitions[transition] = (report.transitions[transition] || 0) + 1;
      report.changes++;
      if (apply) update.run(next, row.id);
    }
    if (apply) {
      const mismatch = db
        .prepare(
          `SELECT 1 FROM mailbox_thread_messages m LEFT JOIN mailbox_reply_headers h ON h.id=m.id
        WHERE json_extract(m.data,'$.direction')='inbound' AND json_extract(m.data,'$.source')='imap'
        AND (h.id IS NULL OR h.classification IS NOT json_extract(m.data,'$.classification')) LIMIT 1`,
        )
        .get();
      if (mismatch) throw Error('来信索引与缓存分类不一致');
    }
    db.exec('COMMIT');
    return report;
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({
      options: { db: { type: 'string' }, apply: { type: 'boolean' } },
    });
    console.log(JSON.stringify(reclassifyMailCache(values.db, values.apply)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
