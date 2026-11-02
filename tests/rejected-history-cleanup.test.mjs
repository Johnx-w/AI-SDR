import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cleanupRejectedHistory } from '../server/rejected-history-cleanup.mjs';

const source = 'https://discarded.example/';
const email = 'buyer@discarded.example';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE acquisition_operations(id TEXT PRIMARY KEY, hash TEXT, data TEXT);
    CREATE TABLE jobs(id TEXT PRIMARY KEY, data TEXT);
    CREATE TABLE research_model_responses(scope TEXT, cache_key TEXT, response TEXT);
    CREATE TABLE website_research_identities(scope TEXT, domain TEXT, data TEXT);
    CREATE TABLE company_identities(scope TEXT, record_id TEXT, data TEXT);
  `);
  const rejected = {
    id: 'rejected-1',
    scope: 'table-1',
    state: 'completed',
    stage: 'research',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T01:00:00Z',
    input: { item: { source_url: source } },
    research_pages: [{ source_url: source, text: email }],
    research_response: { text: email },
    evidence: { contacts: [{ value: email, source_url: source }] },
    research: { country_match: 'not_matched', source_url: source, reason: email },
    research_usage: { model_calls: 1, cache_hits: 0, input_chars: 55, input_tokens: 20 },
    web_usage: { web_extract_calls: 1, web_extract_credits: 2 },
    output: {
      outcome: 'rejected',
      新增: 0,
      更新: 0,
      失败: 0,
      待人工查重: 0,
      skipped_existing_count: 0,
      skipped_existing: [],
      明细: [],
      reason: email,
      research: { source_url: source, company_name: 'Discarded' },
      handoff: { contacts: [{ value: email, source_url: source }] },
      research_usage: { model_calls: 1, cache_hits: 0, input_chars: 55 },
    },
  };
  const accepted = {
    id: 'accepted-1',
    scope: 'table-1',
    state: 'completed',
    stage: 'assessment',
    recordId: 'record-1',
    source_url: source,
    output: { outcome: 'completed', 新增: 1, 更新: 0, reason: '已收录' },
  };
  const active = { ...structuredClone(rejected), id: 'active-1' };
  const unsafe = { ...structuredClone(rejected), id: 'unsafe-1', recordId: 'record-unsafe' };
  const terminalJob = {
    id: 'job-1',
    status: 'partial',
    rejected: 1,
    researched: 2,
    searchStats: [{ id: 'search-1', rejected: 1 }],
    rows: [
      {
        result: 'rejected',
        search_id: 'search-1',
        operation_id: 'rejected-1',
        source_url: source,
        domain: 'discarded.example',
        source_title: 'Discarded',
        reason: email,
        research_usage: { model_calls: 1, cache_hits: 0, input_chars: 55 },
      },
      { result: 'inserted', operation_id: 'accepted-1', source_url: source },
    ],
    queue: [{ source_url: source }],
    seen: ['discarded.example'],
    skippedDomains: ['discarded.example'],
    searchSignatures: ['hash'],
    pendingSearch: { query: 'some query' },
    current: null,
  };
  const pausedJob = {
    id: 'job-paused',
    status: 'paused',
    current: { operation_id: 'active-1', source_url: source },
    queue: [{ source_url: source }],
    seen: ['discarded.example'],
    rows: [],
  };
  for (const [operation, hash] of [
    [rejected, 'hash-rejected'],
    [accepted, 'hash-accepted'],
    [active, 'hash-active'],
    [unsafe, 'hash-unsafe'],
  ])
    db.prepare('INSERT INTO acquisition_operations VALUES(?,?,?)').run(
      operation.id,
      hash,
      JSON.stringify(operation),
    );
  for (const job of [terminalJob, pausedJob])
    db.prepare('INSERT INTO jobs VALUES(?,?)').run(job.id, JSON.stringify(job));
  db.prepare('INSERT INTO research_model_responses VALUES(?,?,?)').run('table-1', 'key-1', email);
  db.prepare('INSERT INTO research_model_responses VALUES(?,?,?)').run(
    'table-1',
    'key-2',
    'accepted cache',
  );
  db.prepare('INSERT INTO website_research_identities VALUES(?,?,?)').run(
    'table-1',
    'discarded.example',
    JSON.stringify({ recordId: 'record-1', url: source }),
  );
  db.prepare('INSERT INTO company_identities VALUES(?,?,?)').run(
    'table-1',
    'record-1',
    JSON.stringify({ website: source }),
  );
  return db;
}

const operation = (db, id) =>
  db.prepare('SELECT hash,data FROM acquisition_operations WHERE id=?').get(id);
const job = (db, id) => JSON.parse(db.prepare('SELECT data FROM jobs WHERE id=?').get(id).data);
const cacheCount = (db) =>
  db.prepare('SELECT COUNT(*) count FROM research_model_responses').get().count;

test('历史明确淘汰仅留幂等与统计，终态清队列；活跃和已入库数据不动', () => {
  const db = fixture();
  try {
    const before = {
      rejected: operation(db, 'rejected-1'),
      accepted: operation(db, 'accepted-1'),
      active: operation(db, 'active-1'),
      unsafe: operation(db, 'unsafe-1'),
      paused: job(db, 'job-paused'),
      websiteIdentity: db.prepare('SELECT data FROM website_research_identities').get().data,
      companyIdentity: db.prepare('SELECT data FROM company_identities').get().data,
    };
    const plan = cleanupRejectedHistory(db, { clearModelCache: true });
    assert.equal(plan.applied, false);
    assert.equal(plan.rejectedOperations, 3);
    assert.equal(plan.unsafeOperations, 1);
    assert.equal(plan.deferredActiveOperations, 1);
    assert.equal(plan.operationsToRedact, 1);
    assert.equal(plan.rejectedRowsToRedact, 1);
    assert.equal(plan.jobsToClean, 1);
    assert.equal(plan.cacheToClear, 2);
    assert.deepEqual(operation(db, 'rejected-1'), before.rejected);
    assert.equal(cacheCount(db), 2);

    const applied = cleanupRejectedHistory(db, { apply: true });
    assert.equal(applied.operationsToRedact, 1);
    assert.equal(applied.cacheToClear, 0);
    assert.equal(cacheCount(db), 2);
    const after = operation(db, 'rejected-1');
    assert.equal(after.hash, before.rejected.hash);
    const redacted = JSON.parse(after.data);
    assert.equal(redacted.createdAt, '2026-10-01T00:00:00Z');
    assert.equal(redacted.updatedAt, '2026-10-01T01:00:00Z');
    assert.equal(redacted.output.outcome, 'rejected');
    assert.equal(redacted.output.reason, '官网所在国家与目标市场不符');
    assert.deepEqual(redacted.output.handoff.contacts, []);
    assert.deepEqual(redacted.research_usage, {
      model_calls: 1,
      cache_hits: 0,
      input_chars: 55,
      input_tokens: 20,
    });
    assert.ok(!after.data.includes(source) && !after.data.includes(email));
    const cleaned = job(db, 'job-1');
    assert.equal(cleaned.rejected, 1);
    assert.equal(cleaned.searchStats[0].rejected, 1);
    assert.deepEqual(cleaned.rows[0], {
      search_id: 'search-1',
      operation_id: 'rejected-1',
      result: 'rejected',
      reason: '官网所在国家与目标市场不符',
      research_usage: { model_calls: 1, cache_hits: 0, input_chars: 55 },
    });
    assert.equal(cleaned.rows[1].source_url, source);
    assert.deepEqual(cleaned.queue, []);
    assert.deepEqual(cleaned.seen, []);
    assert.deepEqual(cleaned.skippedDomains, []);
    assert.deepEqual(cleaned.searchSignatures, []);
    assert.equal(cleaned.pendingSearch, null);
    assert.deepEqual(operation(db, 'accepted-1'), before.accepted);
    assert.deepEqual(operation(db, 'active-1'), before.active);
    assert.deepEqual(operation(db, 'unsafe-1'), before.unsafe);
    assert.deepEqual(job(db, 'job-paused'), before.paused);
    assert.equal(
      db.prepare('SELECT data FROM website_research_identities').get().data,
      before.websiteIdentity,
    );
    assert.equal(
      db.prepare('SELECT data FROM company_identities').get().data,
      before.companyIdentity,
    );

    const second = cleanupRejectedHistory(db, { apply: true, clearModelCache: true });
    assert.equal(second.operationsToRedact, 0);
    assert.equal(second.jobsToClean, 0);
    assert.equal(second.cacheToClear, 2);
    assert.equal(cacheCount(db), 0);
    assert.equal(cleanupRejectedHistory(db, { clearModelCache: true }).cacheToClear, 0);
  } finally {
    db.close();
  }
});

test('批次写入失败时事务撤回操作精简与缓存删除', () => {
  const db = fixture();
  try {
    const before = operation(db, 'rejected-1');
    db.exec(
      "CREATE TRIGGER reject_job_update BEFORE UPDATE ON jobs BEGIN SELECT RAISE(ABORT, 'blocked'); END",
    );
    assert.throws(
      () => cleanupRejectedHistory(db, { apply: true, clearModelCache: true }),
      /blocked/,
    );
    assert.deepEqual(operation(db, 'rejected-1'), before);
    assert.equal(cacheCount(db), 2);
  } finally {
    db.close();
  }
});

test('无法关联操作的淘汰明细阻止整批清理', () => {
  const db = fixture();
  try {
    const before = operation(db, 'rejected-1');
    const terminal = job(db, 'job-1');
    terminal.rows[0].operation_id = 'missing-operation';
    db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(terminal), terminal.id);
    assert.equal(cleanupRejectedHistory(db).unlinkedRejectedRows, 1);
    assert.throws(
      () => cleanupRejectedHistory(db, { apply: true, clearModelCache: true }),
      /无法核对的历史淘汰明细/,
    );
    assert.deepEqual(operation(db, 'rejected-1'), before);
    assert.equal(cacheCount(db), 2);
  } finally {
    db.close();
  }
});
