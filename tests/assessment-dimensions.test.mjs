import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssessmentDimensions } from '../src/domain/assessment-dimensions.mjs';

const fact = (
  kind,
  value,
  quote = 'Exact original quote',
  source_url = 'https://buyer.example.org/product',
) => ({ kind, value, quote, source_url });
const dimension = (score, maximum, facts, extra = {}) => ({ score, maximum, facts, ...extra });

test('P/R/D/V按维度展示原评分，结论来自本维度事实，未知与零分保留区别', () => {
  const input = {
    dimensions: {
      V: dimension(10, 10, [
        fact('custom_made', '按尺寸定制'),
        fact('motorized_system', '电动控制'),
      ]),
      D: dimension(null, 20, [], { missing: '企业年限与供货流程待核实' }),
      R: dimension(0, 30, [fact('no_supply_role', '明确不供货')]),
      P: dimension(40, 40, [fact('core_product', 'Zip screens')]),
    },
  };
  const before = structuredClone(input);
  const result = buildAssessmentDimensions(input);
  assert.deepEqual(
    result.map(({ key, score }) => [key, score]),
    [
      ['P', 40],
      ['R', 0],
      ['D', null],
      ['V', 10],
    ],
  );
  assert.equal(result[0].conclusion, '主营产品与目标品类对口');
  assert.equal(result[1].conclusion, '现有证据显示无适用供货角色');
  assert.equal(result[2].conclusion, '持续经营依据待补充');
  assert.deepEqual(result[2].basis, ['待补充：企业年限与供货流程待核实']);
  assert.equal(result[3].conclusion, '具备定制与电动系统特征');
  assert.deepEqual(input, before, '展示整理不得修改评分或事实');
});

test('冲突事实保留，不能用单个正向事实生成肯定结论', () => {
  const facts = [fact('core_product', '经营防风帘'), fact('unrelated_product', '不经营防风帘')];
  const [result] = buildAssessmentDimensions({
    dimensions: { P: dimension(null, 40, facts, { conflict: true, missing: '同产品事实冲突' }) },
  });
  assert.equal(result.conflict, true);
  assert.equal(result.conclusion, '该维度事实存在冲突，需核实');
  assert.equal(result.score, null);
  assert.deepEqual(result.facts, facts);
});

test('原始引文和来源逐字保留，数组及对象事实值转换为可读依据并去重', () => {
  const quote = 'First original line.\n Second original line.';
  const inputFact = fact(
    'current_supply_process',
    { service: ['量尺', '交付'], active: false, sites: 0 },
    quote,
    'javascript:unsafe',
  );
  const [result] = buildAssessmentDimensions({
    dimensions: { D: dimension(5, 20, [inputFact, inputFact]) },
  });
  assert.deepEqual(result.basis, ['当前供货流程：量尺、交付、false、0']);
  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0].quote, quote);
  assert.equal(
    result.facts[0].source_url,
    'javascript:unsafe',
    '来源安全判断由链接渲染层执行，不能篡改原值',
  );
});

const textEvidence = [
  '研究限制：沿用已有证据',
  '成品 · Zip screens',
  '主营产品：户外防风帘',
  '原文：We supply zip screens.',
  '来源：https://buyer.example.org/zip',
  '定制能力需求：按尺寸定制',
  '原文：Made to measure.',
  '来源：https://buyer.example.org/zip',
  '材料配件 · Roller fabric',
  '主营产品：窗饰面料',
  '原文：Wholesale fabrics.',
  '来源：https://buyer.example.org/fabric',
  '电动系统特征：面料页面的其他产品电机',
  '原文：Different product motors.',
  '来源：https://buyer.example.org/fabric',
].join('\n');

test('旧证据仅按主产品及供货方向归组，不跨产品拼接定制或电动依据', () => {
  const result = buildAssessmentDimensions({
    product: 'Zip screens',
    direction: 'finished',
    evidenceReason: textEvidence,
    dimensions: {
      P: { score: 40, maximum: 40 },
      V: { score: 5, maximum: 10 },
    },
  });
  assert.deepEqual(result[0].basis, ['主营产品：户外防风帘']);
  assert.deepEqual(result[1].basis, ['定制特征：按尺寸定制']);
  assert.equal(result[1].conclusion, '具备定制特征');
  assert.ok(
    result.every((entry) =>
      entry.facts.every((entryFact) => entryFact.source_url.endsWith('/zip')),
    ),
  );
});

test('旧记录主产品缺失或不匹配时不猜测跨方向证据，已知评分也不推断经营事实', () => {
  for (const identity of [
    {},
    { product: 'Unknown product' },
    { product: 'Roller fabric', direction: 'finished' },
  ]) {
    const [result] = buildAssessmentDimensions({
      ...identity,
      evidenceReason: textEvidence,
      dimensions: { P: { score: 40, maximum: 40 } },
    });
    assert.deepEqual(result.facts, []);
    assert.equal(result.conclusion, '已记录产品契合评分');
    assert.equal(result.score, 40);
  }
});

test('显式空事实数组为权威记录，不能从混合文本填补；无结构化维度时不造维度', () => {
  const [result] = buildAssessmentDimensions({
    product: 'Zip screens',
    evidenceReason: textEvidence,
    dimensions: { P: dimension(40, 40, []) },
  });
  assert.deepEqual(result.facts, []);
  assert.equal(result.conclusion, '已记录产品契合评分');
  assert.deepEqual(buildAssessmentDimensions(null, textEvidence), []);
  assert.deepEqual(buildAssessmentDimensions({ evidenceReason: textEvidence }), []);
});

test('单产品无标题的旧标签证据可读取，并保留多行原文', () => {
  const quote = 'We tailor blinds.\nFor every opening.';
  const [result] = buildAssessmentDimensions(
    { dimensions: { V: { score: 5, maximum: 10 } } },
    `定制特征：定制窗帘\n原文：${quote}\n来源：https://buyer.example.org/contact\n待补充依据：经营年限待核实`,
  );
  assert.equal(result.conclusion, '具备定制特征');
  assert.equal(result.facts[0].quote, quote);
  assert.deepEqual(result.basis, ['定制特征：定制窗帘']);
});
