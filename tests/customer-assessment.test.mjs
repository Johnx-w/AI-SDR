import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  assessCompany,
  assessmentId,
  formatAssessmentReason,
  formatAssessmentEvidence,
  readAssessmentSummary,
} from '../server/customer-assessment.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';

const source = 'https://blinds.example/';
const target = { product: 'roller blinds', country: 'Australia' };
const fact = (kind, value = kind) => ({ kind, value, quote: value, source_url: source });
const baseline = ['core_product', 'specialist_supply', 'current_supply_process'];
const opportunity = (facts) => ({ direction: 'finished', product: 'roller blinds', facts });
function evaluate(facts, overrides = {}) {
  return assessCompany({
    research: {
      source_url: source,
      company_name: 'Example Blinds',
      entity_type: 'business',
      assessment_opportunities: [opportunity(facts)],
      ...overrides,
    },
    target,
    at: Date.parse('2026-10-22T00:00:00Z'),
    id: assessmentId('test-scope', 'test-operation'),
  });
}

test('初评四项可独立达到100分，不依赖海关，摘要可经飞书读回', () => {
  const result = evaluate([
    ...baseline.map((k) => fact(k)),
    fact('custom_made'),
    fact('motorized_system'),
    ...Array.from({ length: 5 }, (_, i) => fact('operating_outlet', `Showroom ${i}`)),
  ]);
  assert.equal(result.ruleVersion, 'acquisition-v3.0');
  assert.equal(result.score, 100);
  assert.equal(result.grade, 'A');
  assert.equal(result.complete, true);
  assert.deepEqual(Object.keys(result.dimensions), ['P', 'R', 'D', 'V']);
  assert.deepEqual(
    Object.values(result.dimensions).map((d) => d.maximum),
    [40, 30, 20, 10],
  );
  assert.deepEqual(result.missing, []);
  assert.doesNotMatch(result.reason, /海关/);
  assert.doesNotMatch(formatAssessmentEvidence(result), /海关/);
  const lead = mapFeishuRecord({
    record_id: 'rec-test',
    fields: { 用户评级: result.grade, 评级依据: result.reason, 来源链接: source },
  });
  assert.equal(lead.score, 100);
  assert.equal(lead.assessment.complete, true);
  assert.equal(lead.assessment.ruleVersion, 'acquisition-v3.0');
});

test('持续经营中档按15分计算；95分来自真实业务证据而非海关假设', () => {
  const result = evaluate([
    ...baseline.map((k) => fact(k)),
    fact('company_years', '6'),
    fact('custom_made'),
    fact('motorized_system'),
  ]);
  assert.equal(result.dimensions.D.score, 15);
  assert.equal(result.score, 95);
  assert.equal(result.complete, true);
});

test('同一网点重复出现不触发20分档', () => {
  const result = evaluate([
    ...baseline.map((k) => fact(k)),
    ...Array.from({ length: 5 }, () => fact('operating_outlet', 'Same showroom')),
  ]);
  assert.equal(result.dimensions.D.score, 5);
  assert.equal(result.score, 75);
});

test('新档位门槛保留A75与B60，未知V不按比例放大', () => {
  const a = evaluate(baseline.map((k) => fact(k)));
  assert.equal(a.score, 75);
  assert.equal(a.grade, 'A');
  assert.equal(a.complete, false);
  const b = evaluate(
    ['secondary_product', 'general_supply', 'current_supply_process'].map((k) => fact(k)),
  );
  assert.equal(b.score, 60);
  assert.equal(b.grade, 'B');
  assert.equal(b.dimensions.V.score, null);
  assert.equal(b.missing.length, 1);
  assert.doesNotMatch(b.missing.join(' '), /海关/);
});

test('缺经营依据即使有80分仍待补全，海关不能解除前置门槛', () => {
  const facts = ['core_product', 'specialist_supply', 'custom_made', 'motorized_system'].map((k) =>
    fact(k),
  );
  const result = evaluate(facts, { customs: { score: 15, importCount: 1000 } });
  assert.equal(result.score, 80);
  assert.equal(result.grade, null);
  assert.equal(result.status, '待补全');
  assert.deepEqual(result, evaluate(facts));
});

test('邻近产品、仅安装、身份冲突与明确无关仍限制初评', () => {
  for (const [product, role, extra, status] of [
    ['adjacent_product', 'specialist_supply', [], '暂缓开发'],
    ['core_product', 'installation_only', [], '暂缓开发'],
    ['core_product', 'specialist_supply', [fact('identity_conflict')], '待核实'],
    ['unrelated_product', 'specialist_supply', [], '暂不开发'],
  ]) {
    const result = evaluate([
      fact(product),
      fact(role),
      fact('current_supply_process'),
      fact('company_years', '8'),
      fact('custom_made'),
      fact('motorized_system'),
      ...extra,
    ]);
    assert.equal(result.status, status);
    assert.notEqual(result.grade, 'A');
  }
});

test('无可用机会时只有四项未知，不生成海关缺项', () => {
  const result = evaluate([], { assessment_opportunities: [] });
  assert.equal(result.score, 0);
  assert.equal(result.grade, null);
  assert.equal(result.complete, false);
  assert.deepEqual(Object.keys(result.dimensions), ['P', 'R', 'D', 'V']);
  assert.doesNotMatch(result.reason, /海关/);
});

test('跨方向不拼分，受阻方向不能覆盖有效机会', () => {
  const result = evaluate([], {
    assessment_opportunities: [
      opportunity([
        ...baseline.map((k) => fact(k)),
        fact('mandatory_requirement'),
        fact('custom_made'),
      ]),
      { ...opportunity(baseline.map((k) => fact(k))), product: 'zebra blinds' },
    ],
  });
  assert.equal(result.product, 'zebra blinds');
  assert.equal(result.score, 75);
  assert.equal(result.grade, 'A');
});

test('旧版评估保持原权重及海关未知，新版操作产生不同评估ID', () => {
  const oldId =
    'ev_' +
    createHash('sha256')
      .update(JSON.stringify(['test-scope', 'test-operation', 'acquisition-v2.1']))
      .digest('hex')
      .slice(0, 36);
  const old = {
    ...evaluate(baseline.map((k) => fact(k))),
    id: oldId,
    ruleVersion: 'acquisition-v2.1',
    score: 65,
    grade: 'B',
    status: '可开发',
    complete: false,
    dimensions: {
      P: { score: 35, maximum: 35 },
      R: { score: 25, maximum: 25 },
      D: { score: 5, maximum: 15 },
      V: { score: null, maximum: 10 },
      I: { score: null, maximum: 15 },
    },
  };
  const before = structuredClone(old);
  const reason = formatAssessmentReason(old);
  const summary = readAssessmentSummary(reason);
  assert.equal(summary.score, 65);
  assert.equal(summary.ruleVersion, 'acquisition-v2.1');
  assert.match(reason, /I 海关采购表现：未知\/15/);
  assert.deepEqual(old, before);
  assert.notEqual(assessmentId('test-scope', 'test-operation'), oldId);
});
