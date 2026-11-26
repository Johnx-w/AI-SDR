import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquisitionMarkets, countryFor } from '../src/domain/country-catalog.ts';
import { regionalSearchAfter } from '../server/search-plan.mjs';

// Independent expected counts for the geographic levels documented in docs/acquisition-regions.md.
const expected = {
  US: [51, 'District of Columbia'],
  AU: [8, 'Victoria'],
  CA: [13, 'Yukon'],
  GB: [12, 'Scotland'],
  SG: [5, 'North West'],
  MY: [16, 'Kedah'],
  NZ: [17, 'Marlborough'],
  TH: [77, 'Bangkok'],
  VN: [34, 'Hue'],
  AE: [7, 'Dubai'],
  ZA: [9, 'Gauteng'],
  GH: [16, 'Bono'],
  PH: [18, 'Negros Island Region'],
  PL: [16, 'Mazovia'],
  NL: [12, 'Zeeland'],
  DE: [16, 'Berlin'],
  IT: [20, 'Sicily'],
  BE: [3, 'Flanders'],
  BR: [27, 'São Paulo'],
  CL: [16, 'Ñuble'],
  AR: [24, 'Salta'],
  CO: [33, 'Antioquia'],
  MX: [32, 'Chiapas'],
  KR: [17, 'Seoul'],
  JP: [47, 'Tokyo'],
};

test('各支持国家按核对过的地区数轮换一圈，每条补搜均保留原获客国家', () => {
  assert.deepEqual(
    acquisitionMarkets.map(({ value }) => countryFor(value).code).sort(),
    Object.keys(expected).sort(),
  );
  const pairs = [];
  for (const { value: country } of acquisitionMarkets) {
    const [count, knownRegion] = expected[countryFor(country).code];
    const query = 'blinds supplier ' + country;
    const job = {
      input: { country, query_mode: 'auto' },
      searchStats: [{ status: 'completed', query, duplicates: 1, inserted: 0 }],
    };
    const regions = [];
    for (let cursor = 1; cursor <= count + 1; cursor++) {
      const search = regionalSearchAfter({ ...job, cursor });
      assert.equal(search?.country, country);
      assert.equal(search.query, query + ' ' + search.searchRegion);
      regions.push(search.searchRegion);
    }
    assert.equal(regions.pop(), regions[0], country);
    assert.equal(new Set(regions).size, count, country);
    assert.ok(regions.includes(knownRegion), country);
    for (const region of regions) pairs.push(countryFor(country).code + '|' + region);
  }
  // Fingerprint of the complete verified country/name pairs, independent of rotation order.
  assert.equal(
    createHash('sha256').update(JSON.stringify(pairs.sort())).digest('hex'),
    '5b47a60fd8e00f569d83605a68cbf5bdcfe8946a558a00f37e5729ba7cdf35c4',
  );
});
