import test from 'node:test';
import assert from 'node:assert/strict';
import { customsSearchPlan, shipmentProductMatch } from '../server/customs-products.mjs';
import { CustomsDiscovery } from '../server/customs-discovery.mjs';
import { normalizeShipment } from '../server/customs-provider.mjs';

test('all-business customs discovery covers six window-covering families without expanding source markets', () => {
  const plan = customsSearchPlan({ country: 'Canada', product_scope: 'all' });
  assert.deepEqual(
    plan.map((p) => p.family),
    [
      'fabrics',
      'components',
      'plantation_shutters',
      'finished_blinds',
      'outdoor_shading',
      'samples',
    ],
  );
  assert.ok(plan.every((p) => p.country === 'Canada' && p.source_markets.join() === 'US'));
  assert.deepEqual(customsSearchPlan({ country: 'Australia', product_scope: 'all' }), []);
});

test('specific customs products retain selected terms and aliases instead of expanding to a whole pack', () => {
  for (const [product, family] of [
    ['roller blinds', 'finished_blinds'],
    ['fabric curtains', 'finished_blinds'],
    ['outdoor zip screens', 'outdoor_shading'],
    ['roller shade sample book', 'samples'],
    ['roller blind fabric', 'fabrics'],
    ['roller blind clutch', 'components'],
    ['headrails', 'components'],
    ['blind brackets', 'components'],
    ['PVC shutter', 'plantation_shutters'],
  ]) {
    const plan = customsSearchPlan({
      country: 'United States',
      product_scope: 'specific',
      product,
    });
    assert.equal(plan.length, 1, product);
    assert.equal(plan[0].family, family, product);
    assert.deepEqual(plan[0].products, [product]);
  }
  const plan = customsSearchPlan({
    country: 'United States',
    product_scope: 'specific',
    products: [
      { value: 'cellular blinds', aliases: ['honeycomb blinds'] },
      { value: 'roller blind fabric', aliases: [] },
    ],
  });
  assert.deepEqual(plan.find((p) => p.family === 'finished_blinds').products, [
    'cellular blinds',
    'honeycomb blinds',
  ]);
  assert.deepEqual(plan.find((p) => p.family === 'fabrics').products, ['roller blind fabric']);
  assert.deepEqual(
    customsSearchPlan({
      country: 'United States',
      product_scope: 'specific',
      product: 'industrial valves',
    }),
    [],
  );
  assert.deepEqual(
    customsSearchPlan({ country: 'United States', product_scope: 'specific', product: '' }),
    [],
  );
});

const accepted = {
  finished_blinds: [
    'READY MADE ZEBRA BLINDS',
    'CELLULAR SHADES',
    'MOTORIZED ROLLER BLINDS',
    'FAUX WOOD BLINDS',
    'FABRIC CURTAINS',
  ],
  outdoor_shading: [
    'OUTDOOR ZIP SCREEN',
    'ZIPTRACK BLIND',
    'ZIPPER BLIND',
    'ALUMINUM PERGOLA',
    'LOUVER PERGOLA',
  ],
  samples: [
    'ROLLER SHADE SAMPLE BOOK',
    'BLINDS FABRIC SWATCH BOOK',
    'WINDOW COVERING DISPLAY KIT',
    'SHADE SAMPLE CARD',
  ],
};
const rejected = {
  finished_blinds: [
    'BLIND FLANGE',
    'ROLLER BLIND CLUTCH',
    'ROLLER SHADE FABRIC',
    'ROLLER SHADE SAMPLE BOOK',
    'SHOWER CURTAIN',
  ],
  outdoor_shading: [
    'INFLATABLE SCREEN',
    'ELECTRONIC SCREEN',
    'ZIP TIES',
    'STEEL BUILDING MATERIAL',
    'HURRICANE ROLLER SHUTTER',
  ],
  samples: [
    'FABRIC SWATCH BOOK',
    'GARMENT FABRIC SAMPLE BOOK',
    'FURNITURE DISPLAY KIT',
    'ROLLER SHADE FABRIC',
    'PRINTED BOOKS',
  ],
};

test('new cargo filters require window-covering products and preserve product forms', () => {
  for (const [family, descriptions] of Object.entries(accepted))
    for (const description of descriptions)
      assert.equal(shipmentProductMatch(description, family), true, description);
  for (const [family, descriptions] of Object.entries(rejected))
    for (const description of descriptions)
      assert.equal(shipmentProductMatch(description, family), false, description);
  assert.equal(shipmentProductMatch('ROLLER SHADE FABRIC SAMPLE BOOK', 'fabrics'), false);
  assert.equal(shipmentProductMatch('CURTAIN FABRIC', 'fabrics'), true);
  assert.equal(shipmentProductMatch('FABRIC FOR CURTAINS', 'fabrics'), true);
  assert.equal(shipmentProductMatch('FABRIC CURTAINS', 'fabrics'), false);
  assert.equal(shipmentProductMatch('HEADRAILS FOR BLINDS', 'components'), true);
  assert.equal(shipmentProductMatch('BLIND BRACKETS', 'components'), true);
});

test('new packs pass through real discovery and reject unrelated cargo before producing buyers', async () => {
  const calls = [];
  const discovery = new CustomsDiscovery({
    provider: {
      id: 'fixture',
      async searchShipments(query) {
        calls.push(query);
        return {
          records: [accepted[query.family][0], rejected[query.family][0]].map(
            (description, index) =>
              normalizeShipment(
                {
                  id: `${query.family}-${index}`,
                  description,
                  buyer: { name: 'Window Covering Business' },
                },
                'fixture',
              ),
          ),
          total: 2,
        };
      },
    },
  });
  try {
    for (const family of Object.keys(accepted)) {
      const search = customsSearchPlan({ country: 'United States', product_scope: 'all' }).find(
        (p) => p.family === family,
      );
      assert.ok(search, family);
      const result = await discovery.discover({}, { ...search, run_id: `scope-${family}` });
      assert.equal(result.buyers.length, 1);
      assert.equal(result.buyers[0].records.length, 1);
      assert.equal(result.usage.rejected_product, 1);
    }
    assert.equal(calls.length, 3);
  } finally {
    discovery.close();
  }
});
