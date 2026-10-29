import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LeadLibrary, summarizeLead } from '../server/lead-library.mjs';
import { DatabaseSync } from 'node:sqlite';

const lead = (overrides = {}) => ({
  id: 'rec-1',
  name: 'Acme Screens',
  website: 'https://acme.example.org/',
  domain: 'acme.example.org',
  market: 'Australia',
  type: 'manufacturer',
  product: 'roller blinds',
  grade: 'A',
  score: 85,
  status: '待开发',
  email: 'sales@acme.example.org',
  phone: '+61 2 1234 5678',
  facts: [{ field: 'product', value: 'roller blinds', quote: 'FULL_DOSSIER' }],
  contactEvidence: [],
  fields: { 画像JSON: 'FULL_RAW_FIELDS' },
  assessment: { evidenceReason: '主营产品：卷帘\nFULL_ASSESSMENT' },
  ...overrides,
});
const response = (leads = [lead()]) => ({
  leads,
  total: leads.length,
  syncedAt: '2026-10-25T04:00:00.000Z',
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('summary omits full dossiers while preserving rating, contact and customs indicators', () => {
  const summary = summarizeLead(
    lead({
      createdAt: 1793145600000,
      companyIdentity: {
        legal_name: 'Acme Ltd',
        website_name: 'Acme',
        aliases: ['Acme Screens'],
        status: 'verified',
        evidence: [{ quote: 'FULL_IDENTITY_EVIDENCE' }],
      },
      customsEvidence: [
        {
          match: { status: 'verified' },
          records: [{ provider: 'fixture', id: 'bill-1' }],
        },
        {
          match: { status: 'candidate' },
          records: [{ provider: 'fixture', id: 'bill-1' }],
        },
      ],
    }),
  );
  assert.equal(summary.ratingSummary, '主营产品：卷帘');
  assert.deepEqual(summary.contactSummary, {
    label: '邮箱与电话已记录',
    detail: '1 个邮箱 · 1 个电话',
  });
  assert.deepEqual(summary.customsSummary, { recordCount: 1, buyerCount: 2, unverified: true });
  assert.equal(summary.companyIdentity.legal_name, 'Acme Ltd');
  assert.doesNotMatch(
    JSON.stringify(summary),
    /FULL_|"facts"|"fields"|"assessment"|"customsEvidence"/,
  );
  assert.equal(summary.updatedAt, null);
  assert.equal(summary.createdAt, 1793145600000);
  assert.equal(summarizeLead(lead()).createdAt, null);
  assert.equal(
    summarizeLead(lead({ email: '', phone: '', contactEvidence: [{ kind: 'form' }] }))
      .contactSummary.label,
    '已有联系表单',
  );
  assert.equal(
    summarizeLead(lead({ grade: '未评级', ratingReason: '', assessment: null })).ratingSummary,
    '关键依据待补充',
  );
});

test('initial list/detail concurrent reads share one upstream sync and fresh reads use SQLite', async () => {
  const upstream = deferred();
  let calls = 0;
  const library = new LeadLibrary({
    scope: 'table-a',
    readLeads: () => {
      calls++;
      return upstream.promise;
    },
  });
  try {
    const list = library.list();
    const detail = library.detail('rec-1');
    await tick();
    assert.equal(calls, 1);
    assert.equal(library.refreshing, true);
    upstream.resolve(response());
    assert.equal((await list).leads[0].ratingSummary, '主营产品：卷帘');
    assert.equal((await detail).lead.facts[0].quote, 'FULL_DOSSIER');
    assert.equal((await library.all()).leads[0].fields.画像JSON, 'FULL_RAW_FIELDS');
    assert.equal((await library.list()).scope, 'table-a');
    assert.equal((await library.list()).sync.refreshing, false);
    assert.equal(calls, 1);
  } finally {
    library.close();
  }
});

test('expired snapshot returns immediately while a shared background sync replaces it', async () => {
  let now = 1000;
  let calls = 0;
  const delayed = deferred();
  const library = new LeadLibrary({
    scope: 'table-a',
    now: () => now,
    ttlMs: 100,
    readLeads: () => (++calls === 1 ? response() : delayed.promise),
  });
  try {
    await library.list();
    now += 101;
    const stale = await library.list();
    assert.equal(stale.leads[0].name, 'Acme Screens');
    assert.equal(stale.sync.stale, true);
    assert.equal(stale.sync.refreshing, true);
    await library.list();
    await tick();
    assert.equal(calls, 2);
    delayed.resolve(response([lead({ name: 'New name' })]));
    await library.pending;
    assert.equal((await library.list()).leads[0].name, 'New name');
    assert.equal((await library.list()).sync.stale, false);
  } finally {
    library.close();
  }
});

test('failed refresh retains data, sanitizes error, and throttles automatic retries', async () => {
  let now = 1000;
  let calls = 0;
  const library = new LeadLibrary({
    now: () => now,
    ttlMs: 100,
    retryMs: 500,
    readLeads: () => {
      if (++calls === 1) return response();
      throw new Error('SECRET_TOKEN_FROM_UPSTREAM');
    },
  });
  try {
    await library.list();
    now += 101;
    await library.list();
    await tick();
    const stale = await library.list();
    assert.equal(stale.leads[0].name, 'Acme Screens');
    assert.match(stale.sync.error, /同步失败/);
    assert.doesNotMatch(JSON.stringify(stale), /SECRET_TOKEN/);
    assert.equal(calls, 2);
    now += 499;
    await library.list();
    assert.equal(calls, 2);
    now += 1;
    await library.list();
    await tick();
    assert.equal(calls, 3);
    await assert.rejects(library.refresh(), /同步失败/);
    assert.equal(calls, 4);
  } finally {
    library.close();
  }
});

test('restart preserves snapshots including empty tables and isolates other table scopes', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'lead-library-'));
  const path = join(folder, 'customers.sqlite');
  let library;
  try {
    library = new LeadLibrary({ path, scope: 'table-a', readLeads: async () => response() });
    await library.list();
    library.close();
    library = new LeadLibrary({
      path,
      scope: 'table-a',
      readLeads: () => {
        throw new Error('must not read upstream');
      },
    });
    assert.equal((await library.list()).leads[0].id, 'rec-1');
    library.close();
    library = new LeadLibrary({ path, scope: 'table-b', readLeads: async () => response([]) });
    assert.equal((await library.list()).total, 0);
    library.close();
    library = new LeadLibrary({
      path,
      scope: 'table-b',
      readLeads: () => {
        throw new Error('empty snapshot still initialized');
      },
    });
    assert.equal((await library.list()).total, 0);
    await assert.rejects(library.detail('rec-1'), { status: 404 });
  } finally {
    library?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('invalid, duplicate and incomplete full responses cannot delete a successful snapshot', async () => {
  let next = response();
  const library = new LeadLibrary({ readLeads: async () => next });
  try {
    await library.list();
    for (const invalid of [
      {},
      response([lead(), lead()]),
      response([{ id: 'partial', name: 'Partial record' }]),
      { ...response([]), total: 1 },
    ]) {
      next = invalid;
      await assert.rejects(library.refresh(), /同步失败/);
      assert.equal((await library.list()).leads[0].id, 'rec-1');
    }
    next = response([]);
    assert.equal((await library.refresh()).total, 0);
    await assert.rejects(library.detail('rec-1'), { status: 404 });
  } finally {
    library.close();
  }
});

test('local confirmed edits and newly added customers survive older in-flight refreshes', async () => {
  let calls = 0;
  const delayed = deferred();
  const library = new LeadLibrary({
    readLeads: () => (++calls === 1 ? response() : delayed.promise),
  });
  try {
    await library.list();
    const originalRevision = (await library.list()).sync.revision;
    const refresh = library.refresh();
    await tick();
    library.upsert({ id: 'rec-1', email: 'confirmed@acme.example.org' });
    library.upsert(lead({ id: 'rec-new', name: 'New company' }));
    delayed.resolve(response([lead({ email: 'older@acme.example.org' })]));
    await refresh;
    assert.equal((await library.detail('rec-1')).lead.email, 'confirmed@acme.example.org');
    assert.equal((await library.detail('rec-new')).lead.name, 'New company');
    assert.equal((await library.list()).total, 2);
    assert.ok((await library.list()).sync.revision > originalRevision);
  } finally {
    library.close();
  }
});

test('verification refresh starts a new upstream read after an already running read settles', async () => {
  const older = deferred();
  let calls = 0;
  const library = new LeadLibrary({
    readLeads: () => (++calls === 1 ? older.promise : response([lead({ name: 'Verified new' })])),
  });
  try {
    const first = library.refresh();
    await tick();
    const verified = library.refresh({ afterCurrent: true });
    assert.equal(calls, 1);
    older.resolve(response());
    await first;
    assert.equal((await verified).leads[0].name, 'Verified new');
    assert.equal(calls, 2);
    await library.refresh({ afterCurrent: true });
    assert.equal(calls, 3);
  } finally {
    library.close();
  }
});

test('verification refresh proceeds when an earlier background read fails', async () => {
  const older = deferred();
  let calls = 0;
  const library = new LeadLibrary({
    readLeads: () => (++calls === 1 ? older.promise : response()),
  });
  try {
    const first = library.refresh();
    const failed = assert.rejects(first, /同步失败/);
    const verified = library.refresh({ afterCurrent: true });
    older.reject(new Error('network interruption'));
    await failed;
    assert.equal((await verified).total, 1);
    assert.equal(calls, 2);
  } finally {
    library.close();
  }
});

test('invalidation schedules background work and a later invalidation is retained across sync', async () => {
  const delayed = deferred();
  let calls = 0;
  const library = new LeadLibrary({
    readLeads: () => (++calls === 1 ? response() : delayed.promise),
  });
  try {
    await library.list();
    library.invalidate();
    assert.equal(calls, 1);
    assert.equal((await library.list()).sync.refreshing, true);
    library.invalidate();
    delayed.resolve(response());
    await library.pending;
    assert.equal(library.stale(), true);
  } finally {
    library.close();
  }
});

test('close cancels timers and prevents an in-flight response from writing to a closed database', async () => {
  const delayed = deferred();
  const library = new LeadLibrary({ readLeads: () => delayed.promise, intervalMs: 10 });
  library.start();
  const refresh = library.refresh();
  const failed = assert.rejects(refresh, /同步失败/);
  library.close();
  library.close();
  delayed.resolve(response());
  await failed;
  await assert.rejects(library.list(), { status: 503 });
  assert.throws(() => library.start(), { status: 503 });
});

function observeCustomerWrites(library) {
  library.db.exec(`CREATE TABLE observed_customer_writes(operation TEXT);
    CREATE TRIGGER observe_customer_insert AFTER INSERT ON lead_library_customers
      BEGIN INSERT INTO observed_customer_writes VALUES('insert'); END;
    CREATE TRIGGER observe_customer_update AFTER UPDATE ON lead_library_customers
      BEGIN INSERT INTO observed_customer_writes VALUES('update'); END;
    CREATE TRIGGER observe_customer_delete AFTER DELETE ON lead_library_customers
      BEGIN INSERT INTO observed_customer_writes VALUES('delete'); END;`);
  return () =>
    library.db
      .prepare('SELECT operation FROM observed_customer_writes')
      .all()
      .map((row) => row.operation);
}

const reverseKeys = (value) =>
  Array.isArray(value)
    ? value.map(reverseKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reverseKeys(item)]),
        )
      : value;

test('unchanged sync and no-op upsert write no customer rows and keep revision and content versions', async () => {
  let next = response([lead(), lead({ id: 'rec-2', name: 'Second' })]);
  const library = new LeadLibrary({ readLeads: async () => next });
  try {
    const first = await library.list();
    const writes = observeCustomerWrites(library);
    next = reverseKeys(next);
    const before = JSON.stringify(next);
    const same = await library.refresh();
    assert.equal(JSON.stringify(next), before, 'hashing never mutates upstream data');
    assert.deepEqual(writes(), []);
    assert.equal(same.sync.revision, first.sync.revision);
    assert.deepEqual(
      same.leads.map((row) => row.version),
      first.leads.map((row) => row.version),
    );
    assert.equal(same.sync.metrics.last.rowsWritten, 0);
    assert.equal(same.sync.metrics.last.unchanged, 2);
    library.upsert({ id: 'rec-1', email: lead().email });
    assert.deepEqual(writes(), []);
    assert.equal((await library.list()).sync.revision, first.sync.revision);
    const full = await library.detail('rec-1');
    assert.equal(full.version, same.leads[0].version);
    assert.equal('version' in full.lead, false);
  } finally {
    library.close();
  }
});

test('only changed and deleted rows are written, and customer order never changes content versions', async () => {
  let next = response([lead(), lead({ id: 'rec-2', name: 'Second' }), lead({ id: 'rec-3' })]);
  const library = new LeadLibrary({ readLeads: async () => next });
  try {
    const initial = await library.list();
    const versions = Object.fromEntries(initial.leads.map((row) => [row.id, row.version]));
    const writes = observeCustomerWrites(library);
    next = response([lead({ name: 'Changed' }), lead({ id: 'rec-2', name: 'Second' })]);
    const changed = await library.refresh();
    assert.deepEqual(writes(), ['update', 'delete']);
    assert.notEqual(changed.leads[0].version, versions['rec-1']);
    assert.equal(changed.leads[1].version, versions['rec-2']);
    assert.deepEqual(
      Object.fromEntries(
        ['inserted', 'updated', 'deleted', 'unchanged', 'rowsWritten'].map((key) => [
          key,
          changed.sync.metrics.last[key],
        ]),
      ),
      { inserted: 0, updated: 1, deleted: 1, unchanged: 1, rowsWritten: 2 },
    );
    const priorRevision = changed.sync.revision;
    next = response([...next.leads].reverse());
    const reordered = await library.refresh();
    assert.equal(reordered.sync.revision, priorRevision + 1);
    assert.equal(reordered.leads[0].id, 'rec-2');
    assert.equal(reordered.leads[0].version, versions['rec-2']);
    assert.equal(reordered.leads[1].version, changed.leads[0].version);
    assert.equal(reordered.sync.metrics.last.updated, 0);
    assert.equal(reordered.sync.metrics.last.reordered, 2);
    assert.equal(reordered.sync.metrics.last.rowsWritten, 2);
  } finally {
    library.close();
  }
});

test('array order changes customer content version while object property order does not', () => {
  const customer = lead({ facts: [{ field: 'first' }, { field: 'second' }] });
  assert.equal(summarizeLead(customer).version, summarizeLead(reverseKeys(customer)).version);
  assert.notEqual(
    summarizeLead(customer).version,
    summarizeLead({ ...customer, facts: [...customer.facts].reverse() }).version,
  );
});

test('confirmed no-op save still overrides an older in-flight sync response', async () => {
  const older = deferred();
  let calls = 0;
  const library = new LeadLibrary({
    readLeads: () => (++calls === 1 ? response() : older.promise),
  });
  try {
    const original = await library.list();
    const writes = observeCustomerWrites(library);
    const refresh = library.refresh();
    await tick();
    library.upsert({ id: 'rec-1', email: lead().email });
    older.resolve(response([lead({ email: 'obsolete@acme.example.org' })]));
    const result = await refresh;
    assert.equal(result.leads[0].email, lead().email);
    assert.equal(result.sync.revision, original.sync.revision);
    assert.deepEqual(writes(), []);
  } finally {
    library.close();
  }
});

test('old SQLite snapshots gain versions without losing detail, ordering or revision', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'lead-library-migration-'));
  const path = join(folder, 'customers.sqlite');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE lead_library_customers (
    scope TEXT NOT NULL,record_id TEXT NOT NULL,position INTEGER NOT NULL,
    summary TEXT NOT NULL,detail TEXT NOT NULL,PRIMARY KEY(scope,record_id));
    CREATE TABLE lead_library_sync (
    scope TEXT PRIMARY KEY,synced_at TEXT NOT NULL,refreshed_at INTEGER NOT NULL,revision INTEGER NOT NULL);`);
  old
    .prepare('INSERT INTO lead_library_customers VALUES(?,?,?,?,?)')
    .run('table-a', 'rec-1', 0, JSON.stringify({ id: 'rec-1' }), JSON.stringify(lead()));
  old
    .prepare('INSERT INTO lead_library_sync VALUES(?,?,?,?)')
    .run('table-a', '2026-10-25T04:00:00.000Z', 1000, 7);
  old.close();
  let library;
  try {
    library = new LeadLibrary({
      path,
      scope: 'table-a',
      now: () => 1000,
      readLeads: async () => {
        throw new Error('migration must be local');
      },
    });
    const list = await library.list();
    assert.equal(list.sync.revision, 7);
    assert.match(list.leads[0].version, /^[a-f0-9]{64}$/);
    assert.equal((await library.detail('rec-1')).lead.fields.画像JSON, 'FULL_RAW_FIELDS');
    observeCustomerWrites(library);
    library.close();
    library = new LeadLibrary({
      path,
      scope: 'table-a',
      now: () => 1000,
      readLeads: async () => response(),
    });
    assert.equal((await library.list()).leads[0].version, list.leads[0].version);
    assert.deepEqual(
      library.db.prepare('SELECT operation FROM observed_customer_writes').all(),
      [],
    );
  } finally {
    library?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('deterministic background ticks slow down when idle and return to active after explicit touch', async () => {
  let now = 1000;
  let calls = 0;
  const library = new LeadLibrary({
    now: () => now,
    readLeads: async () => {
      calls++;
      return response();
    },
  });
  try {
    assert.equal(await library.tick(), false);
    assert.equal(calls, 0);
    await library.list();
    now = 61000;
    assert.equal(await library.tick(), true);
    assert.equal(calls, 2);
    now = 121000;
    assert.equal(library.mode, 'idle');
    assert.equal(library.intervalMs, 300000);
    assert.equal(await library.tick(), false);
    now = 360999;
    library.metrics();
    assert.equal(await library.tick(), false);
    now = 361000;
    assert.equal(await library.tick(), true);
    assert.equal(calls, 3);
    assert.equal(library.mode, 'idle', 'background sync does not mark foreground activity');
    library.touch();
    assert.equal(library.mode, 'active');
    assert.equal(library.intervalMs, 60000);
    now += 60000;
    assert.equal(await library.tick(), true);
    assert.equal(calls, 4);
    const metadata = library.snapshot().sync;
    assert.equal(metadata.mode, 'active');
    assert.equal(metadata.intervalMs, 60000);
    now += 120000;
    library.invalidate();
    assert.equal(library.mode, 'idle');
    assert.equal(await library.tick(), true, 'explicit invalidation bypasses idle interval');
  } finally {
    library.close();
  }
});

test('sync metrics record timing and counts without exposing data and survive restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'lead-library-metrics-'));
  const path = join(folder, 'customers.sqlite');
  let clock = 0;
  let reject = false;
  let library;
  try {
    library = new LeadLibrary({
      path,
      scope: 'table-a',
      monotonicNow: () => clock,
      readLeads: async () => {
        clock += reject ? 30 : 20;
        if (reject) throw new Error('SECRET_TOKEN_ACME');
        return response();
      },
    });
    const initial = await library.list();
    assert.equal(initial.sync.metrics.last.durationMs, 20);
    assert.equal(initial.sync.metrics.last.upstreamMs, 20);
    assert.equal(initial.sync.metrics.last.inserted, 1);
    await library.refresh();
    assert.equal(library.metrics().last.rowsWritten, 0);
    reject = true;
    await assert.rejects(library.refresh(), /同步失败/);
    const metrics = library.metrics();
    assert.equal(metrics.attempts, 3);
    assert.equal(metrics.successes, 2);
    assert.equal(metrics.failures, 1);
    assert.equal(metrics.last.status, 'failed');
    assert.equal(metrics.last.durationMs, 30);
    assert.equal(metrics.last.total, 1);
    assert.equal(metrics.last.rowsWritten, 0);
    assert.doesNotMatch(JSON.stringify(metrics), /SECRET|Acme|acme|FULL/);
    metrics.attempts = 99;
    assert.equal(library.metrics().attempts, 3);
    library.close();
    library = new LeadLibrary({
      path,
      scope: 'table-a',
      readLeads: async () => {
        throw new Error('metrics reads are pure');
      },
    });
    assert.equal(library.metrics().attempts, 3);
    assert.equal(library.metrics().last.status, 'failed');
    assert.equal((await library.detail('rec-1')).lead.name, 'Acme Screens');
  } finally {
    library?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
