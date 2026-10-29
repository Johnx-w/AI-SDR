import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/modules.mjs';

const { marketLabel, leadProductCategories, leadProductCategoryLabels, developmentStatuses } =
  loadModule(new URL('../src/domain/lead-library-filters.ts', import.meta.url));

test('客户库支持的市场使用中文显示，中文原值保持不变', () => {
  for (const [value, label] of [
    ['United States', '美国'],
    ['Australia', '澳大利亚'],
    ['Canada', '加拿大'],
    ['United Kingdom', '英国'],
    ['Europe', '欧洲'],
    ['加拿大', '加拿大'],
  ])
    assert.equal(marketLabel(value), label);
});

test('国家空值和未知市场统一显示待核实，已知市场保持原值', () => {
  for (const market of [
    null,
    undefined,
    '',
    '  ',
    'unknown',
    ' UNKNOWN ',
    '未知',
    '未记录',
    '待核实',
  ])
    assert.equal(marketLabel(market), '待核实');
  assert.equal(marketLabel(' Canada '), '加拿大');
  assert.equal(marketLabel('France'), 'France');
});

test('客户库固定展示五类产品，按英文（中文）命名并沿用业务品类定义', () => {
  assert.deepEqual(Object.values(leadProductCategoryLabels), [
    'Plantation Shutters（透气窗）',
    'Venetian Blinds（百叶窗）',
    'Outdoor Shading（户外遮阳）',
    'Indoor Window Coverings（室内成品帘）',
    'Fabrics & Components（面料与配件）',
  ]);
  for (const [category, products] of [
    ['plantation', ['Plantation Shutters(百叶窗)', 'PVC shutters', '透气窗']],
    [
      'venetian',
      [
        'Venetian blinds',
        'Horizontal blinds',
        'faux wood blinds',
        'aluminium blinds',
        '横百叶',
        '百叶窗',
      ],
    ],
    [
      'outdoor',
      [
        'E ZIP blinds',
        'Ziptrak',
        'outdoor roller blinds',
        'external venetian blinds',
        'roller shutters',
        'awning',
        'pergola',
        'shade sails',
        'screens',
        '户外防风帘',
        '天幕',
      ],
    ],
    [
      'indoor',
      [
        'roller shades',
        'fabric curtains',
        'sheer curtains',
        'drapery',
        'cellular blinds',
        'Roman blinds',
        'vertical blinds',
        '布艺帘',
        '梦幻帘',
      ],
    ],
    [
      'materials',
      [
        'roller blind fabric',
        'screen fabrics',
        'shutter profiles',
        'Venetian blind components',
        'motors',
        'blinds fabric sample books',
        'blinds display kits',
        '百叶窗配件',
      ],
    ],
  ])
    for (const product of products)
      assert.deepEqual(
        leadProductCategories(product),
        [leadProductCategoryLabels[category]],
        product,
      );
});

test('产品按五类去重，兼营客户命中多个品类，具体用途和配件优先于通用产品词', () => {
  assert.deepEqual(
    leadProductCategories(
      'E ZIP / Zip Track Blinds(户外防风卷帘)\nZip Screen outdoor blinds(防风帘)\nRoller Shades(卷帘)\nPlantation Shutters(百叶窗)',
    ),
    [
      'Outdoor Shading（户外遮阳）',
      'Indoor Window Coverings（室内成品帘）',
      'Plantation Shutters（透气窗）',
    ],
  );
  assert.deepEqual(leadProductCategories('roller blind fabric'), [
    'Fabrics & Components（面料与配件）',
  ]);
  assert.deepEqual(leadProductCategories('blinds fabric sample books'), [
    'Fabrics & Components（面料与配件）',
  ]);
  assert.deepEqual(leadProductCategories('shade sails;布艺帘'), [
    'Outdoor Shading（户外遮阳）',
    'Indoor Window Coverings（室内成品帘）',
  ]);
  assert.deepEqual(
    leadProductCategories(
      'Plantation shutters, Venetian blinds；awning、fabric curtains and roller blind fabrics',
    ),
    Object.values(leadProductCategoryLabels),
  );
  assert.deepEqual(leadProductCategories('window treatments(其他产品)'), []);
  assert.deepEqual(leadProductCategories(''), []);
  assert.deepEqual(leadProductCategories('  \n;； '), []);
});

test('销售状态采用确认的顺序，报价和寄样由客户业务记录', () => {
  assert.deepEqual(developmentStatuses, [
    '待开发',
    '已联系',
    '已回复',
    '跟进中',
    '已成交',
    '暂缓开发',
    '停止开发',
  ]);
});
