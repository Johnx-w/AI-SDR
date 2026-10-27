import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CustomsDiscovery,
  customsSearchPlan,
  groupShipmentBuyers,
} from '../server/customs-discovery.mjs';
import { normalizeShipment } from '../server/customs-provider.mjs';
import { shipmentProductMatch, obviousLogisticsBuyer } from '../server/customs-products.mjs';

const now = () => new Date('2026-10-23T00:00:00Z');
const search = (extra = {}) => ({
  ...customsSearchPlan({ country: 'United States', product_scope: 'all' }, { now: now() })[0],
  run_id: 'run-1',
  ...extra,
});
const row = (id = 'r1', extra = {}) =>
  normalizeShipment(
    {
      id,
      bill_of_lading_number: 'BL-1',
      date: '2026-09-13',
      description: 'SUNSCREEN FABRIC',
      buyer: { id: 'buyer-1', name: 'Brite Blinds LTD', address: 'Burnaby BC', country: 'CA' },
      ...extra,
    },
    'fixture',
  );
function fixture(pages, options = {}) {
  const calls = [];
  const provider = {
    id: 'fixture',
    async searchShipments(query) {
      calls.push(query);
      return typeof pages === 'function'
        ? pages(query)
        : pages[Math.min(calls.length - 1, pages.length - 1)];
    },
  };
  const discovery = new CustomsDiscovery({ provider, now, ...options });
  return { discovery, calls };
}

test('North American plan covers six product packs without expanding source markets; HS is an independent lane', () => {
  const broad = customsSearchPlan({ country: 'Canada', product_scope: 'all' });
  assert.equal(broad.length, 6);
  assert.ok(broad.every((p) => p.country === 'Canada' && p.source_markets.join() === 'US'));
  const plan = customsSearchPlan({
    country: 'Canada',
    product_scope: 'all',
    customs_hs_codes: { fabrics: ['5903'] },
  });
  assert.equal(plan.length, 7);
  assert.deepEqual(
    [...new Set(plan.map((p) => p.family))],
    [
      'fabrics',
      'components',
      'plantation_shutters',
      'finished_blinds',
      'outdoor_shading',
      'samples',
    ],
  );
  assert.deepEqual(
    broad.map((p) => p.family),
    [...new Set(plan.map((p) => p.family))],
  );
  assert.ok(plan.every((p) => p.products.length === 0 || !p.hs_codes));
  assert.ok(plan.every((p) => p.source_markets[0] === 'US'));
  assert.deepEqual(customsSearchPlan({ country: 'Australia', product_scope: 'all' }), []);
  assert.equal(
    customsSearchPlan({ country: 'United States', product: 'roller blinds' })[0].family,
    'finished_blinds',
  );
  assert.equal(
    customsSearchPlan({ country: 'United States', product: 'roller blind fabric' })[0].family,
    'fabrics',
  );
});

test('cargo post-filter distinguishes materials, blind components and indoor shutters from broad-match noise', () => {
  for (const text of [
    'SUNSCREEN FABRIC',
    'ROLLER BLINDS FABRIC',
    'POLYESTER FABRIC FOR ROLLER BLINDS',
    '3% SUNSCREEN FABRIC',
  ])
    assert.ok(shipmentProductMatch(text, 'fabrics'), text);
  for (const text of [
    'ROLLER BEARING; APPAREL FABRIC',
    'ROLLER BLIND; SOFA FABRIC',
    'WEED BARRIER FABRIC',
    'BLACKOUT CURTAINS',
  ])
    assert.equal(shipmentProductMatch(text, 'fabrics'), false, text);
  for (const text of [
    'BASSWOOD BLINDS SLAT',
    'COMPONENTS OF BLINDS',
    'ROLLER BLIND CLUTCH',
    'FAUXWOOD BLINDS COMPONENTS',
  ])
    assert.ok(shipmentProductMatch(text, 'components'), text);
  assert.equal(shipmentProductMatch('BLIND FLANGE COMPONENTS', 'components'), false);
  assert.equal(shipmentProductMatch('WOOD PLANTATION SHUTTER', 'plantation_shutters'), true);
  assert.equal(shipmentProductMatch('HURRICANE ROLLER SHUTTER', 'plantation_shutters'), false);
  assert.ok(obviousLogisticsBuyer('Globe Express Services'));
  assert.ok(obviousLogisticsBuyer('CHAIN LOGIC INTERNATIONAL'));
  assert.ok(obviousLogisticsBuyer('Amazon Logistics'));
  assert.equal(obviousLogisticsBuyer('AHD Blind Factory'), false);
});

test('discovery rejects logistics and irrelevant cargo; US disclosure does not change Canadian operating country', async () => {
  const { discovery } = fixture([
    {
      records: [
        row(),
        row('r2', { buyer: { name: 'Amazon Logistics' } }),
        row('r3', { description: 'WEED BARRIER FABRIC' }),
        row('r4', { buyer: { name: 'TO ORDER' } }),
      ],
      total: 4,
    },
  ]);
  try {
    const out = await discovery.discover({}, search());
    assert.equal(out.buyers.length, 1);
    assert.equal(out.buyers[0].country, 'CA');
    assert.equal(out.usage.rejected_logistics, 1);
    assert.equal(out.usage.rejected_product, 1);
    assert.equal(out.usage.rejected_unknown_buyer, 1);
    assert.equal(out.usage.charged_records, 4);
    assert.equal(out.usage.credits, null, 'unknown provider pricing must not be invented');
    assert.deepEqual(out.usage.query.date_range, {
      start_date: '2025-10-23',
      end_date: '2026-10-23',
    });
  } finally {
    discovery.close();
  }
});

test('record dedupe and B/L metrics preserve distinct parties and unknown bill counts, not orders', () => {
  const a = row(),
    b = row('r2'),
    c = row('r3', { bill_of_lading_number: null, date: null });
  const d = row('r4', { buyer: { id: 'buyer-2', name: 'Different Buyer' } });
  const buyers = groupShipmentBuyers([a, b, c, d], 'fabrics');
  assert.equal(buyers.length, 2);
  assert.equal(buyers[0].metrics.record_count, 3);
  assert.equal(buyers[0].metrics.bill_of_lading_count, 1);
  assert.equal(buyers[0].metrics.unnumbered_record_count, 1);
  assert.equal(buyers[0].metrics.frequency_semantics, 'observed_bills_not_purchase_orders');
  assert.equal(buyers[1].metrics.bill_of_lading_count, 1);
});

test('persisted successful page is replay-safe across service restart and budgets only returned records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'customs-test-'));
  const env = { CUSTOMS_DB_PATH: join(dir, 'store.sqlite') };
  const s = search({
    page_no: 1,
    page_size: 50,
    date_range: { start_date: '2025-10-23', end_date: '2026-10-23' },
  });
  const first = fixture([{ records: [row()], total: 1 }], { env });
  try {
    const out = await first.discovery.discover({}, s);
    assert.equal(out.usage.run_used_records, 1);
  } finally {
    first.discovery.close();
  }
  const second = fixture(
    () => {
      throw new Error('must never fetch cached page');
    },
    { env },
  );
  try {
    const out = await second.discovery.discover({}, s);
    assert.equal(second.calls.length, 0);
    assert.equal(out.usage.cache_hits, 1);
    assert.equal(out.usage.charged_records, 0);
    assert.equal(out.buyers.length, 1);
    assert.equal(out.usage.run_used_records, 1);
  } finally {
    second.discovery.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('network-uncertain page reserves budget and cannot be auto-billed again', async () => {
  const { discovery, calls } = fixture(() => {
    throw new Error('timeout');
  });
  try {
    await assert.rejects(discovery.discover({}, search()), /timeout/);
    await assert.rejects(discovery.discover({}, search()), /待核对/);
    assert.equal(calls.length, 1);
    assert.deepEqual({ ...discovery.store.run('run-1') }, { used: 0, reserved: 50 });
  } finally {
    discovery.close();
  }
});

test('implicit query in same run replays cached page even after discovery cursor advanced', async () => {
  const { discovery, calls } = fixture([{ records: [row()], total: 100 }]);
  try {
    const first = await discovery.discover({}, search());
    assert.equal(first.next_search.page_no, 2);
    const replayed = await discovery.discover({}, search());
    assert.equal(replayed.usage.cache_hits, 1);
    assert.equal(replayed.buyers.length, 1);
    assert.equal(replayed.usage.query.page_no, 1);
    assert.equal(calls.length, 1);
  } finally {
    discovery.close();
  }
});

test('hard run cap is 300 returned records and pages never exceed 50', async () => {
  const { discovery, calls } = fixture((query) => ({
    records: Array.from({ length: query.page_size }, (_, i) => row('r' + query.page_no + '-' + i)),
    total: 1000,
  }));
  try {
    let s = search(),
      out;
    for (let i = 0; i < 6; i++) {
      out = await discovery.discover({}, s);
      s = out.next_search;
    }
    assert.equal(out.usage.run_used_records, 300);
    const exhausted = await discovery.discover({}, s);
    assert.equal(exhausted.usage.budget_exhausted, true);
    assert.equal(calls.length, 6);
    assert.ok(calls.every((q) => q.page_size === 50));
    await assert.rejects(discovery.discover({}, search({ page_size: 51 })), /50/);
  } finally {
    discovery.close();
  }
});

test('incomplete scan resumes saved page; complete baseline refreshes last 30 days', async () => {
  const { discovery, calls } = fixture([
    { records: [row()], total: 51 },
    { records: [row('r2')], total: 51 },
    { records: [], total: 0 },
  ]);
  try {
    await discovery.discover({}, search());
    const continued = await discovery.discover({}, search({ run_id: 'run-2' }));
    assert.equal(calls[1].page_no, 2);
    assert.equal(continued.next_search, undefined);
    await discovery.discover({}, search({ run_id: 'run-3' }));
    assert.equal(calls[2].page_no, 1);
    assert.deepEqual(calls[2].date_range, { start_date: '2026-09-23', end_date: '2026-10-23' });
  } finally {
    discovery.close();
  }
});

test('overlapping queries dedupe record IDs within family, but preserve separate product opportunities', async () => {
  const common = row('shared', { description: 'SUNSCREEN FABRIC AND BLIND COMPONENTS' });
  const { discovery } = fixture([{ records: [common], total: 1 }]);
  try {
    assert.equal((await discovery.discover({}, search())).buyers.length, 1);
    const repeated = await discovery.discover({}, search({ products: ['roller blind fabric'] }));
    assert.equal(repeated.buyers.length, 0);
    assert.equal(repeated.usage.duplicate_records, 1);
    const another = await discovery.discover(
      {},
      search({ family: 'components', products: ['blind components'] }),
    );
    assert.equal(another.buyers.length, 1);
    assert.equal(another.buyers[0].product_family, 'components');
  } finally {
    discovery.close();
  }
});

test('unknown record IDs retain separate cargo lines even when their B/L and content match', async () => {
  const { discovery } = fixture([{ records: [row(null), row(null)], total: 2 }]);
  try {
    assert.equal((await discovery.discover({}, search())).buyers[0].metrics.record_count, 2);
  } finally {
    discovery.close();
  }
});

test('mixed product and HS queries and unsupported markets are rejected before fetch', async () => {
  const { discovery, calls } = fixture([]);
  try {
    await assert.rejects(discovery.discover({}, search({ hs_codes: ['5903'] })), /独立查询/);
    await assert.rejects(discovery.discover({}, search({ country: 'Australia' })), /美国和加拿大/);
    assert.equal(calls.length, 0);
  } finally {
    discovery.close();
  }
});
