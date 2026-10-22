import test from 'node:test';
import assert from 'node:assert/strict';
import geography from '../server/data/geography.json' with { type: 'json' };
import { locationOptions, validateTarget } from '../server/search-target.mjs';
import { searchPlan } from '../server/search-plan.mjs';

test('英国提供十二个互不重复的一级市场地区，全部带中文标签', () => {
  const { regions } = locationOptions('United Kingdom');
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
    const { regions } = locationOptions(country);
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
  assert.equal(locationOptions('United States', 'Texas').region, 'Texas');
  assert.equal(locationOptions('Australia', 'New South Wales').region, 'New South Wales');
});

test('地区校验接受英文市场地区，拒绝城市、跨国家地区及中文显示标签', () => {
  for (const region of ['London', 'North East (England)', 'Scotland', 'Northern Ireland'])
    assert.equal(locationOptions('United Kingdom', region).region, region);
  for (const region of ['Manchester', 'England', 'Texas', '伦敦地区'])
    assert.throws(() => locationOptions('United Kingdom', region), { status: 400 });
  assert.throws(() => locationOptions('Australia', 'London'), { status: 400 });
  assert.throws(() => locationOptions('United States', 'Scotland'), { status: 400 });
});

test('英国地区进入真实搜索词时保留英文值，中文标签只用于展示', () => {
  const target = validateTarget({ country: 'United Kingdom', region: 'Scotland' });
  const queries = searchPlan(target);
  assert.ok(queries.length > 0);
  assert.ok(
    queries.every(({ query }) => query.includes('Scotland') && query.includes('United Kingdom')),
  );
  assert.ok(queries.every(({ query }) => !query.includes('苏格兰')));
});
