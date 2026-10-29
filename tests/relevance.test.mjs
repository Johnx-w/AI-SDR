import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pageRelevance,
  productsRelevant,
  businessProductRelation,
  countryMatches,
  windowProductDirections,
} from '../server/relevance.mjs';
import { builtinProducts } from '../src/domain/acquisition-products.mjs';

const target = {
  product: 'outdoor zip screens, pergolas, awnings, full cassette folding arm awnings',
  market_countries: ['Australia'],
};

test('配件用途中的并列帘型不构成销售整帘的证据', () => {
  for (const product of [
    'replacement parts and string for blinds and shades',
    'components for blinds and curtains',
    'cords for blinds and shades',
    'hardware for blinds and shades',
    '用于百叶帘和卷帘的配件',
    '百叶帘和卷帘用配件',
    '用于百叶帘和卷帘的维修配件',
    '百叶帘和卷帘用绳线',
    '百叶帘配件和卷帘配件',
    '窗饰替换配件',
  ])
    assert.deepEqual(windowProductDirections(product), ['materials'], product);
});

test('独立经营整帘与配件仍保留两个供货方向，通用配件不证明窗饰业务', () => {
  for (const product of [
    'We supply blinds and shades. We also sell replacement parts and string for blinds and shades.',
    'We supply roller blinds and components for blinds and curtains.',
    'We supply replacement parts for blinds and also sell complete roller shades.',
    '我们供应百叶帘和卷帘，并销售窗饰配件。',
  ])
    assert.deepEqual(windowProductDirections(product), ['materials', 'finished'], product);
  for (const product of [
    'string, cords, mounting hardware and motors',
    'components for vehicle blinds',
    'strings for medical curtains',
  ])
    assert.deepEqual(windowProductDirections(product), [], product);
});

test('明确用于卷帘的绳线、五金与附件按材料配件匹配，不冒充整帘', () => {
  for (const noun of ['cords', 'string', 'hardware', 'accessories', 'materials']) {
    const product = `${noun} for roller blinds`;
    assert.deepEqual(windowProductDirections(product), ['materials'], product);
    assert.equal(productsRelevant([product], { product: 'roller blinds' }), 'not_matched', product);
    assert.equal(
      businessProductRelation([product], { product: 'roller blinds' }).status,
      'not_matched',
      product,
    );
    assert.equal(
      productsRelevant([product], { product: 'roller blind components' }),
      'matched',
      product,
    );
  }
  for (const product of ['E ZIP / Zip Track 户外防风卷帘', 'panel track blinds'])
    assert.deepEqual(windowProductDirections(product), ['finished'], product);
});

test('成品介绍同时提到用料或独立配件目录时仍可匹配成品', () => {
  for (const product of [
    'Our custom Roller Shades are made to measure and handcrafted with premium materials and high-quality components for a tailored fit and finish.',
    'We supply roller shades and components for blinds and curtains.',
  ]) {
    assert.equal(productsRelevant([product], { product: 'roller shades' }), 'matched', product);
    assert.equal(businessProductRelation([product], { product: 'roller shades' }).kind, 'catalog_related');
  }
});

test('行业强短语与目标产品短语判定页面相关', () => {
  const relevant = pageRelevance(
    'Helioscreen manufactures retractable outdoor blinds, folding arm awnings and pergola systems for patios across Australia. Custom zip screens installed by our own team.',
    target,
  );
  assert.equal(relevant.relevant, true);
  assert.ok(relevant.score >= 2);
});

test('无关站点（露营/房车/家具/咨询/新闻）判定不相关', () => {
  const irrelevant = [
    "BCF is Australia's greatest boating, camping and fishing store. Shop tents, kayaks and 4x4 gear.",
    'RV Mega supplies caravan and motorhome parts, water pumps, solar panels and cleaning chemicals in New Zealand.',
    'Treasurebox sells affordable bedroom furniture, lounge sofas, mattresses and office storage online.',
    'Interconnection Consulting provides market and competition analysis for industrial clients.',
    'OCAM Industries builds 270 degree vehicle awnings, roof racks and bull bars for 4x4 touring.',
  ];
  for (const text of irrelevant)
    assert.equal(pageRelevance(text, target).relevant, false, '不应判定相关: ' + text.slice(0, 40));
});

test('页面文本过短不判定相关', () => {
  assert.equal(pageRelevance('blinds', target).relevant, false);
});

test('AI 提取产品与目标产品做相关性审计', () => {
  assert.equal(
    productsRelevant(['Zipscreen 户外拉链帘', 'Wire Guide 帘', 'Straight Drop 帘'], target),
    'matched',
  );
  assert.equal(
    productsRelevant(['Boating equipment', 'Camping gear', 'Fishing tackle'], target),
    'not_matched',
  );
  assert.equal(productsRelevant([], target), 'unknown');
  assert.equal(productsRelevant(['shades'], {}), 'unrestricted');
});

test('国家证据与目标市场比对，别名可归一', () => {
  assert.equal(countryMatches('Australia', ['Australia']), 'matched');
  assert.equal(countryMatches('new zealand', ['Australia']), 'not_matched');
  assert.equal(countryMatches('USA', ['United States']), 'matched');
  assert.equal(countryMatches('', ['Australia']), 'unknown');
  assert.equal(countryMatches('Australia', []), 'unrestricted');
});

test('成品卷帘与面料组件形成潜在业务关联，不宣称已采购，也不放宽到无关产品', () => {
  for (const product of ['roller blind fabric', 'blind components', 'roller blind clutch']) {
    const result = businessProductRelation(['Roller Shades'], { product });
    assert.equal(result.status, 'matched', product);
    assert.equal(result.kind, 'potential_input', product);
  }
  assert.equal(
    businessProductRelation(['Roman blinds'], { product: 'outdoor zip screen components' }).status,
    'not_matched',
  );
  assert.equal(
    businessProductRelation(['roller blind fabric'], { product: 'roller blind fabric' }).kind,
    'catalog_related',
  );
  assert.equal(
    businessProductRelation(['window treatments', 'window coverings'], {
      product: 'blind components',
    }).kind,
    'potential_input',
  );
});

test('按目标品类而非整个窗饰行业匹配，兼容中英文别名', () => {
  for (const product of [
    'Roman blinds',
    'Venetian blinds',
    'roller shutters',
    'plantation shutters',
    '户外遮阳篷',
  ])
    assert.equal(
      productsRelevant([product], { product: 'outdoor zip screens' }),
      'not_matched',
      product,
    );
  for (const product of ['Ziptrak', 'E ZIP / Zip Track 户外防风卷帘', 'Zipscreen', '防风帘'])
    assert.equal(
      productsRelevant([product], { product: 'outdoor zip screens' }),
      'matched',
      product,
    );
  assert.equal(
    productsRelevant(['awnings'], { product: 'full cassette folding arm awnings' }),
    'not_matched',
  );
  assert.equal(productsRelevant(['全盒曲臂篷'], { product: 'awnings' }), 'matched');
  assert.equal(productsRelevant(['蜂巢帘'], { product: 'cellular blinds' }), 'matched');
  assert.equal(
    productsRelevant(['Roman blinds'], { product: 'outdoor zip screens, Roman blinds' }),
    'matched',
  );
  assert.equal(productsRelevant(['roller shutters'], { product: 'shutters' }), 'not_matched');
  assert.equal(
    productsRelevant(['outdoor roller blinds'], { product: 'roller blinds' }),
    'not_matched',
  );
  assert.equal(productsRelevant(['vehicle awnings'], { product: 'awnings' }), 'not_matched');
});

test('半成品按室内外配件比较，不混入成品窗帘', () => {
  const outdoor = { product: 'outdoor blinds awnings components and parts' };
  const indoor = { product: 'indoor blinds curtains components and parts' };
  assert.equal(productsRelevant(['zip screen motors and brackets'], outdoor), 'matched');
  assert.equal(productsRelevant(['Roman blind parts'], indoor), 'matched');
  assert.equal(productsRelevant(['Roman blind parts'], outdoor), 'not_matched');
  assert.equal(productsRelevant(['zip screen motors'], indoor), 'not_matched');
  assert.equal(productsRelevant(['outdoor zip screens'], outdoor), 'not_matched');
  assert.equal(
    productsRelevant(['zip screen parts'], { product: 'outdoor zip screens' }),
    'not_matched',
  );
});

test('内外成品目录中的每一品类都能独立匹配，细分品类不被通用名称冒充', () => {
  const finished = builtinProducts.filter((product) => product.direction === 'finished');
  for (const product of finished)
    assert.equal(
      productsRelevant([product.value], { products: [product] }),
      'matched',
      product.label,
    );
  for (const [target, actual] of [
    ['straight drop awnings', 'folding arm awnings'],
    ['folding arm awnings', 'window awnings'],
    ['pergola awnings', 'pergolas'],
    ['outdoor roller blinds', 'roller blinds'],
    ['outdoor venetian blinds', 'Venetian blinds'],
    ['solar roller shades', 'roller blinds'],
    ['sheer curtains', 'fabric curtains'],
    ['panel track blinds', 'vertical blinds'],
  ])
    assert.equal(productsRelevant([actual], { product: target }), 'not_matched', target);
  assert.equal(productsRelevant(['纱帘'], { product: 'sheer curtains' }), 'matched');
  assert.equal(productsRelevant(['竹帘'], { product: 'woven wood shades' }), 'matched');
  assert.equal(productsRelevant(['户外百叶帘'], { product: 'outdoor venetian blinds' }), 'matched');
});
