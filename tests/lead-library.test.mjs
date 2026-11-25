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
test('summary omits full dossiers while preserving rating and contact indicators', () => {
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
    }),
  );
  assert.equal(summary.ratingSummary, '主营产品：卷帘');
  assert.deepEqual(summary.contactSummary, {
    label: '邮箱与电话已记录',
    detail: '1 个邮箱 · 1 个电话',
  });
  assert.equal(summary.customsSummary, undefined);
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
    '关键依据尚未核实',
  );
  assert.equal(
    summarizeLead(lead({ email: '', phone: '', contactEvidence: [] })).contactSummary.label,
    '暂无公开联系入口',
  );
  assert.equal(
    summarizeLead(
      lead({
        grade: 'A',
        assessment: {
          matchLevel: '明确匹配',
          prioritySignals: [{ label: '主营产品' }, { label: '专业供货角色' }],
        },
      }),
    ).ratingSummary,
    '主营产品、专业供货角色已核实',
  );
  assert.equal(
    summarizeLead(lead({ grade: 'A', assessment: { matchLevel: '明确匹配' } })).matchLevel,
    '明确匹配',
  );
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

test('array order changes customer content version while object property order does not', () => {
  const customer = lead({ facts: [{ field: 'first' }, { field: 'second' }] });
  assert.equal(summarizeLead(customer).version, summarizeLead(reverseKeys(customer)).version);
  assert.notEqual(
    summarizeLead(customer).version,
    summarizeLead({ ...customer, facts: [...customer.facts].reverse() }).version,
  );
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
