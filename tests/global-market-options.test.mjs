import test from 'node:test';
import assert from 'node:assert/strict';
import { countryFilters, acquisitionMarkets, countryFor } from '../src/domain/country-catalog.ts';
import { validateTarget } from '../server/search-target.mjs';
import { searchPlan } from '../server/search-plan.mjs';
import { countryMatches } from '../server/relevance.mjs';
import { LeadLibrary } from '../server/lead-library.mjs';
test('指定的 25 国单选目录使用中英文名、代码和 GDP 排序，城市别名只定位其所属国家', () => {
  assert.equal(countryFilters[0].label, '全部国家');
  assert.deepEqual(
    acquisitionMarkets.slice(0, 3).map((c) => countryFor(c.value).code),
    ['US', 'DE', 'JP'],
  );
  const codes = 'US AU CA GB SG MY NZ TH VN AE ZA GH PH PL NL DE IT BE BR CL AR CO MX KR JP'.split(
    ' ',
  );
  for (const code of codes) {
    const c = countryFor(code);
    assert.equal(countryFor(c.zh).name, c.name);
    assert.equal(countryMatches(c.iso3, [c.name]), 'matched');
    assert.deepEqual(validateTarget({ country: c.name, product_scope: 'all' }).market_countries, [
      c.name,
    ]);
  }
  assert.deepEqual(
    acquisitionMarkets.map((item) => countryFor(item.value).code).sort(),
    codes.sort(),
  );
  assert.deepEqual(
    countryFilters.slice(1, -1).map((item) => item.label),
    acquisitionMarkets.map((item) => item.label),
  );
  assert.ok(
    acquisitionMarkets.some(
      (option) => option.value === 'South Korea' && option.label === '韩国.South Korea',
    ),
  );
  assert.equal(countryFor('迪拜').code, 'AE');
  const uae = acquisitionMarkets.find((item) => item.value === 'United Arab Emirates');
  assert.match(uae.keywords, /迪拜/);
  assert.ok(
    searchPlan(validateTarget({ country: uae.value, product_scope: 'all' })).every(
      (q) => q.country === uae.value && !q.query.includes('Dubai'),
    ),
  );
  for (const scope of [
    { country: 'Europe' },
    { country: 'France' },
    { country: 'Dubai' },
    { country: 'United States', region: 'Texas' },
    { country: 'Canada', market_countries: ['Canada', 'Japan'] },
    { country: 'Canada', target_markets: ['Japan'] },
  ]) {
    assert.throws(() => validateTarget({ ...scope, product_scope: 'all' }), { status: 400 });
    assert.throws(() => searchPlan({ ...scope, product_scope: 'all' }), { status: 400 });
  }
  assert.equal(countryMatches('Turkey', ['Türkiye']), 'matched');
  assert.equal(countryMatches('Europe', ['France']), 'unknown');
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
    assert.deepEqual(
      page.facets.regions.filter((label) => label.endsWith('.Alabama')),
      ['阿拉巴马州.Alabama'],
    );
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

test('旧州名缓存重新归类后可按新译名筛选及导出，同时可搜索旧译名', () => {
  const library = new LeadLibrary({
    readLeads() {
      throw Error('unexpected refresh');
    },
  });
  try {
    library.upsert({
      id: 'old-alabama',
      name: 'Alabama Shades',
      facts: [],
      contactEvidence: [],
      fields: {},
      market: '美国',
      region: '亚拉巴马州',
      grade: 'A',
      status: '待开发',
    });
    library.db.exec(
      "UPDATE lead_library_customers SET summary=json_remove(json_set(summary,'$.regionLabel','亚拉巴马州.Alabama'),'$.regionLabelVersion')",
    );
    library.migrateVersions();
    const query = new URLSearchParams({ market: '美国', region: '阿拉巴马州.Alabama' });
    const page = library.page(query, (x) => x);
    assert.equal(page.filteredTotal, 1);
    assert.equal(library.page(query, (x) => x, { exportDetails: true }).leads.length, 1);
    assert.match(page.facets.regionKeywords['阿拉巴马州.Alabama'], /亚拉巴马州/);
  } finally {
    library.close();
  }
});
