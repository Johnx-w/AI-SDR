import test from 'node:test';
import assert from 'node:assert/strict';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { NativeAcquisition } from '../server/native-acquisition.mjs';

const email = 'sales@customer.example';
const evidence = {
  kind: 'email',
  value: email,
  normalized: email,
  source_url: 'https://customer.example/contact',
  quote: 'Business enquiries: sales@customer.example',
  method: 'mailto_link',
  status: '公开未验证',
};
function fixture(t) {
  const store = new AcquisitionStore(':memory:', 'project/table');
  t.after(() => store.close());
  const engine = Object.create(NativeAcquisition.prototype);
  Object.assign(engine, {
    store,
    assessments: { latest: () => null },
    supplements: { confirmations: () => [] },
  });
  const lead = {
    id: 'customer-1',
    name: 'Customer',
    email,
    website: 'https://customer.example/',
    contactEvidence: [],
    facts: [
      {
        field: 'products',
        value: 'Roller Shades',
        quote: 'Roller Shades',
        source_url: 'https://customer.example/',
      },
    ],
  };
  const add = (overrides = {}) => {
    const operation = {
      id: 'research-operation-1',
      scope: store.scope,
      recordId: lead.id,
      state: 'completed',
      source_url: lead.website,
      recordVerifiedAt: '2026-10-26T08:00:00.000Z',
      evidence: { contacts: [evidence] },
      ...overrides,
    };
    store.db
      .prepare('INSERT INTO acquisition_operations VALUES(?,?,?)')
      .run(operation.id, operation.id, JSON.stringify(operation));
  };
  return {
    store,
    engine,
    lead,
    add,
    project: (value = lead) => engine.decorateLeads({ leads: [value] }).leads[0],
  };
}

test('native read projection restores retained email evidence without profile JSON or an assessment and preserves source facts', (t) => {
  const { add, lead, project, store } = fixture(t);
  add();
  const before = store.db.prepare('SELECT data FROM acquisition_operations').get().data;
  const projected = project();
  assert.deepEqual(projected.contactEvidence, [evidence]);
  assert.deepEqual(projected.facts, lead.facts);
  assert.equal(projected.email, email);
  assert.equal(projected.contactEvidence[0].status, '公开未验证');
  assert.equal(projected.contactEvidence[0].verification_status, undefined);
  assert.equal(store.db.prepare('SELECT data FROM acquisition_operations').get().data, before);
  assert.deepEqual(lead.contactEvidence, []);
});

test('projection uses only the current scope, record, domain and latest completed research in deterministic order', (t) => {
  const { add, project } = fixture(t);
  add();
  for (const [suffix, patch] of Object.entries({
    scope: { scope: 'other/table' },
    record: { recordId: 'other-customer' },
    domain: { source_url: 'https://other.example' },
    running: { state: 'running' },
    failed: { state: 'failed' },
  }))
    add({
      id: 'newer-' + suffix,
      recordVerifiedAt: '2026-10-26T10:00:00.000Z',
      evidence: { contacts: [] },
      ...patch,
    });
  assert.deepEqual(project().contactEvidence, [evidence]);
  const latest = { ...evidence, quote: 'Current published contact: ' + email };
  add({ id: 'research-operation-z', evidence: { contacts: [latest] } });
  assert.deepEqual(project().contactEvidence, [latest]);
  add({
    id: 'latest-without-evidence',
    recordVerifiedAt: '2026-10-26T11:00:00.000Z',
    evidence: {},
  });
  assert.deepEqual(project().contactEvidence, []);
});

test('manual removal or replacement never resurrects old email addresses or unsupported contact evidence', (t) => {
  const { add, project, store, lead } = fixture(t);
  add();
  store.saveContactCorrections(lead.id, { email: { value: '' } });
  assert.equal(project().email, '');
  assert.deepEqual(project().contactEvidence, []);
  store.saveContactCorrections(lead.id, { email: { value: 'new@customer.example' } });
  assert.equal(project().email, 'new@customer.example');
  assert.deepEqual(project().contactEvidence, []);
  store.saveContactCorrections(lead.id, { email: { value: email.toUpperCase() } });
  assert.deepEqual(project({ ...lead, contactEvidence: [evidence] }).contactEvidence, [evidence]);
});
