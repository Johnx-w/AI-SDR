import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const conflict = (message) => Object.assign(new Error(message), { status: 409 });

export class AssessmentStore {
  constructor(path = ':memory:', scope = '') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.scope = scope;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS customer_assessments (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, record_id TEXT NOT NULL,
        evaluated_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS customer_assessment_history
        ON customer_assessments(scope,record_id,evaluated_at);`);
  }
  get(id) {
    const row = this.db.prepare('SELECT data,scope FROM customer_assessments WHERE id=?').get(id);
    if (!row) return null;
    if (row.scope !== this.scope) throw conflict('评估属于其他客户表');
    return JSON.parse(row.data);
  }
  latest(recordId) {
    const row = this.db
      .prepare(
        'SELECT data FROM customer_assessments WHERE scope=? AND record_id=? ORDER BY evaluated_at DESC,rowid DESC LIMIT 1',
      )
      .get(this.scope, recordId);
    return row ? JSON.parse(row.data) : null;
  }
  saveCurrent(snapshot, recordId) {
    if (!snapshot.id || !recordId || !Number.isFinite(Date.parse(snapshot.evaluatedAt)))
      throw conflict('评估编号、客户或评估时间无效');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.get(snapshot.id);
      if (
        prior &&
        (prior.recordId !== recordId || JSON.stringify(prior.snapshot) !== JSON.stringify(snapshot))
      )
        throw conflict('同一评估编号不能更换客户或评估内容');
      const latest = this.latest(recordId);
      // A recovered older operation must not replace a more recent evaluation.
      if (latest && Date.parse(latest.snapshot.evaluatedAt) > Date.parse(snapshot.evaluatedAt)) {
        this.db.exec('COMMIT');
        return latest;
      }
      const now = new Date().toISOString();
      const entry = {
        id: snapshot.id,
        recordId,
        snapshot,
        createdAt: prior?.createdAt || now,
        savedAt: prior?.savedAt || now,
      };
      this.db
        .prepare('DELETE FROM customer_assessments WHERE scope=? AND record_id=?')
        .run(this.scope, recordId);
      this.db
        .prepare('INSERT INTO customer_assessments VALUES(?,?,?,?,?)')
        .run(entry.id, this.scope, recordId, snapshot.evaluatedAt, JSON.stringify(entry));
      const persisted = this.get(entry.id);
      if (JSON.stringify(persisted) !== JSON.stringify(entry))
        throw conflict('最新评估保存后核对失败');
      this.db.exec('COMMIT');
      return persisted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
