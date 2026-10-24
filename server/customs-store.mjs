import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const parse = (row) => (row ? JSON.parse(row.data) : null);
const fail = (message) => Object.assign(new Error(message), { status: 409 });

export class CustomsStore {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS customs_pages (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customs_runs (id TEXT PRIMARY KEY, used INTEGER NOT NULL DEFAULT 0, reserved INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS customs_cursors (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS customs_run_searches (run_id TEXT NOT NULL, series TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(run_id, series));
      CREATE TABLE IF NOT EXISTS customs_run_records (run_id TEXT NOT NULL, record_key TEXT NOT NULL, page_id TEXT NOT NULL, PRIMARY KEY(run_id, record_key));`);
  }
  page(id) {
    return parse(this.db.prepare('SELECT data FROM customs_pages WHERE id=?').get(id));
  }
  cursor(id) {
    return parse(this.db.prepare('SELECT data FROM customs_cursors WHERE id=?').get(id));
  }
  saveCursor(id, data) {
    this.db
      .prepare(
        'INSERT INTO customs_cursors VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(id, JSON.stringify(data));
  }
  runSearch(runId, series) {
    return parse(
      this.db
        .prepare('SELECT data FROM customs_run_searches WHERE run_id=? AND series=?')
        .get(runId, series),
    );
  }
  bindRunSearch(runId, series, data) {
    this.db
      .prepare('INSERT OR IGNORE INTO customs_run_searches VALUES(?,?,?)')
      .run(runId, series, JSON.stringify(data));
    return this.runSearch(runId, series);
  }
  run(id) {
    return (
      this.db.prepare('SELECT used,reserved FROM customs_runs WHERE id=?').get(id) || {
        used: 0,
        reserved: 0,
      }
    );
  }
  reserve(id, runId, count, cap, query) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.page(id);
      if (prior) {
        this.db.exec('COMMIT');
        return prior;
      }
      this.db.prepare('INSERT OR IGNORE INTO customs_runs(id) VALUES(?)').run(runId);
      const run = this.run(runId);
      if (run.used + run.reserved + count > cap)
        throw fail('本轮海关逐票返回预算不足，未发起新请求');
      const pending = {
        status: 'pending',
        run_id: runId,
        reserved: count,
        query,
        created_at: new Date().toISOString(),
      };
      this.db.prepare('INSERT INTO customs_pages VALUES(?,?)').run(id, JSON.stringify(pending));
      this.db.prepare('UPDATE customs_runs SET reserved=reserved+? WHERE id=?').run(count, runId);
      this.db.exec('COMMIT');
      return null;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  complete(id, result) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.page(id);
      if (!prior || prior.status !== 'pending') throw fail('海关请求缓存状态不一致');
      const done = { ...prior, status: 'complete', result, completed_at: new Date().toISOString() };
      this.db.prepare('UPDATE customs_pages SET data=? WHERE id=?').run(JSON.stringify(done), id);
      this.db
        .prepare('UPDATE customs_runs SET reserved=reserved-?, used=used+? WHERE id=?')
        .run(prior.reserved, result.records.length, prior.run_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  uncertain(id) {
    const prior = this.page(id);
    if (prior?.status === 'pending')
      this.db
        .prepare('UPDATE customs_pages SET data=? WHERE id=?')
        .run(JSON.stringify({ ...prior, status: 'uncertain' }), id);
  }
  firstPageForRecord(runId, key, pageId) {
    this.db
      .prepare('INSERT OR IGNORE INTO customs_run_records VALUES(?,?,?)')
      .run(runId, key, pageId);
    return this.db
      .prepare('SELECT page_id FROM customs_run_records WHERE run_id=? AND record_key=?')
      .get(runId, key).page_id;
  }
  close() {
    this.db.close();
  }
}
