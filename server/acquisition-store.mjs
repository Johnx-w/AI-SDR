import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { domainKey } from './website-identity.mjs';
import { mergeShipmentEvidence } from './shipment-evidence.mjs';

const MODEL_RESPONSE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MODEL_RESPONSE_LIMIT = 200;
const cacheError = (message) => Object.assign(new Error(message), { status: 400 });
function modelCacheKey(key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/i.test(key))
    throw cacheError('模型响应缓存编号必须为 64 位十六进制摘要');
  return key.toLowerCase();
}
function modelCacheTime(now) {
  if (!Number.isSafeInteger(now) || now < 0) throw cacheError('模型响应缓存时间无效');
  return now;
}
function modelResponseJson(response) {
  try {
    return JSON.stringify(response, (_key, value) => {
      if (
        value === undefined ||
        ['function', 'symbol', 'bigint'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value)) ||
        (value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      )
        throw new Error('not JSON data');
      return value;
    });
  } catch {
    throw cacheError('模型响应缓存只接受有效 JSON 数据，不接受异常或未定义响应');
  }
}

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
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS customer_contact_corrections(scope TEXT NOT NULL, record_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope, record_id))',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS customs_company_evidence(scope TEXT NOT NULL, domain TEXT NOT NULL, buyer_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,domain,buyer_key))',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS website_research_identities(scope TEXT NOT NULL, domain TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,domain))',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS research_model_responses(scope TEXT NOT NULL, cache_key TEXT NOT NULL, created_at INTEGER NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,cache_key)); CREATE INDEX IF NOT EXISTS research_model_responses_age ON research_model_responses(scope,created_at)',
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
  contactCorrections(recordId) {
    const row = this.db
      .prepare('SELECT data FROM customer_contact_corrections WHERE scope=? AND record_id=?')
      .get(this.scope, recordId);
    return row ? JSON.parse(row.data) : {};
  }
  saveContactCorrections(recordId, corrections) {
    this.db
      .prepare(
        'INSERT INTO customer_contact_corrections(scope,record_id,data) VALUES(?,?,?) ON CONFLICT(scope,record_id) DO UPDATE SET data=excluded.data',
      )
      .run(this.scope, recordId, JSON.stringify(corrections));
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
  modelResponse(key, { now = Date.now() } = {}) {
    key = modelCacheKey(key);
    now = modelCacheTime(now);
    const row = this.db
      .prepare(
        'SELECT created_at,response FROM research_model_responses WHERE scope=? AND cache_key=?',
      )
      .get(this.scope, key);
    if (!row) return null;
    if (row.created_at <= now - MODEL_RESPONSE_TTL_MS) {
      this.db
        .prepare('DELETE FROM research_model_responses WHERE scope=? AND cache_key=?')
        .run(this.scope, key);
      return null;
    }
    return JSON.parse(row.response);
  }
  // Cache only a validated provider response. Requests, credentials, environment
  // settings, customer writes and operation results do not belong in this table.
  saveModelResponse(key, response, { now = Date.now() } = {}) {
    key = modelCacheKey(key);
    now = modelCacheTime(now);
    const json = modelResponseJson(response);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare('DELETE FROM research_model_responses WHERE scope=? AND created_at<=?')
        .run(this.scope, now - MODEL_RESPONSE_TTL_MS);
      this.db
        .prepare(
          // The cache has no dependent rows. Replacing also renews rowid, making
          // the saved-order tie-break deterministic within the same millisecond.
          'INSERT OR REPLACE INTO research_model_responses(scope,cache_key,created_at,response) VALUES(?,?,?,?)',
        )
        .run(this.scope, key, now, json);
      this.db
        .prepare(
          'DELETE FROM research_model_responses WHERE scope=? AND cache_key IN (SELECT cache_key FROM research_model_responses WHERE scope=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?)',
        )
        .run(this.scope, this.scope, MODEL_RESPONSE_LIMIT);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  customsEvidence(website) {
    return this.db
      .prepare('SELECT data FROM customs_company_evidence WHERE scope=? AND domain=?')
      .all(this.scope, domainKey(website))
      .map((row) => JSON.parse(row.data));
  }
  websiteResearch(website) {
    const row = this.db
      .prepare('SELECT data FROM website_research_identities WHERE scope=? AND domain=?')
      .get(this.scope, domainKey(website));
    return row ? JSON.parse(row.data) : null;
  }
  saveWebsiteResearch(website, research, recordId) {
    const entry = {
      company_name: research.company_name,
      company_identity: research.company_identity,
      actual_country: research.actual_country,
      address: research.address,
      facts: (research.facts || []).filter((f) =>
        [
          'company_name',
          'legal_company_name',
          'trading_names',
          'address',
          'actual_country',
        ].includes(f.field),
      ),
      record_id: recordId,
      checked_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO website_research_identities VALUES(?,?,?) ON CONFLICT(scope,domain) DO UPDATE SET data=excluded.data',
      )
      .run(this.scope, domainKey(website), JSON.stringify(entry));
    return entry;
  }
  saveCustomsEvidence(website, buyer, match, recordId) {
    const domain = domainKey(website);
    if (!domain || !buyer.id) throw new Error('海关证据缺少官网或买方标识');
    const prior = this.customsEvidence(website).find(
      (b) => b.id === buyer.id && b.product_family === buyer.product_family,
    );
    const entry = mergeShipmentEvidence(prior, buyer);
    entry.match = match || prior?.match || { status: 'pending', reason: '待官网核实买方身份' };
    entry.record_id = recordId || prior?.record_id || null;
    entry.checked_at = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO customs_company_evidence VALUES(?,?,?,?) ON CONFLICT(scope,domain,buyer_key) DO UPDATE SET data=excluded.data',
      )
      .run(this.scope, domain, buyer.id + ':' + buyer.product_family, JSON.stringify(entry));
    return entry;
  }
}
