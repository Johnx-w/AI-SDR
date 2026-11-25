import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countries,
  countryFilters,
  acquisitionMarkets,
  countryFor,
} from '../src/domain/country-catalog.ts';
import { validateTarget } from '../server/search-target.mjs';
import { searchPlan } from '../server/search-plan.mjs';
import { countryMatches } from '../server/relevance.mjs';
import { LeadLibrary } from '../server/lead-library.mjs';
test('全球单选目录使用中英文名、代码和 GDP 排序，迪拜仅在获客范围中独立列出', () => {
  assert.equal(countryFilters[0].label, '全部国家');
  assert.deepEqual(
    countries.slice(0, 3).map((c) => c.code),
    ['US', 'CN', 'DE'],
  );
  for (const code of 'SG MY NZ TH VN AE ZA GH PH PL NL DE IT BE BR CL AR CO MX KR JP'.split(' ')) {
    const c = countryFor(code);
    assert.equal(countryFor(c.zh).name, c.name);
    assert.equal(countryMatches(c.iso3, [c.name]), 'matched');
    assert.deepEqual(validateTarget({ country: c.name, product_scope: 'all' }).market_countries, [
      c.name,
    ]);
  }
  assert.ok(acquisitionMarkets.some((x) => x.value === 'Dubai'));
  assert.equal(countryFor('迪拜').code, 'AE');
  const t = validateTarget({ country: 'Dubai', product_scope: 'all' });
  assert.deepEqual(t.market_countries, ['United Arab Emirates']);
  assert.ok(
    searchPlan(t).every((q) => q.country === 'United Arab Emirates' && q.query.includes('Dubai')),
  );
});
test('国家、双语州名及待核实在分页和导出时使用相同筛选', () => {
  const library = new LeadLibrary({
    readLeads() {
      throw Error('本地筛选不应访问外部服务');
    },
  });
  try {
    for (let i = 0; i < 12; i++)
      library.upsert({
        id: 'lead' + i,
        name: 'Shade ' + i,
        facts: [],
        contactEvidence: [],
        fields: {},
        market: i === 11 ? '日本' : '美国',
        region: i === 10 ? '' : i === 11 ? 'JP-13 · Tokyo' : i % 2 ? 'CA · Oakland' : 'California',
        grade: 'A',
        status: '待开发',
      });
    const query = new URLSearchParams({
      market: '美国',
      region: '加利福尼亚州.California',
      page: '2',
    });
    const page = library.page(query, (x) => x);
    assert.equal(page.filteredTotal, 10);
    assert.equal(page.leads.length, 2);
    assert.equal(library.page(query, (x) => x, { exportDetails: true }).leads.length, 10);
    assert.ok(
      page.facets.regions.indexOf('阿拉巴马州.Alabama') <
        page.facets.regions.indexOf('加利福尼亚州.California'),
    );
    assert.equal(
      library.page(new URLSearchParams({ region: '待核实' }), (x) => x).filteredTotal,
      1,
    );
    assert.ok(
      library
        .page(new URLSearchParams({ market: '日本' }), (x) => x)
        .leads[0].regionLabel.endsWith('.Tokyo'),
    );
  } finally {
    library.close();
  }
});
