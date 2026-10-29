import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  companyResearchRequest,
  parseCompanyResearch,
  researchFields,
} from '../server/company-research.mjs';
import { assessCompany } from '../server/customer-assessment.mjs';
import { researchPolicyCode } from '../scripts/research-policy-code.mjs';

const source_url = 'https://fixmyblinds.com/';
const broad = {
  product_scope: 'all',
  product: 'window coverings',
  market_countries: ['United States'],
  audience: 'BC',
};
const identity = 'Welcome to Fix My Blinds.';
const accessoryQuote =
  'At Fix My Blinds, we offer replacement parts and string for blinds and shades.';
const accessoryProduct = 'replacement parts and string for blinds and shades';
const evidence = (value, quote, source = source_url) => ({ value, quote, source_url: source });
const response = (raw) => ({
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }],
});
const parse = (raw, text, target = broad, pages = [{ source_url, text }]) =>
  parseCompanyResearch(response(raw), { source_url, research_pages: pages }, target);
const catalog = () => ({
  company_name: evidence('Fix My Blinds', accessoryQuote),
  entity_type: evidence('business', accessoryQuote),
  products: [
    'Cord, String &amp; Loops',
    'Tilt Mechanisms',
    'Mounting Brackets',
    'Cordless Operation Parts',
  ].map((label) => evidence(label, label)),
});
const historicalText =
  accessoryQuote +
  '\nCord, String &amp; Loops\nTilt Mechanisms\nMounting Brackets\nCordless Operation Parts';

test('历史目录响应从已核验公司引文恢复窗饰配件用途并贯通初评和客户字段', () => {
  const research = parse(catalog(), historicalText);
  assert.equal(research.product_match, 'matched');
  assert.equal(research.ok, true);
  assert.ok(research.products.includes(accessoryProduct));
  assert.ok(research.products.includes('Tilt Mechanisms'));
  assert.deepEqual(
    research.facts.find((f) => f.field === 'products' && f.value === accessoryProduct),
    { field: 'products', ...evidence(accessoryProduct, accessoryQuote) },
  );
  assert.deepEqual(research.demand_products, []);
  const assessment = assessCompany({ research, target: broad, id: 'accessory-regression' });
  assert.equal(assessment.direction, 'materials');
  assert.equal(assessment.grade, 'C');
  assert.equal(assessment.opportunities.length, 1);
  assert.equal(researchFields(research, {})['需求产品'], undefined);
  assert.match(researchFields(research, {})['相关产品'], /parts and string for blinds and shades/);
  const replay = parse(research, historicalText);
  assert.deepEqual(replay.products, research.products);
  assert.equal(
    replay.facts.filter((f) => f.field === 'products' && f.value === accessoryProduct).length,
    1,
  );
  // Already parsed records use a plain address and retain evidence in facts.
  assert.deepEqual(
    parse(
      { ...research, address: { street: 'Fixture Street', city: 'Fixture City' } },
      historicalText,
    ).products,
    research.products,
  );
});

test('省略用途的名称仅在引文明示本站经营配件用途时补充概括事实', () => {
  for (const [quote, product] of [
    ['We supply components for blinds and curtains.', 'components for blinds and curtains'],
    ['We are a supplier of parts for blinds and shades.', 'parts for blinds and shades'],
    ['We sell roller blind parts.', 'roller blind parts'],
    ['我们供应用于百叶帘和卷帘的配件。', '用于百叶帘和卷帘的配件'],
    ['本公司销售窗帘配件。', '窗帘配件'],
    ['我们供应配件和拉绳用于百叶帘和卷帘。', '配件和拉绳用于百叶帘和卷帘'],
  ]) {
    const research = parse(
      { company_name: evidence('Fix My Blinds', identity), products: [evidence('parts', quote)] },
      identity + '\n' + quote,
    );
    assert.equal(research.product_match, 'matched', quote);
    assert.ok(research.products.includes(product), quote);
  }
});

test('配件泛称不越过specific细品类和室内户外边界', () => {
  for (const product of [
    'roller blind motors',
    'outdoor zip screen components',
    'indoor blind parts',
  ]) {
    const research = parse(catalog(), historicalText, { product_scope: 'specific', product });
    assert.notEqual(research.product_match, 'matched', product);
  }
});

test('通用零件、串证、第三方、否定及无关用途不能恢复窗饰产品事实', () => {
  for (const quote of [
    'We sell motors and discuss blinds.',
    'We offer hardware. Read our news about blinds and shades.',
    'Our partner supplies replacement parts for blinds and shades.',
    'News: We supply replacement parts for blinds and shades.',
    'Our customer says: We supply replacement parts for blinds and shades.',
    'Our customer says:\nWe supply replacement parts for blinds and shades.',
    'News about our partner. We supply replacement parts for blinds and shades.',
    'We do not sell replacement parts for blinds and shades.',
    'We no longer offer replacement parts for blinds and shades.',
    'We offer replacement parts for blinds and shades made by another company, not our products.',
    'We sell replacement parts for car window shades.',
    'We supply components for medical curtains.',
    '我们不经营窗帘配件。',
    '合作伙伴供应窗帘配件。',
    '我们供应汽车遮阳帘配件。',
    '我们供应医用帘配件。',
  ]) {
    const research = parse(
      {
        company_name: evidence('Fix My Blinds', identity),
        products: [evidence('hardware', quote)],
      },
      identity + '\n' + quote,
    );
    assert.notEqual(research.product_match, 'matched', quote);
    assert.deepEqual(research.products, ['hardware'], quote);
  }
});

test('伪造引文、错误来源、外站自述或未确认官网主体不能补用途', () => {
  const raw = {
    company_name: evidence('Fix My Blinds', identity),
    products: [evidence('parts', accessoryQuote)],
  };
  assert.notEqual(parse(raw, identity).product_match, 'matched');
  assert.notEqual(
    parse(
      { ...raw, products: [evidence('parts', accessoryQuote, source_url + 'missing')] },
      identity + '\n' + accessoryQuote,
    ).product_match,
    'matched',
  );
  assert.notEqual(
    parse(
      { ...raw, products: [evidence('parts', accessoryQuote, 'https://other.example/')] },
      identity,
      broad,
      [
        { source_url, text: identity },
        { source_url: 'https://other.example/', text: accessoryQuote },
      ],
    ).product_match,
    'matched',
  );
  assert.notEqual(
    parse({ products: [evidence('parts', accessoryQuote)] }, accessoryQuote).product_match,
    'matched',
  );
});

test('已有窗饰配件值也不能借真实但不支持该用途或细类的引文通过', () => {
  for (const [value, quote] of [
    ['roller blind motors', 'We sell motors. We publish articles about roller blinds.'],
    ['roller blind motors', 'We offer roller blinds and sell automotive motors.'],
    ['roller blind parts', 'We do not sell roller blind parts.'],
    ['roller blind parts', 'Our partner supplies roller blind parts.'],
    ['roller blind motors', 'We supply roller blind parts.'],
    ['roller blind motors', 'We sell roller blind fabric.'],
    ['parts for curtains', 'We sell parts for curtains used as welding safety screens.'],
    ['roller blind motors', 'We sell roller blind motorsports books.'],
  ]) {
    const research = parse(
      { company_name: evidence('Fix My Blinds', identity), products: [evidence(value, quote)] },
      identity + '\n' + quote,
    );
    assert.ok(!research.products.includes(value), quote);
  }
  const translated = parse(
    {
      company_name: evidence('Fix My Blinds', identity),
      products: [evidence('卷帘电机', 'We supply roller blind parts.')],
    },
    identity + '\nWe supply roller blind parts.',
  );
  assert.equal(translated.product_match, 'matched');
  assert.deepEqual(translated.products, ['roller blind parts']);
});

test('肯定销售配件而否定销售整帘仍保留配件业务', () => {
  for (const [product, quote] of [
    ['roller blind parts', 'We sell roller blind parts, not finished blinds.'],
    ['roller blind parts', 'We sell roller blind parts. We do not sell finished blinds.'],
    ['窗帘配件', '我们销售窗帘配件，不销售成品窗帘。'],
    ['窗帘配件', '我们销售窗帘配件。我们不销售成品窗帘。'],
  ]) {
    const research = parse(
      {
        company_name: evidence('Fix My Blinds', identity),
        entity_type: evidence('business', identity),
        products: [evidence(product, quote)],
      },
      identity + '\n' + quote,
    );
    assert.equal(research.product_match, 'matched', quote);
    assert.equal(
      assessCompany({ research, target: broad, id: 'accessory-only' }).direction,
      'materials',
      quote,
    );
  }
});

test('连续原文目录可支持用途，短引文不能丢掉所在页的第三方归属', () => {
  const product = 'roller blind parts';
  const raw = {
    company_name: evidence('Fix My Blinds', identity),
    products: [evidence('parts', product)],
  };
  assert.equal(parse(raw, identity + '\n' + product).product_match, 'matched');
  assert.notEqual(parse(raw, identity + '\nCustomer review:\n' + product).product_match, 'matched');
  for (const quote of [
    'Fix My Blinds supplies parts for blinds and shades.',
    'We supply roller blind motors.',
  ]) {
    const research = parse(
      { company_name: evidence('Fix My Blinds', identity), products: [evidence('parts', quote)] },
      identity + '\n' + quote,
    );
    assert.equal(research.product_match, 'matched', quote);
  }
  const steelQuote = '我们供应不锈钢窗帘配件。';
  assert.notEqual(
    parse(
      {
        company_name: evidence('Fix My Blinds', identity),
        products: [evidence(['roller blinds'], 'We sell automotive motors.')],
      },
      identity + '\nWe sell automotive motors.',
    ).product_match,
    'matched',
  );
  assert.equal(
    parse(
      {
        company_name: evidence('Fix My Blinds', identity),
        products: [evidence('窗帘配件', steelQuote)],
      },
      identity + '\n' + steelQuote,
    ).product_match,
    'matched',
  );
  for (const quote of [
    'We do not sell roller blind parts.',
    'Our partner supplies roller blind parts.',
  ]) {
    assert.notEqual(
      parse(
        {
          company_name: evidence('Fix My Blinds', identity),
          products: [evidence(['roller blind parts'], quote)],
        },
        identity + '\n' + quote,
      ).product_match,
      'matched',
    );
  }
});

test('提示词要求保留配件用途，兼容工作流解析器执行相同回归', () => {
  assert.match(companyResearchRequest({}, broad).messages[0].content, /配件.*用途/);
  const result = vm.runInNewContext(
    researchPolicyCode +
      '\n' +
      parseCompanyResearch.toString() +
      '\nparseCompanyResearch(response,page,target)',
    {
      response: response(catalog()),
      page: { source_url, research_pages: [{ source_url, text: historicalText }] },
      target: broad,
    },
  );
  assert.equal(result.product_match, 'matched');
});
