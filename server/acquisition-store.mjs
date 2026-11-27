import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { domainKey } from './website-identity.mjs';
import { exclusionConditionsKey } from './exclusion-conditions.mjs';
import { exclusionDecision } from './exclusion-decision.mjs';

const MODEL_RESPONSE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MODEL_RESPONSE_LIMIT = 200;
const PAGE_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_SNAPSHOT_RETENTION_MS = 7 * PAGE_SNAPSHOT_TTL_MS;
const SNAPSHOT_CACHE_BYTES = 64 * 1024 ** 2;
const MAX_SNAPSHOT_BYTES = 12 * 1024 ** 2;
const SNAPSHOT_DISK_RESERVE_BYTES = 512 * 1024 ** 2;
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

function quotedSnapshotIds(operation) {
  const ids = new Set();
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    if (
      typeof value.snapshot_id === 'string' &&
      typeof value.quote === 'string' &&
      value.quote.trim()
    )
      ids.add(value.snapshot_id);
    for (const child of Object.values(value)) visit(child);
  };
  for (const value of [
    operation.research,
    operation.output?.research,
    operation.acquisition,
    operation.assessment,
    operation.evidence,
  ])
    visit(value);
  return ids;
}

export class AcquisitionStore {
  constructor(path = ':memory:', scope = '', { snapshotCacheBytes = SNAPSHOT_CACHE_BYTES } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.scope = scope;
    this.snapshotFolder = path === ':memory:' ? null : dirname(path);
    this.snapshotCacheBytes = snapshotCacheBytes;
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
    this.db.exec(`CREATE TABLE IF NOT EXISTS acquisition_candidate_history (
      scope TEXT NOT NULL, conditions_key TEXT NOT NULL, domain TEXT NOT NULL,
      model_attempts INTEGER NOT NULL DEFAULT 0, request_key TEXT, operation_id TEXT,
      PRIMARY KEY(scope,conditions_key,domain)
    )`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS acquisition_page_snapshots (
      scope TEXT NOT NULL, id TEXT NOT NULL, requested_url TEXT NOT NULL,
      acquired_at TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(scope,id)
    ); CREATE INDEX IF NOT EXISTS acquisition_page_snapshots_lookup
      ON acquisition_page_snapshots(scope,requested_url,acquired_at DESC) WHERE status='ok';
      CREATE TABLE IF NOT EXISTS acquisition_snapshot_refs (
        scope TEXT NOT NULL, snapshot_id TEXT NOT NULL, operation_id TEXT NOT NULL,
        PRIMARY KEY(scope,snapshot_id,operation_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS acquisition_snapshot_refs_operation
        ON acquisition_snapshot_refs(scope,operation_id,snapshot_id);
      CREATE TABLE IF NOT EXISTS acquisition_snapshot_history_refs (
        scope TEXT NOT NULL, snapshot_id TEXT NOT NULL,
        PRIMARY KEY(scope,snapshot_id)
      ) WITHOUT ROWID`);
  }
  pageSnapshot(requestedUrl, { now = Date.now() } = {}) {
    return this.pageSnapshots(requestedUrl, { now }).at(-1) || null;
  }
  pageSnapshots(requestedUrl, { now = Date.now() } = {}) {
    const rows = this.db
      .prepare(
        `SELECT data FROM acquisition_page_snapshots WHERE scope=? AND requested_url=? AND status='ok'
      AND acquired_at BETWEEN ? AND ? ORDER BY acquired_at DESC, rowid DESC LIMIT 3`,
      )
      .all(
        this.scope,
        requestedUrl,
        new Date(now - PAGE_SNAPSHOT_TTL_MS).toISOString(),
        new Date(now).toISOString(),
      );
    const latest = rows.map((row) => JSON.parse(row.data));
    const directIndex = latest.findIndex(({ method }) => method === 'node');
    return directIndex < 0 ? latest.slice(0, 1) : latest.slice(0, directIndex + 1).reverse();
  }
  savePageSnapshot(snapshot, { operationId } = {}) {
    let data = JSON.stringify(snapshot);
    if (
      (snapshot.content || snapshot.raw_content) &&
      (Buffer.byteLength(data) > MAX_SNAPSHOT_BYTES || !this.canPersistPageBodies())
    ) {
      snapshot = {
        ...snapshot,
        status: 'deferred',
        failure_reason: 'snapshot_capacity',
        content: '',
        raw_content: '',
        content_hash: null,
        gaps: ['page_body'],
      };
      data = JSON.stringify(snapshot);
    }
    const snapshot_id = createHash('sha256').update(data).digest('hex');
    const stored = { ...snapshot, snapshot_id };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO acquisition_page_snapshots VALUES(?,?,?,?,?,?)
          ON CONFLICT(scope,id) DO UPDATE SET status=excluded.status,data=excluded.data
          WHERE acquisition_page_snapshots.status='pruned'`,
        )
        .run(
          this.scope,
          snapshot_id,
          snapshot.requested_url,
          snapshot.acquired_at,
          snapshot.status,
          JSON.stringify(stored),
        );
      if (operationId) this.referencePageSnapshot(operationId, snapshot_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return stored;
  }
  referencePageSnapshot(operationId, snapshotId) {
    this.db
      .prepare('INSERT OR IGNORE INTO acquisition_snapshot_refs VALUES(?,?,?)')
      .run(this.scope, snapshotId, operationId);
  }
  retainQuotedSnapshots(operation) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO acquisition_snapshot_history_refs
        SELECT scope,snapshot_id FROM acquisition_snapshot_refs WHERE scope=? AND operation_id=?`,
      )
      .run(this.scope, operation.id);
    this.db
      .prepare('DELETE FROM acquisition_snapshot_refs WHERE scope=? AND operation_id=?')
      .run(this.scope, operation.id);
    for (const snapshotId of quotedSnapshotIds(operation))
      this.referencePageSnapshot(operation.id, snapshotId);
  }
  referencedPageSnapshots(operationId) {
    return this.db
      .prepare(
        `SELECT p.data FROM acquisition_snapshot_refs r
        JOIN acquisition_page_snapshots p ON p.scope=r.scope AND p.id=r.snapshot_id
        WHERE r.scope=? AND r.operation_id=? ORDER BY p.acquired_at,p.rowid`,
      )
      .all(this.scope, operationId)
      .map(({ data }) => JSON.parse(data));
  }
  canPersistPageBodies() {
    if (!this.snapshotFolder) return true;
    const now = Date.now();
    if (!this.snapshotDiskCheck || now >= this.snapshotDiskCheck.at + 5000) {
      const fs = statfsSync(this.snapshotFolder);
      this.snapshotDiskCheck = {
        at: now,
        sufficient: fs.bavail * fs.bsize >= SNAPSHOT_DISK_RESERVE_BYTES,
      };
    }
    return this.snapshotDiskCheck.sufficient;
  }
  maintainPageSnapshots() {
    const now = Date.now();
    if (this.lastSnapshotCleanup === undefined || now >= this.lastSnapshotCleanup + 3600000) {
      this.prunePageSnapshots({ now });
      this.lastSnapshotCleanup = now;
    }
  }
  prunePageSnapshots({ now = Date.now() } = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const migration = 'snapshot-references-v2';
      if (
        !this.db
          .prepare('SELECT 1 FROM acquisition_migrations WHERE scope=? AND name=?')
          .get(this.scope, migration)
      ) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO acquisition_snapshot_refs(scope,snapshot_id,operation_id)
          SELECT ?, j.atom, o.id FROM acquisition_operations o, json_tree(o.data) j
          WHERE COALESCE(json_extract(o.data,'$.scope'),'')=? AND j.type='text'
            AND (j.key='snapshot_id' OR j.path LIKE '%.snapshot_ids')`,
          )
          .run(this.scope, this.scope);
        for (const { data } of this.db
          .prepare(
            `SELECT data FROM acquisition_operations
          WHERE COALESCE(json_extract(data,'$.scope'),'')=? AND json_extract(data,'$.state')='completed'`,
          )
          .iterate(this.scope))
          this.retainQuotedSnapshots(JSON.parse(data));
        this.db
          .prepare('INSERT INTO acquisition_migrations(scope,name) VALUES(?,?)')
          .run(this.scope, migration);
      }
      const candidates = `WITH unused AS (
        SELECT id, acquired_at,
          SUM(length(CAST(data AS BLOB))) OVER (ORDER BY acquired_at DESC,rowid DESC) AS total
        FROM acquisition_page_snapshots p
        WHERE scope=? AND status<>'pruned' AND NOT EXISTS (
          SELECT 1 FROM acquisition_snapshot_refs r WHERE r.scope=p.scope AND r.snapshot_id=p.id
        )
      )`;
      const cutoff = `scope=? AND id IN (SELECT id FROM unused WHERE acquired_at<? OR total>?)`;
      const recorded = `EXISTS (SELECT 1 FROM acquisition_snapshot_history_refs r
        WHERE r.scope=p.scope AND r.snapshot_id=p.id)`;
      const parameters = [
        this.scope,
        this.scope,
        new Date(now - PAGE_SNAPSHOT_RETENTION_MS).toISOString(),
        this.canPersistPageBodies() ? this.snapshotCacheBytes : 0,
      ];
      this.db
        .prepare(
          `${candidates}
        DELETE FROM acquisition_page_snapshots AS p WHERE ${cutoff} AND NOT ${recorded}`,
        )
        .run(...parameters);
      this.db
        .prepare(
          `${candidates}
        UPDATE acquisition_page_snapshots AS p
        SET status='pruned',
          data=json_set(json_remove(data,'$.content','$.raw_content','$.links'),'$.body_pruned',json('true'))
        WHERE ${cutoff} AND ${recorded}`,
        )
        .run(...parameters);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  snapshotById(id) {
    const row = this.db
      .prepare('SELECT data FROM acquisition_page_snapshots WHERE scope=? AND id=?')
      .get(this.scope, id);
    return row ? JSON.parse(row.data) : null;
  }
  reviewResponse(conditionsKey, domain, requestKey) {
    const row = this.db
      .prepare(
        `SELECT json_extract(op.data,'$.research_response') AS response
      FROM acquisition_candidate_history e JOIN acquisition_operations op ON op.id=e.operation_id
      WHERE e.scope=? AND e.conditions_key=? AND e.domain=? AND e.request_key=?`,
      )
      .get(this.scope, conditionsKey, domain, requestKey);
    return row?.response ? JSON.parse(row.response) : null;
  }
  startModelAttempt(op, conditionsKey, domain) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(
          `INSERT INTO acquisition_candidate_history
          (scope,conditions_key,domain,model_attempts) VALUES(?,?,?,1)
          ON CONFLICT(scope,conditions_key,domain) DO UPDATE SET model_attempts=model_attempts+1
          RETURNING model_attempts`,
        )
        .get(this.scope, conditionsKey, domain);
      op.research_usage.repeat_model_calls =
        (op.research_usage.repeat_model_calls || 0) + Number(row.model_attempts > 1);
      this.save(op);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
            if (op.admission_version && op.admission_version !== 'legacy') continue;
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
      if (op.reviewRequestKey && output.outcome === 'review') {
        this.db
          .prepare(
            `INSERT INTO acquisition_candidate_history
            (scope,conditions_key,domain,request_key,operation_id) VALUES(?,?,?,?,?)
            ON CONFLICT(scope,conditions_key,domain) DO UPDATE SET
            request_key=excluded.request_key,operation_id=excluded.operation_id`,
          )
          .run(this.scope, key, domain, op.reviewRequestKey, op.id);
      } else if (['completed', 'rejected', 'no_new_candidates'].includes(output.outcome)) {
        this.db
          .prepare(
            'UPDATE acquisition_candidate_history SET request_key=NULL,operation_id=NULL WHERE scope=? AND conditions_key=? AND domain=? AND request_key IS NOT NULL',
          )
          .run(this.scope, key, domain);
      }
      const decision =
        domain && (!op.admission_version || op.admission_version === 'legacy')
          ? exclusionDecision(op, output)
          : 'ignore';
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
    for (const request of Object.values(operation.paid_requests || {})) delete request.response;
    this.db.exec('SAVEPOINT acquisition_settle');
    try {
      this.save(operation);
      this.retainQuotedSnapshots(operation);
      this.db.exec('RELEASE acquisition_settle');
      return operation;
    } catch (error) {
      this.db.exec('ROLLBACK TO acquisition_settle; RELEASE acquisition_settle');
      throw error;
    }
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
