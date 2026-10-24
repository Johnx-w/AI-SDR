import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pageRelevance,
  productsRelevant,
  businessProductRelation,
  countryMatches,
} from '../server/relevance.mjs';
import { builtinProducts } from '../src/domain/acquisition-products.mjs';

const target = {
  product: 'outdoor zip screens, pergolas, awnings, full cassette folding arm awnings',
  market_countries: ['Australia'],
};

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
