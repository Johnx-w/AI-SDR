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
  assert.equal(result[2].conclusion, '持续经营尚无公开依据');
  assert.deepEqual(result[2].basis, []);
  assert.equal(result[3].conclusion, '具备定制与电动系统特征');
  assert.deepEqual(input, before, '展示整理不得修改评分或事实');
});

test('新版证据维度保留未知而不生成补资料提示，真实冲突仍可核实', () => {
  const result = buildAssessmentDimensions({
    ruleVersion: 'acquisition-v5.0',
    dimensions: {
      P: dimension(null, 40, [fact('core_product', '卷帘')], {
        conflict: true,
        missing: '同产品事实冲突',
      }),
      D: dimension(null, 20, [], { missing: '经营年限待补充' }),
    },
  });
  assert.equal(result[0].missing, '同产品事实冲突');
  assert.ok(result[0].basis.includes('需核实：同产品事实冲突'));
  assert.equal(result[1].missing, '');
  assert.equal(result[1].conclusion, '持续经营尚无公开依据');
  assert.deepEqual(result[1].basis, []);
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

test('无结构化维度事实时不解析旧评估文字', () => {
  const [result] = buildAssessmentDimensions({
    evidenceReason: '主营产品：旧文字',
    dimensions: { P: { score: 40, maximum: 40 } },
  });
  assert.deepEqual(result.facts, []);
  assert.equal(result.conclusion, '已记录产品契合评分');
  assert.deepEqual(buildAssessmentDimensions({ evidenceReason: '旧文字' }), []);
});
