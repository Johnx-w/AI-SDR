import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifiedAssessmentOpportunities } from '../server/assessment-evidence.mjs';
import { assessCompany } from '../server/customer-assessment.mjs';

const real = JSON.parse(
  readFileSync(
    new URL('./fixtures/finished-retailer-material-opportunity-20261024.json', import.meta.url),
    'utf8',
  ),
);
const source = 'https://materials.example.org/';
const fact = (kind, quote, source_url = source, value = kind) => ({
  kind,
  value,
  quote,
  source_url,
});
const catalog = (value, quote, source_url = source) => ({
  field: 'products',
  value,
  quote,
  source_url,
});
const evaluate = (opportunities) =>
  assessCompany({
    research: {
      company_name: 'Fixture Business',
      entity_type: 'business',
      source_url: source,
      assessment_opportunities: opportunities,
    },
    target: { product: 'roller blind fabric' },
    id: 'fixture-assessment',
    at: Date.parse('2026-10-24T00:00:00Z'),
  });

test('真实零售卷帘机会贴materials标签不能用成品定制和消费者结账计材料A类', () => {
  const facts = real.opportunity.facts.map((entry) => ({ ...entry, source_url: real.source_url }));
  const quote = facts.map((entry) => entry.quote).join('\n');
  const products = [catalog(real.product, facts[0].quote, real.source_url)];
  const opportunities = verifiedAssessmentOpportunities(
    [{ ...real.opportunity, facts }],
    [{ source_url: real.source_url, text: quote }],
    real.target,
    [real.product],
    products,
  );
  assert.deepEqual(opportunities, []);
  assert.equal(evaluate(opportunities).grade, 'C');
});

test('specific也核对每个计分引文方向，不把成品供货定制电动和结账挪给真实面料副线', () => {
  const material = 'We distribute roller blind fabrics by the roll to local manufacturers.';
  const finished =
    'We specialize in custom roller blinds. Choose fabrics and motors for your roller blinds and checkout online.';
  const opportunities = verifiedAssessmentOpportunities(
    [
      {
        direction: 'materials',
        product: 'roller blind fabrics',
        facts: [
          fact('core_product', material),
          fact('specialist_supply', finished),
          fact('current_supply_process', finished),
          fact('custom_made', finished),
          fact('motorized_system', finished),
        ],
      },
    ],
    [{ source_url: source, text: material + ' ' + finished }],
    { product_scope: 'specific', product: 'roller blind fabrics' },
    ['roller blind fabrics'],
    [catalog('roller blind fabrics', material)],
  );
  assert.equal(opportunities.length, 1);
  assert.deepEqual(
    opportunities[0].facts.map((entry) => entry.kind),
    ['core_product'],
  );
  assert.equal(evaluate(opportunities).grade, 'B');
  assert.equal(evaluate(opportunities).dimensions.R.score, null);
});

test('面料目标保留真实成品经营初评，材料采购标为待沟通机会', () => {
  const quote = 'We sell finished roller blinds to homeowners.';
  const opportunities = verifiedAssessmentOpportunities(
    [
      {
        direction: 'finished',
        product: 'roller blinds',
        facts: [fact('core_product', quote), fact('specialist_supply', quote)],
      },
    ],
    [{ source_url: source, text: quote }],
    { product_scope: 'specific', product: 'roller blind fabric' },
    ['roller blinds'],
    [catalog('roller blinds', quote)],
  );
  assert.equal(opportunities.length, 1);
  assert.equal(opportunities[0].direction, 'finished');
  assert.equal(opportunities[0].relationship, 'potential_input');
  const result = evaluate(opportunities);
  assert.equal(result.grade, 'A');
  assert.equal(result.dimensions.D.score, null);
  assert.equal(result.supplyOpportunity.procurementStatus, 'unconfirmed');
  assert.match(result.reason, /材料或配件采购方式、规格、数量与负责人待沟通/);
});

test('只有已核实卷帘产品线时仍可常规开发，错误材料标签不成为材料采购事实', () => {
  const quote = 'We sell finished roller blinds to homeowners.';
  const result = assessCompany({
    research: {
      company_name: 'Fixture Business',
      source_url: source,
      entity_type: 'business',
      products: ['roller blinds'],
      facts: [catalog('roller blinds', quote)],
      assessment_opportunities: [],
    },
    target: { product: 'roller blind fabric' },
    id: 'fixture-catalog-assessment',
  });
  assert.equal(result.grade, 'B');
  assert.equal(result.status, '可开发');
  assert.equal(result.direction, 'finished');
  assert.equal(result.product, 'roller blinds');
  assert.equal(result.supplyOpportunity.procurementStatus, 'unconfirmed');
  assert.equal(result.dimensions.R.score, null, '产品目录不自动证明供货角色');
});

test('真正的面料分销可计材料机会，不要求公开采购需求', () => {
  const quote =
    'We specialize in distributing roller blind fabrics by the roll to blind manufacturers. Order roller blind fabrics directly from our warehouse.';
  const opportunities = verifiedAssessmentOpportunities(
    [
      {
        direction: 'materials',
        product: 'roller blind fabrics',
        facts: [
          fact('core_product', quote),
          fact('specialist_supply', quote),
          fact('current_supply_process', quote),
        ],
      },
    ],
    [{ source_url: source, text: quote }],
    { product_scope: 'specific', product: 'roller blind fabric' },
    ['roller blind fabrics'],
    [catalog('roller blind fabrics', quote)],
  );
  assert.equal(opportunities.length, 1);
  assert.equal(evaluate(opportunities).grade, 'A');
});

test('明确自有制造及同产品用料可支持材料适配，不能要求官网出售该材料或已公开求购', () => {
  const quote = 'We manufacture roller blinds in our own factory using roller blind fabrics.';
  const opportunities = verifiedAssessmentOpportunities(
    [
      {
        direction: 'materials',
        product: 'roller blind fabrics',
        facts: [
          fact('core_product', quote),
          fact('specialist_supply', quote),
          fact('current_supply_process', quote),
        ],
      },
    ],
    [{ source_url: source, text: quote }],
    { product_scope: 'specific', product: 'roller blind fabric' },
    ['roller blinds'],
    [catalog('roller blinds', quote)],
  );
  assert.equal(opportunities.length, 1);
  assert.equal(evaluate(opportunities).grade, 'A');
});

test('合作工厂制造成品不能据此推断零售商自身进行材料生产采购', () => {
  const quote =
    'Our roller blinds are manufactured by partner factories using roller blind fabrics.';
  const opportunities = verifiedAssessmentOpportunities(
    [
      {
        direction: 'materials',
        product: 'roller blind fabrics',
        facts: [fact('core_product', quote), fact('specialist_supply', quote)],
      },
    ],
    [{ source_url: source, text: quote }],
    { product_scope: 'specific', product: 'roller blind fabric' },
    ['roller blinds'],
    [catalog('roller blinds', quote)],
  );
  assert.deepEqual(opportunities, []);
});

test('复合产品标题的主营事实可用完整主标题原文核实，泛化渠道话术仍不算角色', () => {
  const product =
    'Custom Blinds & Shades (Faux Wood, Cellular, Roller, Solar, Roman, Vertical, Woven Wood)';
  const core =
    'Custom blinds and shades experts since 1993, Factory Direct Blinds is an online window treatment retailer for residential customers and trade professionals.';
  const role = 'we transitioned from traditional roots to an online direct-to-consumer model';
  const opportunities = verifiedAssessmentOpportunities(
    [
      {
        direction: 'finished',
        product,
        facts: [fact('core_product', core), fact('specialist_supply', role)],
      },
    ],
    [{ source_url: source, text: `${core} Roller Shades ${role}` }],
    { product_scope: 'all' },
    ['Roller Shades'],
    [catalog('Roller Shades', 'Roller Shades')],
  );
  assert.deepEqual(
    opportunities[0]?.facts.map((entry) => entry.kind),
    ['core_product'],
  );
});

test('并列产品标题可用已独立核实的同方向具体产品，仍核对来源与方向', () => {
  const quote = 'Welcome to Shadetex Australia - Wholesale Manufacturer of Outdoor Blinds';
  const product = 'Outdoor Blinds & Awnings';
  const raw = [{ direction: 'finished', product, facts: [fact('core_product', quote)] }];
  const products = [catalog('Awnings', 'Awnings'), catalog('Outdoor Blinds', 'Outdoor Blinds')];
  const pages = [{ source_url: source, text: `${quote} Outdoor Blinds Awnings` }];
  const args = [
    raw,
    pages,
    { product_scope: 'all' },
    products.map((entry) => entry.value),
    products,
  ];
  assert.deepEqual(
    verifiedAssessmentOpportunities(...args)[0]?.facts.map((entry) => entry.kind),
    ['core_product'],
  );
  assert.deepEqual(
    verifiedAssessmentOpportunities(
      [
        {
          direction: 'materials',
          product: 'Outdoor Blind Fabrics',
          facts: [fact('core_product', quote)],
        },
      ],
      pages,
      { product_scope: 'all' },
      ['Outdoor Blind Fabrics'],
      [catalog('Outdoor Blind Fabrics', 'Outdoor Blind Fabrics')],
    )[0]?.facts,
    [],
  );
  assert.deepEqual(
    verifiedAssessmentOpportunities(
      [
        {
          direction: 'finished',
          product,
          facts: [fact('core_product', quote, 'https://wrong.example/')],
        },
      ],
      pages,
      { product_scope: 'all' },
      products.map((entry) => entry.value),
      products,
    )[0]?.facts,
    [],
  );
  assert.deepEqual(
    verifiedAssessmentOpportunities(
      [
        {
          direction: 'finished',
          product,
          facts: [fact('core_product', 'We manufacture Indoor Blinds')],
        },
      ],
      [{ source_url: source, text: 'Awnings Outdoor Blinds We manufacture Indoor Blinds' }],
      { product_scope: 'all' },
      ['Awnings', 'Outdoor Blinds', 'Indoor Blinds'],
      [...products, catalog('Indoor Blinds', 'Indoor Blinds')],
    )[0]?.facts,
    [],
  );
});

test('泛称窗口业务引文不凭单个 Blinds 目录词变成复合主营证据', () => {
  const quote = 'We offer a variety of custom window treatments, including:';
  const product = 'Custom blinds, shades, shutters, drapes and curtains';
  const result = verifiedAssessmentOpportunities(
    [{ direction: 'finished', product, facts: [fact('core_product', quote)] }],
    [{ source_url: source, text: `${quote} Blinds Shades Shutters` }],
    { product_scope: 'all' },
    ['Blinds', 'Shades', 'Shutters'],
    [catalog('Blinds', 'Blinds'), catalog('Shades', 'Shades'), catalog('Shutters', 'Shutters')],
  );
  assert.deepEqual(
    result.flatMap((entry) => entry.facts),
    [],
  );
});

test('泛窗饰供货角色须有同页具体产品，其他产品或服务话术不能借用', () => {
  const product = 'Roller Shades';
  const catalogQuote = 'Explore our Roller Shades.';
  const retailer = 'Largest online retailer of custom window treatments';
  const unrelated = 'We sell Roman Shades';
  const service = 'We do it all for you: design, measure, & install.';
  const productNoun = 'Comprehensive line of window covering products.';
  const wholesaleSlogan = 'Kickstart Your Shades & Blinds Wholesale Journey Today';
  const pages = [
    {
      source_url: source,
      text: `${catalogQuote} ${retailer} ${unrelated} ${service} ${productNoun} ${wholesaleSlogan}`,
    },
  ];
  const raw = [
    {
      direction: 'finished',
      product,
      facts: [retailer, unrelated, service, productNoun, wholesaleSlogan].map((quote) =>
        fact('specialist_supply', quote),
      ),
    },
  ];
  const verified = [catalog(product, catalogQuote)];
  const result = verifiedAssessmentOpportunities(
    raw,
    pages,
    { product_scope: 'all' },
    [product],
    verified,
  );
  assert.deepEqual(
    result[0]?.facts.map((entry) => entry.quote),
    [retailer],
  );
  assert.deepEqual(
    verifiedAssessmentOpportunities(
      raw,
      pages,
      { product_scope: 'all' },
      [product],
      [catalog(product, catalogQuote, 'https://other.example/')],
    )[0]?.facts,
    [],
  );
});

test('材料方向的泛窗饰供应角色只可用同页材料目录证明', () => {
  const role = 'We are a supplier of fabrics and components for the window treatment industry.';
  const material = 'Roller Shade Fabrics';
  const finished = 'Roller Shades';
  const opportunities = verifiedAssessmentOpportunities(
    [
      {
        direction: 'materials',
        product: material,
        facts: [fact('specialist_supply', role)],
      },
      {
        direction: 'finished',
        product: finished,
        facts: [fact('specialist_supply', role)],
      },
    ],
    [{ source_url: source, text: `${material} ${finished} ${role}` }],
    { product_scope: 'all' },
    [material, finished],
    [catalog(material, material), catalog(finished, finished)],
  );
  assert.deepEqual(
    opportunities.map((entry) => entry.facts.map((item) => item.kind)),
    [['specialist_supply'], []],
  );
});
