import test from 'node:test';
import assert from 'node:assert/strict';
import { matchShipmentBuyer, mergeShipmentEvidence } from '../server/shipment-evidence.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
const website = 'https://brite.example.com/';
const research = {
  company_name: 'Brite Blinds Ltd',
  actual_country: 'Canada',
  address: { street: '4275 Phillips Avenue', city: 'Burnaby', postal_code: 'V5A 2X4' },
};

test('trade identity needs independent corroboration; disclosed US market cannot establish Canadian buyer country', () => {
  assert.equal(
    matchShipmentBuyer(
      {
        name: 'Brite Blinds LTD',
        address: '4275 Phillips Avenue Burnaby BC V5A2X4',
        country: null,
      },
      research,
      website,
    ).status,
    'verified',
  );
  assert.equal(
    matchShipmentBuyer({ name: 'Brite Blinds', country: null }, research, website).status,
    'name_only',
  );
  assert.equal(
    matchShipmentBuyer({ name: 'Brite Blinds', country: 'United States' }, research, website)
      .status,
    'conflict',
  );
  assert.equal(
    matchShipmentBuyer({ name: 'Bumblebee Blinds', address: 'V5A2X4' }, research, website).status,
    'conflict',
  );
});

test('persistent shared company evidence separates families and roles, dedupes records not purchase orders', () => {
  const store = new AcquisitionStore();
  const row = {
    provider: 'fake',
    id: '1',
    date: '2026-10-01',
    bill_of_lading_number: 'BL1',
    description: 'sunscreen fabric',
  };
  try {
    store.saveCustomsEvidence(
      website,
      { id: 'buyer1', name: 'Brite Blinds', product_family: 'fabrics', records: [row] },
      { status: 'verified' },
      'rec1',
    );
    store.saveCustomsEvidence(website, {
      id: 'buyer1',
      name: 'Brite Blinds',
      product_family: 'fabrics',
      records: [row, { ...row, id: '2' }, { ...row, id: '3', bill_of_lading_number: null }],
    });
    store.saveCustomsEvidence(website, {
      id: 'buyer1',
      name: 'Brite Blinds',
      product_family: 'components',
      records: [{ ...row, description: 'blind components' }],
    });
    const entries = store.customsEvidence(website);
    assert.equal(entries.length, 2);
    const fabric = entries.find((b) => b.product_family === 'fabrics');
    assert.equal(fabric.metrics.record_count, 3);
    assert.equal(fabric.metrics.bill_of_lading_count, 1);
    assert.equal(fabric.metrics.unnumbered_record_count, 1);
    assert.equal(fabric.match.status, 'verified');
    store.saveWebsiteResearch(website, research, 'rec1');
    assert.equal(store.websiteResearch(website).actual_country, 'Canada');
  } finally {
    store.close();
  }
  assert.equal(
    mergeShipmentEvidence({}, { records: [row, { ...row, provider: 'other' }] }).metrics
      .record_count,
    2,
  );
});
