import test from 'node:test';
import assert from 'node:assert/strict';
import {
  automaticSearchPlan,
  buildSearchQuery,
  MAX_AUTO_SEARCH_QUERIES,
} from '../src/domain/search-query.mjs';
import { searchPlan } from '../server/search-plan.mjs';

const allProducts = {
  product_scope: 'all',
  product: 'window coverings',
  products: [],
  country: 'United States',
  region: '',
  audience: 'BC',
  customer_types: [],
};
const indoor =
  /"(?:roller blinds|curtains|venetian blinds|cellular shades|roman shades|vertical blinds|plantation shutters)"/;
const outdoor = /"(?:outdoor blinds|awnings|zip screens|pergolas|outdoor shading)"/;
const semifinished =
  /"(?:semi finished blinds|blinds fabric|curtain fabric|blind profiles|blind slats)"/;
const components =
  /"(?:blind components|curtain hardware|blind motors|awning components|shutter components|curtain tracks)"/;

test('全范围搜索在短轮次内交替覆盖室内、室外、半成品及零件', () => {
  const queries = automaticSearchPlan(allProducts);
  const initial = queries
    .slice(0, 5)
    .map(({ query }) => query)
    .join('\n');
  assert.match(initial, /"window coverings"/);
  for (const pattern of [indoor, outdoor, semifinished, components]) assert.match(initial, pattern);
  assert.ok(queries.slice(0, 5).every(({ query }) => /\bsupplier\b/.test(query)));
  assert.doesNotMatch(queries.map(({ query }) => query).join('\n'), /sample books|display kits/);
  assert.equal(new Set(queries.map(({ query }) => query)).size, queries.length);
});

test('室内外偏好增加早期覆盖，仍保留另一方向与材料零件', () => {
  for (const preference of ['indoor', 'outdoor']) {
    const queries = automaticSearchPlan({ ...allProducts, environment_preference: preference });
    const initial = queries.slice(0, 24).map(({ query }) => query);
    const preferred = preference === 'indoor' ? indoor : outdoor;
    const other = preference === 'indoor' ? outdoor : indoor;
    assert.ok(
      initial.filter((query) => preferred.test(query)).length >
        initial.filter((query) => other.test(query)).length,
    );
    for (const pattern of [other, semifinished, components])
      assert.ok(initial.some((query) => pattern.test(query)));
  }
});

test('全范围多市场查询保留搜索上限，同时覆盖各供货方向及市场', () => {
  const countries = Array.from({ length: 30 }, (_, index) => `Market ${index + 1}`);
  const queries = automaticSearchPlan({ ...allProducts, country: countries[0] }, countries);
  assert.equal(queries.length, MAX_AUTO_SEARCH_QUERIES);
  assert.equal(new Set(queries.map(({ country }) => country)).size, countries.length);
  const initial = queries
    .slice(0, 20)
    .map(({ query }) => query)
    .join('\n');
  for (const pattern of [indoor, outdoor, semifinished, components]) assert.match(initial, pattern);
});

test('全范围通过服务端和预览生成同一计划，不依赖显式自动模式', () => {
  assert.deepEqual(searchPlan(allProducts), automaticSearchPlan(allProducts));
  assert.equal(buildSearchQuery(allProducts), automaticSearchPlan(allProducts)[0].query);
});

test('指定产品保留精确产品与别名、角色、地区，旧任务保持原查询', () => {
  const input = {
    ...allProducts,
    product_scope: 'specific',
    query_mode: 'auto',
    environment_preference: 'outdoor',
    customer_types: ['distributor'],
    region: 'Texas',
    products: [{ value: 'cellular blinds', aliases: ['honeycomb shades'] }],
    product: 'cellular blinds',
  };
  const queries = automaticSearchPlan(input);
  assert.ok(queries.some(({ query }) => query.includes('"cellular blinds"')));
  assert.ok(queries.some(({ query }) => query.includes('"honeycomb shades"')));
  assert.ok(
    queries.every(
      ({ query }) =>
        query.includes('distributor dealer') && query.includes('Texas') && !outdoor.test(query),
    ),
  );
  const legacy = {
    country: 'United States',
    product: 'Roman blinds',
    region: '',
    audience: 'BC',
    search_query: 'custom legacy search',
  };
  assert.equal(searchPlan(legacy)[0].query, legacy.search_query);
});
