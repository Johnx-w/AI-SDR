import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/modules.mjs';

const { marketLabel, leadProductCategories, developmentStatuses } = loadModule(
  new URL('../src/domain/lead-library-filters.ts', import.meta.url),
);

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

test('产品按经营大类去重，同一客户可属于多个大类', () => {
  assert.deepEqual(
    leadProductCategories(
      'E ZIP / Zip Track Blinds(户外防风卷帘)\nZip Screen outdoor blinds(防风帘)\nRoller Shades(卷帘)\nPlantation Shutters(百叶窗)',
    ),
    ['Screens（防风帘与纱网）', 'Blinds & Shades（百叶帘与卷帘）', 'Shutters（百叶窗与卷闸）'],
  );
  assert.deepEqual(leadProductCategories('roller blind fabric'), [
    'Materials & Parts（面料与配件）',
  ]);
  assert.deepEqual(leadProductCategories('blinds fabric sample books'), [
    'Samples & Displays（样本与展示）',
  ]);
  assert.deepEqual(leadProductCategories('shade sails;布艺帘'), [
    'Outdoor Shading（户外遮阳）',
    'Curtains（布艺帘）',
  ]);
  assert.deepEqual(leadProductCategories('window treatments(其他产品)'), ['Other（其他窗饰）']);
  assert.deepEqual(leadProductCategories(''), ['Unverified（待核实）']);
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
