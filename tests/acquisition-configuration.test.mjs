import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTarget } from '../server/search-target.mjs';
import { builtinProducts, MAX_SELECTED_PRODUCTS } from '../src/domain/acquisition-products.mjs';
import { ProductCatalog } from '../server/product-catalog.mjs';
import { parseCompanyResearch } from '../server/company-research.mjs';
import { automaticSearchPlan, MAX_AUTO_SEARCH_QUERIES } from '../src/domain/search-query.mjs';

const selectedProduct = {
  value: 'motorized roller blinds',
  label: '电动卷帘',
  direction: 'finished',
  group: '室内成品',
  aliases: ['electric roller shades'],
};

test('结构化产品、角色和条件经过校验，并由同一快照生成搜索词', () => {
  const target = validateTarget({
    query_mode: 'auto',
    products: [selectedProduct],
    customer_types: ['supplier', 'distributor'],
    preferred_requirements: '优先有酒店工程经验',
    required_requirements: ['必须是经营企业'],
    country: 'United States',
    region: 'Texas',
    product: '由结构化产品覆盖',
    audience: 'BC',
    acquisition_channel: 'tavily_web',
  });
  assert.equal(target.product, selectedProduct.value);
  assert.deepEqual(target.customer_types, ['supplier', 'distributor']);
  assert.equal(target.customer_type, '');
  assert.equal(target.customer_profile, 'all');
  const queries = automaticSearchPlan(target);
  assert.ok(queries.some(({ query }) => query.includes('"motorized roller blinds"')));
  assert.ok(queries.some(({ query }) => query.includes('"electric roller shades"')));
  assert.ok(
    queries.every(({ query }) => query.includes('Texas') && query.includes('United States')),
  );
});

test('室内和室外成品可以同时全选并提交', () => {
  const finishedProducts = builtinProducts.filter((product) => product.direction === 'finished');
  assert.equal(finishedProducts.length, 30);
  const target = validateTarget({
    query_mode: 'auto',
    products: finishedProducts,
    customer_types: [],
    country: 'United States',
    region: '',
    product: '',
    audience: 'BC',
    acquisition_channel: 'tavily_web',
  });
  assert.equal(target.products.length, 30);
  assert.equal(target.product.split(', ').length, 30);
});

test('产品数量仍受任务上限保护', () => {
  const products = Array.from({ length: MAX_SELECTED_PRODUCTS + 1 }, (_, index) => ({
    ...selectedProduct,
    value: `product ${index + 1}`,
  }));
  assert.throws(
    () =>
      validateTarget({
        products,
        country: 'United States',
        region: '',
        product: '',
        audience: 'BC',
        acquisition_channel: 'tavily_web',
      }),
    /1–40个产品/,
  );
});

test('大型组合按执行上限均匀生成搜索计划', () => {
  const countries = Array.from({ length: 30 }, (_, index) => `Market ${index + 1}`);
  const products = Array.from({ length: 12 }, (_, index) => ({
    ...selectedProduct,
    value: `product ${index + 1}`,
    label: `产品 ${index + 1}`,
    aliases: Array.from({ length: 5 }, (__, alias) => `product ${index + 1} alias ${alias + 1}`),
  }));
  const queries = automaticSearchPlan(
    {
      products,
      customer_types: [
        'supplier',
        'wholesaler',
        'distributor',
        'importer',
        'trader',
        'brand',
        'retailer',
        'contractor',
        'manufacturer',
        'service_provider',
      ],
      country: countries[0],
      region: '',
      audience: 'BC',
    },
    countries,
  );
  assert.equal(queries.length, MAX_AUTO_SEARCH_QUERIES);
  assert.ok(new Set(queries.map((item) => item.country)).size > 20);
  assert.ok(new Set(queries.map((item) => item.query.match(/product \d+/)?.[0])).size > 8);
});

test('常用产品持久保存，任务使用的产品快照不会随目录对象变化', () => {
  const folder = mkdtempSync(join(tmpdir(), 'product-catalog-'));
  const path = join(folder, 'products.sqlite');
  try {
    let catalog = new ProductCatalog(path);
    const saved = catalog.save(selectedProduct);
    const taskSnapshot = structuredClone(saved);
    saved.label = '页面局部修改';
    catalog.close();
    catalog = new ProductCatalog(path);
    const restored = catalog.list().find((product) => product.id === taskSnapshot.id);
    assert.equal(restored.label, '电动卷帘');
    assert.deepEqual(taskSnapshot.aliases, ['electric roller shades']);
    assert.equal(catalog.save(selectedProduct).id, taskSnapshot.id);
    catalog.close();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

const sourceUrl = 'https://example.com/about';
const sourceText =
  'Example Blinds is a distributor of roller blinds for commercial projects across Texas.';
const evidence = (value, quote = sourceText) => ({ value, quote, source_url: sourceUrl });
const response = (requirementChecks) => ({
  choices: [
    {
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          assessment_opportunities: [],
          company_name: evidence('Example Blinds'),
          entity_type: evidence('business'),
          production_model: evidence('unknown'),
          operating_model: evidence('beyond_local'),
          manufactured_products: [],
          actual_country: evidence('United States'),
          customer_type: evidence('distributor'),
          customer_types: [evidence('distributor')],
          preference_evidence: [],
          requirement_checks: requirementChecks,
          audience: evidence('B'),
          main_product_preference: evidence('主营卷帘'),
          industry_profile: evidence('窗饰经销企业'),
          demand_products: [],
          profile_tags: [evidence('trade')],
          products: [evidence('roller blinds')],
          service_areas: [evidence('Texas')],
          address: null,
        }),
      },
    },
  ],
});
const page = {
  source_url: sourceUrl,
  page_text: sourceText,
  research_pages: [{ source_url: sourceUrl, text: sourceText }],
};
const target = {
  query_mode: 'auto',
  product: 'roller blinds',
  country: 'United States',
  audience: 'BC',
  customer_types: ['importer', 'distributor'],
  preferred_requirements: '优先有酒店项目',
  required_requirements: ['必须承接商用项目'],
};

test('多角色按任意命中；优先偏好缺证不排除，必需条件未知进入待核实', () => {
  const research = parseCompanyResearch(
    response([
      {
        condition: '必须承接商用项目',
        verdict: 'unknown',
        quote: '',
        source_url: '',
      },
    ]),
    page,
    target,
  );
  assert.equal(research.customer_type_match, 'matched');
  assert.deepEqual(research.preference_evidence, []);
  assert.equal(research.required_match, 'unknown');
  assert.equal(research.review_required, true);
  assert.match(research.reason, /待核实/);
});

test('必需条件只有取得明确反证才排除', () => {
  const contradiction = 'Example Blinds only serves residential homes.';
  const fullText = sourceText + ' ' + contradiction;
  const research = parseCompanyResearch(
    response([
      {
        condition: '必须承接商用项目',
        verdict: 'not_matched',
        quote: contradiction,
        source_url: sourceUrl,
      },
    ]),
    { ...page, page_text: fullText, research_pages: [{ source_url: sourceUrl, text: fullText }] },
    target,
  );
  assert.equal(research.required_match, 'not_matched');
  assert.equal(research.review_required, false);
  assert.match(research.reason, /不符合必需条件/);
});
