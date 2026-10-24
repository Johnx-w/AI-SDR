import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { domainKey } from './website-identity.mjs';

const conflict = (message) => Object.assign(new Error(message), { status: 409 });

// Confirmation history outlives the latest-only assessment. Prepared writes are
// kept separately from active facts so an unverified mirror write cannot score.
export class LeadSupplementStore {
  constructor(path = ':memory:', scope = '') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.scope = scope;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS lead_supplements(
        scope TEXT NOT NULL, id TEXT NOT NULL, record_id TEXT NOT NULL,
        hash TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(scope,id));`);
  }
  get(id) {
    const row = this.db
      .prepare('SELECT data FROM lead_supplements WHERE scope=? AND id=?')
      .get(this.scope, id);
    return row ? JSON.parse(row.data) : null;
  }
  confirmations(recordId, website) {
    return this.db
      .prepare(
        "SELECT data FROM lead_supplements WHERE scope=? AND record_id=? AND state='completed' ORDER BY rowid",
      )
      .all(this.scope, recordId)
      .map((row) => JSON.parse(row.data))
      .filter((row) => domainKey(row.website) === domainKey(website))
      .map((row) => row.confirmation);
  }
  pending(recordId) {
    const row = this.db
      .prepare(
        "SELECT data FROM lead_supplements WHERE scope=? AND record_id=? AND state='prepared' ORDER BY rowid DESC LIMIT 1",
      )
      .get(this.scope, recordId);
    return row ? JSON.parse(row.data) : null;
  }
  prepare(id, recordId, input, create) {
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = this.db
      .prepare('SELECT hash,data FROM lead_supplements WHERE scope=? AND id=?')
      .get(this.scope, id);
    if (prior) {
      if (prior.hash !== hash) throw conflict('相同保存编号不能更换确认内容，请重新打开补充资料');
      return JSON.parse(prior.data);
    }
    const pending = this.db
      .prepare("SELECT id FROM lead_supplements WHERE scope=? AND record_id=? AND state='prepared'")
      .get(this.scope, recordId);
    if (pending) throw conflict('该客户有一条补充资料保存结果待核对，请先重试原保存');
    const data = { ...create(), id, recordId, state: 'prepared' };
    this.db
      .prepare('INSERT INTO lead_supplements VALUES(?,?,?,?,?,?)')
      .run(this.scope, id, recordId, hash, data.state, JSON.stringify(data));
    return data;
  }
  complete(entry) {
    entry.state = 'completed';
    this.save(entry);
  }
  supersede(entry) {
    entry.state = 'superseded';
    this.save(entry);
  }
  save(entry) {
    this.db
      .prepare('UPDATE lead_supplements SET state=?,data=? WHERE scope=? AND id=?')
      .run(entry.state, JSON.stringify(entry), this.scope, entry.id);
  }
  close() {
    this.db.close();
  }
}
