import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
    if (row.scope !== this.scope)
      throw Object.assign(new Error('评估属于其他客户表'), { status: 409 });
    return JSON.parse(row.data);
  }
  prepare(snapshot, recordId) {
    const prior = this.get(snapshot.id);
    if (prior) {
      if (
        prior.recordId !== recordId ||
        JSON.stringify(prior.snapshot) !== JSON.stringify(snapshot)
      )
        throw Object.assign(new Error('同一评估编号不能更换客户或评估内容'), { status: 409 });
      return prior;
    }
    const entry = {
      id: snapshot.id,
      recordId,
      snapshot,
      historyStatus: 'pending',
      historyReasonFormat: 'evidence-v1',
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO customer_assessments VALUES(?,?,?,?,?)')
      .run(entry.id, this.scope, recordId, snapshot.evaluatedAt, JSON.stringify(entry));
    return entry;
  }
  save(entry) {
    entry.updatedAt = new Date().toISOString();
    this.db
      .prepare('UPDATE customer_assessments SET data=? WHERE id=? AND scope=?')
      .run(JSON.stringify(entry), entry.id, this.scope);
    return entry;
  }
  claimHistoryWrite(entry) {
    entry.updatedAt = new Date().toISOString();
    const result = this.db
      .prepare(
        "UPDATE customer_assessments SET data=? WHERE id=? AND scope=? AND json_extract(data,'$.historyStatus')='pending'",
      )
      .run(JSON.stringify(entry), entry.id, this.scope);
    return result.changes === 1;
  }
  history(recordId, limit = 100) {
    return this.db
      .prepare(
        'SELECT data FROM customer_assessments WHERE scope=? AND record_id=? ORDER BY evaluated_at DESC,rowid DESC LIMIT ?',
      )
      .all(this.scope, recordId, limit)
      .map((row) => JSON.parse(row.data));
  }
  pending(limit = 50) {
    return this.db
      .prepare(
        "SELECT data FROM customer_assessments WHERE scope=? AND json_extract(data,'$.historyStatus')!='synced' ORDER BY COALESCE(json_extract(data,'$.updatedAt'),evaluated_at) LIMIT ?",
      )
      .all(this.scope, limit)
      .map((row) => JSON.parse(row.data));
  }
  close() {
    this.db.close();
  }
}
