import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BillOfLadingDataProvider,
  HttpCustomsProvider,
  createCustomsProvider,
  normalizeShipment,
  customsConfig,
} from '../server/customs-provider.mjs';

const query = {
  products: ['sunscreen fabric'],
  hs_codes: [],
  page_no: 1,
  page_size: 50,
  source_markets: ['US'],
  date_range: { start_date: '2025-10-23', end_date: '2026-10-23' },
};
test('BillOfLadingData adapter uses documented POST endpoint, auth, request and raw fields', async () => {
  const upstream = {
    id: 'r1',
    bydate: 20260913,
    country_imp: 'US',
    country_exp: 'CN',
    consignee_name: 'BRITE BLINDS LTD',
    shipper_name: 'SUPPLIER',
    products: 'SUNSCREEN FABRIC',
    bill_of_lading_nbr: 'BL-1',
    manifest_qty: 12,
    manifest_units: 'PKG',
    weight: 260,
    weight_unit: 'KG',
    amount: 0,
  };
  const provider = new BillOfLadingDataProvider({
    env: { CUSTOMS_API_KEY: 'test-key' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://tradedata.billofladingdata.com/partner-api/shipping-records');
      assert.equal(options.headers['api-key'], 'test-key');
      assert.deepEqual(JSON.parse(options.body), {
        type: 'imp',
        page_size: 50,
        page_no: 1,
        date_range: query.date_range,
        import_countries: ['US'],
        products: ['sunscreen fabric'],
      });
      return {
        ok: true,
        json: async () => ({ code: 200, data: { records: [upstream], total: 1 } }),
      };
    },
  });
  const result = await provider.searchShipments(query);
  assert.equal(result.records[0].buyer.name, 'BRITE BLINDS LTD');
  assert.equal(
    result.records[0].buyer.country,
    null,
    'US import disclosure must not infer operating country',
  );
  assert.equal(result.records[0].date, '2026-09-13');
  assert.equal(result.records[0].amount, null);
  assert.deepEqual(result.records[0].quantity, { value: 12, unit: 'PKG' });
  assert.deepEqual(result.records[0].raw, upstream);
});

test('optional verified identity mapping is explicit and does not copy source-country to buyer', async () => {
  const provider = new BillOfLadingDataProvider({
    env: {
      CUSTOMS_API_KEY: 'test',
      CUSTOMS_FIELD_MAP: '{"buyer_id":"entity.id","buyer_address":"entity.address"}',
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        code: 200,
        data: {
          records: [
            {
              consignee_name: 'BUYER',
              country_imp: 'US',
              entity: { id: 'verified-1', address: 'Burnaby BC' },
            },
          ],
        },
      }),
    }),
  });
  const row = (await provider.searchShipments(query)).records[0];
  assert.equal(row.buyer.id, 'verified-1');
  assert.equal(row.buyer.address, 'Burnaby BC');
  assert.equal(row.buyer.country, null);
});

test('normalized HTTP bridge swaps customs supplier without changing discovery contract', async () => {
  const provider = new HttpCustomsProvider({
    env: { CUSTOMS_BASE_URL: 'https://customs.example/shipments', CUSTOMS_API_KEY: 'test' },
    fetchImpl: async (url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer test');
      assert.deepEqual(JSON.parse(options.body), query);
      return {
        ok: true,
        json: async () => ({
          records: [
            { id: 'a', description: 'SUNSCREEN FABRIC', buyer: { name: 'Buyer', country: 'CA' } },
          ],
          total: 1,
        }),
      };
    },
  });
  assert.equal((await provider.searchShipments(query)).records[0].buyer.country, 'CA');
});

test('configuration readiness uses adapter validation without opening a database or making calls', () => {
  assert.deepEqual(customsConfig({}), {
    provider: '',
    configured: false,
    missing: ['CUSTOMS_PROVIDER'],
  });
  assert.deepEqual(customsConfig({ CUSTOMS_PROVIDER: 'http' }).missing, ['CUSTOMS_BASE_URL']);
  assert.equal(
    customsConfig({ CUSTOMS_PROVIDER: 'http', CUSTOMS_BASE_URL: 'https://example.org/customs' })
      .configured,
    true,
  );
  assert.equal(
    customsConfig({ CUSTOMS_PROVIDER: 'billofladingdata', CUSTOMS_API_KEY: 'key' }).configured,
    true,
  );
  assert.equal(
    customsConfig({
      CUSTOMS_PROVIDER: 'http',
      CUSTOMS_BASE_URL: 'https://user:pass@example.org/customs',
    }).configured,
    false,
  );
});

test('provider selection is explicit and error text does not disclose response secrets', async () => {
  assert.throws(() => createCustomsProvider({ env: {} }), /CUSTOMS_PROVIDER/);
  assert.throws(
    () => new HttpCustomsProvider({ env: { CUSTOMS_API_URL: 'http://remote.example/' } }),
    /HTTPS/,
  );
  const provider = new BillOfLadingDataProvider({
    env: { CUSTOMS_API_KEY: 'secret-key' },
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'secret-key' }),
  });
  await assert.rejects(
    provider.searchShipments(query),
    (e) => /401/.test(e.message) && !e.message.includes('secret-key'),
  );
});

test('shipment missing dates and units remains unknown; impossible date is not normalized silently', () => {
  const row = normalizeShipment({
    date: '2026-02-31',
    description: '',
    buyer: { name: 'Buyer' },
    quantity: { value: 5 },
    amount: { value: 0 },
  });
  assert.equal(row.date, null);
  assert.equal(row.quantity.unit, null);
  assert.equal(row.amount, null);
});
