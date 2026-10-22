import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { domainKey } from './website-identity.mjs';

export class AcquisitionStore {
  constructor(path = ':memory:', scope = '') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.scope = scope;
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS acquisition_operations (id TEXT PRIMARY KEY, hash TEXT NOT NULL, data TEXT NOT NULL);',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS company_identities(scope TEXT NOT NULL, record_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope, record_id))',
    );
  }
  get(id) {
    const row = this.db.prepare('SELECT data FROM acquisition_operations WHERE id=?').get(id);
    const op = row ? JSON.parse(row.data) : null;
    if (op && (op.scope || '') !== this.scope)
      throw Object.assign(new Error('操作所属飞书表格与当前配置不一致，已停止核对'), {
        status: 409,
      });
    return op;
  }
  begin(id, input) {
    const hash = createHash('sha256')
      .update(JSON.stringify([this.scope, input]))
      .digest('hex');
    const prior = this.db
      .prepare('SELECT hash,data FROM acquisition_operations WHERE id=?')
      .get(id);
    if (prior) {
      if (prior.hash !== hash)
        throw Object.assign(new Error('相同操作编号不能更换研究参数或飞书表格'), { status: 409 });
      return { operation: JSON.parse(prior.data), existing: true };
    }
    const operation = {
      id,
      scope: this.scope,
      state: 'running',
      stage: 'select',
      clientToken: randomUUID(),
      createdAt: new Date().toISOString(),
      input,
    };
    this.db
      .prepare('INSERT INTO acquisition_operations VALUES(?,?,?)')
      .run(id, hash, JSON.stringify(operation));
    return { operation, existing: false };
  }
  save(operation) {
    operation.updatedAt = new Date().toISOString();
    this.db
      .prepare('UPDATE acquisition_operations SET data=? WHERE id=?')
      .run(JSON.stringify(operation), operation.id);
    return operation;
  }
  complete(operation, output) {
    operation.state = 'completed';
    operation.output = output;
    return this.save(operation);
  }
  history() {
    return this.db
      .prepare('SELECT data FROM acquisition_operations ORDER BY rowid DESC LIMIT 100')
      .all()
      .map((r) => JSON.parse(r.data))
      .map((o) => ({
        id: o.id,
        status: o.state,
        startedAt: o.createdAt,
        stoppedAt: o.state === 'completed' ? o.updatedAt : null,
      }));
  }
  byAssessment(id) {
    const row = this.db
      .prepare(
        "SELECT data FROM acquisition_operations WHERE json_extract(data,'$.assessment.id')=? AND json_extract(data,'$.scope')=? LIMIT 1",
      )
      .get(id, this.scope);
    return row ? JSON.parse(row.data) : null;
  }
  saveCompanyIdentity(recordId, website, recordName, identity) {
    const entry = {
      ...identity,
      recordId,
      website,
      recordName,
      checkedAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO company_identities(scope,record_id,data) VALUES(?,?,?) ON CONFLICT(scope,record_id) DO UPDATE SET data=excluded.data',
      )
      .run(this.scope, recordId, JSON.stringify(entry));
    return entry;
  }
  companyIdentity(recordId, website, recordName) {
    const row = this.db
      .prepare('SELECT data FROM company_identities WHERE scope=? AND record_id=?')
      .get(this.scope, recordId);
    if (!row) return null;
    const entry = JSON.parse(row.data);
    return domainKey(entry.website) === domainKey(website) && entry.recordName === recordName
      ? entry
      : null;
  }
  close() {
    this.db.close();
  }
}
