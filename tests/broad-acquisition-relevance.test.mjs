import test from 'node:test';
import assert from 'node:assert/strict';
import { pageRelevance, productsRelevant, windowProductDirections } from '../server/relevance.mjs';
import { verifiedAssessmentOpportunities } from '../server/assessment-evidence.mjs';
import { companyResearchRequest, parseCompanyResearch } from '../server/company-research.mjs';
import { assessCompany } from '../server/customer-assessment.mjs';

const broad = {
  product_scope: 'all',
  product: 'window coverings',
  environment_preference: 'indoor',
  query_mode: 'auto',
  country: 'Australia',
  market_countries: ['Australia'],
  audience: 'BC',
};
const source = 'https://example-window.example/about';
const evidence = (value, quote) => ({ value, quote, source_url: source });
const fact = (kind, quote, value = quote) => ({ kind, ...evidence(value, quote) });

test('全窗饰范围接受泛称、跨环境成品以及专用材料半成品', () => {
  for (const product of [
    'window coverings',
    'window furnishings',
    'blinds',
    'shades',
    'curtains',
    'outdoor zip screens',
    'semi-finished roller blinds',
    'semi-finished blind',
    'semi-finished curtain',
    'curtain fabrics',
    'roller blind motors',
    'curtain tracks',
    '窗帘半成品',
    '户外遮阳篷配件',
    'hospital window curtains',
  ])
    assert.equal(productsRelevant([product], broad), 'matched', product);
  assert.equal(productsRelevant([], broad), 'unknown');
});

test('行业泛称不能接纳通用零件、无关帘屏或独立样本展示业务', () => {
  for (const product of ['screens', 'motors', 'fabric', 'hardware'])
    assert.equal(productsRelevant([product], broad), 'unknown', product);
  assert.notEqual(productsRelevant(['motors', 'blinds fabric sample books'], broad), 'matched');
  for (const product of [
    'shower curtains',
    'medical curtains',
    'hospital cubicle curtains',
    'vehicle awnings',
    'car window shades',
    'camera shutters',
    'lamp shades',
    'screen printing',
    'blinds fabric sample books',
    'blinds display kits',
  ])
    assert.equal(productsRelevant([product], broad), 'not_matched', product);
  assert.equal(
    productsRelevant(['blinds fabric sample books'], { product: 'blinds fabric sample books' }),
    'matched',
  );
});

test('广泛发现允许泛称官网并保留指定细品类的严格行为', () => {
  const text =
    'Example Window Co supplies window furnishings and offers free fabric samples to trade customers across Australia, with ordering and delivery support.';
  assert.equal(pageRelevance(text, broad).relevant, true);
  assert.equal(
    pageRelevance(
      'We produce medical curtains and hospital cubicle curtains for care facilities. '.repeat(2),
      broad,
    ).relevant,
    false,
  );
  assert.equal(
    productsRelevant(['Roman blinds'], {
      product_scope: 'specific',
      product: 'outdoor zip screens',
    }),
    'not_matched',
  );
  assert.equal(
    productsRelevant(['awnings'], { product: 'full cassette folding arm awnings' }),
    'not_matched',
  );
});

test('全范围机会独立核对方向，成品证据不能伪造材料机会', () => {
  const finishedQuote = 'We manufacture roller blinds for our dealer network.';
  const materialsQuote = 'We supply roller blind motors and semi-finished roller blinds.';
  const pages = [{ source_url: source, text: finishedQuote + ' ' + materialsQuote }];
  const raw = [
    {
      direction: 'finished',
      product: 'roller blinds',
      facts: [fact('core_product', finishedQuote)],
    },
    {
      direction: 'materials',
      product: 'roller blind motors',
      facts: [fact('core_product', materialsQuote)],
    },
    {
      direction: 'materials',
      product: 'roller blinds',
      facts: [fact('core_product', finishedQuote)],
    },
  ];
  const independentFacts = [
    { field: 'products', ...evidence('roller blinds', finishedQuote) },
    { field: 'products', ...evidence('roller blind motors', materialsQuote) },
  ];
  const result = verifiedAssessmentOpportunities(
    raw,
    pages,
    {
      ...broad,
      products: [{ value: 'roller blinds', direction: 'finished' }],
    },
    independentFacts.map((item) => item.value),
    independentFacts,
  );
  assert.deepEqual(
    result.map((item) => [item.direction, item.product]),
    [
      ['finished', 'roller blinds'],
      ['materials', 'roller blind motors'],
    ],
  );
  const fabricatedFacts = [
    { field: 'products', ...evidence('roller blind motors', finishedQuote) },
  ];
  assert.deepEqual(
    verifiedAssessmentOpportunities(
      [raw[1]],
      pages,
      broad,
      ['roller blind motors'],
      fabricatedFacts,
    ),
    [],
  );
});

test('正常成品与材料引文提及样品不会被误当独立样本业务排除', () => {
  const finishedQuote = 'We supply made-to-measure roller blinds and offer free fabric samples.';
  const materialsQuote = 'We sell curtain fabric and sample books.';
  const independentFacts = [
    { field: 'products', ...evidence('roller blinds', finishedQuote) },
    { field: 'products', ...evidence('curtain fabric', materialsQuote) },
  ];
  const result = verifiedAssessmentOpportunities(
    [
      {
        direction: 'finished',
        product: 'roller blinds',
        facts: [fact('core_product', finishedQuote)],
      },
      {
        direction: 'materials',
        product: 'curtain fabric',
        facts: [fact('core_product', materialsQuote)],
      },
    ],
    [{ source_url: source, text: finishedQuote + ' ' + materialsQuote }],
    broad,
    independentFacts.map((item) => item.value),
    independentFacts,
  );
  assert.equal(result.length, 2);
  assert.ok(result.every((item) => item.facts.some((entry) => entry.kind === 'core_product')));
});

test('混合目录引文分别支持成品和材料，半成品与单独电机不冒充成品', () => {
  const quote = 'We supply roller blinds and roller blind motors to trade customers.';
  const independentFacts = [
    { field: 'products', ...evidence('roller blinds', quote) },
    { field: 'products', ...evidence('roller blind motors', quote) },
  ];
  const result = verifiedAssessmentOpportunities(
    [
      { direction: 'finished', product: 'roller blinds', facts: [fact('core_product', quote)] },
      {
        direction: 'materials',
        product: 'roller blind motors',
        facts: [fact('core_product', quote)],
      },
    ],
    [{ source_url: source, text: quote }],
    broad,
    independentFacts.map((item) => item.value),
    independentFacts,
  );
  assert.deepEqual(
    result.map((item) => item.direction),
    ['finished', 'materials'],
  );
  assert.ok(result.every((item) => item.facts.some((entry) => entry.kind === 'core_product')));
  for (const product of [
    'semi-finished roller blinds',
    'semi-finished blind',
    'semi-finished curtain',
    'roller blind motors',
    'components for roller blinds and curtains',
  ])
    assert.deepEqual(windowProductDirections(product), ['materials'], product);
  assert.deepEqual(
    windowProductDirections('We supply roller blinds and offer free curtain fabric samples.'),
    ['finished'],
  );
  const roles = verifiedAssessmentOpportunities(
    [
      {
        direction: 'materials',
        product: 'roller blind motors',
        facts: [
          fact('specialist_supply', 'We manufacture roller blinds.'),
          fact('general_supply', 'We supply roller blinds.'),
        ],
      },
    ],
    [
      {
        source_url: source,
        text: quote + ' We manufacture roller blinds. We supply roller blinds.',
      },
    ],
    broad,
    ['roller blind motors'],
    [independentFacts[1]],
  );
  assert.equal(roles.length, 1);
  assert.deepEqual(roles[0].facts, []);
});

test('官网经营目录可形成宽范围潜在机会，不能变成公开采购需求', () => {
  const finishedQuote =
    'Example Window Co is a specialist supplier of window coverings in Australia.';
  const processQuote =
    'We supply custom made window coverings with an ordering and delivery service.';
  const materialsQuote =
    'We supply semi-finished roller blinds and roller blind motors to trade customers.';
  const yearsQuote = 'Our company has operated for 8 years.';
  const page = {
    source_url: source,
    research_pages: [
      {
        source_url: source,
        text: [finishedQuote, processQuote, materialsQuote, yearsQuote].join(' '),
      },
    ],
  };
  const raw = {
    company_name: evidence('Example Window Co', finishedQuote),
    entity_type: evidence('business', finishedQuote),
    production_model: evidence('unknown', finishedQuote),
    operating_model: evidence('beyond_local', finishedQuote),
    actual_country: evidence('Australia', finishedQuote),
    customer_type: evidence('supplier', finishedQuote),
    customer_types: [evidence('supplier', finishedQuote)],
    products: [
      evidence('window coverings', finishedQuote),
      evidence('semi-finished roller blinds', materialsQuote),
      evidence('roller blind motors', materialsQuote),
    ],
    // A copied sales catalog lacks enterprise procurement language and is removed.
    demand_products: [evidence('roller blind motors', materialsQuote)],
    assessment_opportunities: [
      {
        direction: 'finished',
        product: 'window coverings',
        facts: [
          fact('core_product', finishedQuote),
          fact('specialist_supply', finishedQuote),
          fact('current_supply_process', processQuote),
          fact('company_years', yearsQuote, '8'),
        ],
      },
      {
        direction: 'materials',
        product: 'semi-finished roller blinds',
        facts: [fact('core_product', materialsQuote), fact('specialist_supply', materialsQuote)],
      },
    ],
  };
  const research = parseCompanyResearch(
    { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] },
    page,
    broad,
  );
  assert.equal(research.product_match, 'matched');
  assert.deepEqual(research.demand_products, []);
  assert.equal(research.assessment_opportunities.length, 2);
  const assessment = assessCompany({
    research,
    target: broad,
    at: Date.parse('2026-10-22T00:00:00Z'),
    id: 'broad-test',
  });
  assert.equal(assessment.grade, 'A');
  assert.equal(assessment.direction, 'finished');
  assert.equal(assessment.product, 'window coverings');
  const instructions = companyResearchRequest(page, broad).messages[0].content;
  assert.match(instructions, /all全窗饰范围/);
  assert.match(instructions, /不从自产成品推测其已经采购配件/);
});
