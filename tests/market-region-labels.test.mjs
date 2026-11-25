import test from 'node:test';
import assert from 'node:assert/strict';
import geography from '../server/data/geography.json' with { type: 'json' };
import { marketRegions } from '../server/market-regions.mjs';

test('英国提供十二个互不重复的一级市场地区，全部带中文标签', () => {
  const regions = marketRegions['United Kingdom'];
  assert.equal(regions.length, 12);
  assert.equal(new Set(regions.map(({ name }) => name)).size, 12);
  assert.equal(new Set(regions.map(({ code }) => code)).size, 12);
  assert.ok(regions.every(({ label }) => /[\u4e00-\u9fff]/.test(label)));
  assert.deepEqual(
    regions.map(({ code }) => code),
    ['TLC', 'TLD', 'TLE', 'TLF', 'TLG', 'TLH', 'TLI', 'TLJ', 'TLK', 'TLL', 'TLM', 'TLN'],
  );
  for (const name of ['London', 'Scotland', 'Wales', 'Northern Ireland'])
    assert.ok(regions.some((region) => region.name === name));
  assert.equal(
    regions.some(({ name }) => name === 'England'),
    false,
  );
});

test('美国与澳大利亚补全中文显示名，原有地区名称和代码保持兼容', () => {
  for (const [country, count] of [
    ['United States', 51],
    ['Australia', 8],
  ]) {
    const regions = marketRegions[country];
    assert.equal(regions.length, count);
    assert.deepEqual(
      regions.map(({ name, code }) => ({ name, code })),
      geography[country].map(({ name, code }) => ({ name, code })),
    );
    assert.ok(
      regions.every(({ label }) => typeof label === 'string' && /[\u4e00-\u9fff]/.test(label)),
    );
    assert.ok(regions.every((region) => !Object.hasOwn(region, 'cities')));
  }
});
