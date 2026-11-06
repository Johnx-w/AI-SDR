import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { domainKey } from './website-identity.mjs';
import { exclusionConditionsKey } from './exclusion-conditions.mjs';
import { exclusionDecision } from './exclusion-decision.mjs';

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
    this.db
      .exec(`CREATE INDEX IF NOT EXISTS acquisition_customer_evidence ON acquisition_operations(
      json_extract(data,'$.scope'), json_extract(data,'$.recordId'),
      COALESCE(json_extract(data,'$.recordVerifiedAt'),json_extract(data,'$.updatedAt'),
        json_extract(data,'$.createdAt'),'') DESC, id DESC
    ) WHERE json_extract(data,'$.state')='completed'`);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS company_identities(scope TEXT NOT NULL, record_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope, record_id))',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS customer_contact_corrections(scope TEXT NOT NULL, record_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope, record_id))',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS research_model_responses(scope TEXT NOT NULL, cache_key TEXT NOT NULL, created_at INTEGER NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,cache_key)); CREATE INDEX IF NOT EXISTS research_model_responses_age ON research_model_responses(scope,created_at)',
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS acquisition_exclusions (
      scope TEXT NOT NULL, conditions_key TEXT NOT NULL, domain TEXT NOT NULL,
      reason TEXT NOT NULL, operation_id TEXT NOT NULL, excluded_at TEXT NOT NULL,
      summary TEXT NOT NULL, PRIMARY KEY(scope,conditions_key,domain)
    ); CREATE TABLE IF NOT EXISTS acquisition_migrations (
      scope TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(scope,name)
    )`);
  }
  backfillExclusions() {
    const marker = 'historical-exclusions-v1';
    if (this.exclusionsBackfilled) return;
    if (
      this.db
        .prepare('SELECT 1 FROM acquisition_migrations WHERE scope=? AND name=?')
        .get(this.scope, marker)
    ) {
      this.exclusionsBackfilled = true;
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        !this.db
          .prepare('SELECT 1 FROM acquisition_migrations WHERE scope=? AND name=?')
          .get(this.scope, marker)
      ) {
        const decided = new Set();
        const rows = this.db
          .prepare(
            `SELECT data FROM acquisition_operations
          WHERE json_extract(data,'$.scope')=?
          ORDER BY COALESCE(json_extract(data,'$.updatedAt'),json_extract(data,'$.createdAt'),'') DESC, id DESC`,
          )
          .all(this.scope);
        for (const row of rows) {
          let op, key, domain;
          try {
            op = JSON.parse(row.data);
            if (!op.input?.item || !op.input?.input || !op.id || !(op.updatedAt || op.createdAt))
              continue;
            key = exclusionConditionsKey(op.input.input);
            domain = domainKey(op.input.item.source_url);
          } catch {
            continue;
          }
          if (!domain) continue;
          const identity = key + ':' + domain;
          if (decided.has(identity)) continue;
          const decision = exclusionDecision(op, op.output);
          if (decision === 'ignore') continue;
          decided.add(identity);
          if (decision === 'exclude') this.insertExclusion(key, domain, op);
        }
        this.db
          .prepare('INSERT INTO acquisition_migrations(scope,name) VALUES(?,?)')
          .run(this.scope, marker);
      }
      this.db.exec('COMMIT');
      this.exclusionsBackfilled = true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  insertExclusion(key, domain, op) {
    const research = op.research || op.output?.research || {};
    const summary = Object.fromEntries(
      ['entity_type', 'product_match', 'country_match', 'customer_type_match', 'profile_match']
        .filter((field) => research[field] !== undefined)
        .map((field) => [field, research[field]]),
    );
    if (research.eligibility?.status) summary.eligibility = research.eligibility.status;
    if (research.relevance?.relevant === false) summary.prescreen = true;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO acquisition_exclusions
      (scope,conditions_key,domain,reason,operation_id,excluded_at,summary) VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        this.scope,
        key,
        domain,
        op.output.reason,
        op.id,
        op.updatedAt || op.createdAt,
        JSON.stringify(summary),
      );
  }
  exclusion(key, website) {
    this.backfillExclusions();
    const domain = domainKey(website);
    return domain
      ? this.db
          .prepare(
            `SELECT reason,operation_id,excluded_at,summary
      FROM acquisition_exclusions WHERE scope=? AND conditions_key=? AND domain=?`,
          )
          .get(this.scope, key, domain) || null
      : null;
  }
  completeResearch(op, output, key, website) {
    this.backfillExclusions();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      op.state = 'completed';
      this.complete(op, output);
      const domain = domainKey(website);
      const decision = domain ? exclusionDecision(op, output) : 'ignore';
      if (decision === 'exclude') {
        this.db
          .prepare(
            'DELETE FROM acquisition_exclusions WHERE scope=? AND conditions_key=? AND domain=?',
          )
          .run(this.scope, key, domain);
        this.insertExclusion(key, domain, op);
      } else if (decision === 'clear')
        this.db
          .prepare(
            'DELETE FROM acquisition_exclusions WHERE scope=? AND conditions_key=? AND domain=?',
          )
          .run(this.scope, key, domain);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return output;
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
  researchEmailEvidence(recordId, website) {
    const domain = domainKey(website);
    if (!recordId || !domain) return [];
    const operation = this.db
      .prepare(
        `SELECT data FROM acquisition_operations
         WHERE json_extract(data,'$.scope')=?
           AND json_extract(data,'$.recordId')=?
           AND json_extract(data,'$.state')='completed'
         ORDER BY COALESCE(json_extract(data,'$.recordVerifiedAt'),
           json_extract(data,'$.updatedAt'),json_extract(data,'$.createdAt'),'') DESC,id DESC`,
      )
      .all(this.scope, recordId)
      .map((row) => JSON.parse(row.data))
      .find((item) => domainKey(item.source_url) === domain);
    // The latest completed matching operation is authoritative. Missing evidence
    // must stay missing; do not resurrect contacts from an older research pass.
    return (Array.isArray(operation?.evidence?.contacts) ? operation.evidence.contacts : []).filter(
      (contact) =>
        contact?.kind === 'email' &&
        typeof contact.value === 'string' &&
        typeof contact.source_url === 'string' &&
        typeof contact.quote === 'string' &&
        contact.value.trim() &&
        contact.source_url.trim() &&
        contact.quote.trim(),
    );
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
  discardModelResponse(key) {
    this.db
      .prepare('DELETE FROM research_model_responses WHERE scope=? AND cache_key=?')
      .run(this.scope, modelCacheKey(key));
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
}
