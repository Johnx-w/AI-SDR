import { test } from 'node:test';
import assert from 'node:assert/strict';
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

test('新版优先级只依赖同方向产品和角色，飞书摘要可读回', () => {
  const result = evaluate([
    ...baseline.map((k) => fact(k)),
    fact('custom_made'),
    fact('motorized_system'),
    ...Array.from({ length: 5 }, (_, i) => fact('operating_outlet', `Showroom ${i}`)),
  ]);
  assert.equal(result.ruleVersion, 'acquisition-v5.0');
  assert.equal(result.score, 100);
  assert.equal(result.grade, 'A');
  assert.equal(result.matchLevel, '明确匹配');
  assert.ok(result.prioritySignals.some((signal) => signal.kind === 'core_product'));
  assert.equal(result.complete, true);
  assert.deepEqual(Object.keys(result.dimensions), ['P', 'R', 'D', 'V']);
  assert.deepEqual(
    Object.values(result.dimensions).map((d) => d.maximum),
    [40, 30, 20, 10],
  );
  assert.deepEqual(result.missing, []);
  assert.doesNotMatch(result.reason, /海关|\/100|待补充/);
  assert.doesNotMatch(formatAssessmentEvidence(result), /海关/);
  const lead = mapFeishuRecord({
    record_id: 'rec-test',
    fields: { 用户评级: result.grade, 评级依据: result.reason, 来源链接: source },
  });
  assert.equal(lead.score, null);
  assert.equal(lead.assessment.priority, 'A');
  assert.equal(lead.assessment.ruleVersion, 'acquisition-v5.0');
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

test('评估证据使用当前事实名称', () => {
  const result = evaluate([...baseline.map((k) => fact(k)), fact('custom_made')]);
  assert.match(formatAssessmentEvidence(result), /定制特征/);
});

test('同一网点重复出现不触发20分档', () => {
  const result = evaluate([
    ...baseline.map((k) => fact(k)),
    ...Array.from({ length: 5 }, () => fact('operating_outlet', 'Same showroom')),
  ]);
  assert.equal(result.dimensions.D.score, 5);
  assert.equal(result.score, 75);
});

test('主营和供货角色可在 D/V 全未知时A，副线仍为常规', () => {
  for (const role of ['specialist_supply', 'general_supply']) {
    const high = evaluate(['core_product', role].map((kind) => fact(kind)));
    assert.equal(high.grade, 'A');
    assert.equal(high.dimensions.D.score, null);
    assert.equal(high.dimensions.V.score, null);
    assert.deepEqual(high.missing, []);
  }
  const regular = evaluate(['secondary_product', 'specialist_supply'].map((kind) => fact(kind)));
  assert.equal(regular.grade, 'B');
  assert.equal(regular.matchLevel, '明确匹配');
});

test('缺持续经营依据仍A，海关不参与初评', () => {
  const facts = ['core_product', 'specialist_supply', 'custom_made', 'motorized_system'].map((k) =>
    fact(k),
  );
  const result = evaluate(facts, { customs: { score: 15, importCount: 1000 } });
  assert.equal(result.score, 80);
  assert.equal(result.grade, 'A');
  assert.equal(result.status, '优先开发');
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result, evaluate(facts));
});

test('已核实卷帘业务但经营角色未知时B，最佳成品证据保留面料潜在机会', () => {
  const result = assessCompany({
    research: {
      source_url: source,
      company_name: 'Example Blinds',
      entity_type: 'business',
      products: ['Custom roller shades', 'Roller shade fabric'],
      product_relation: {
        status: 'matched',
        kind: 'catalog_related',
        basis_product: 'Roller shade fabric',
      },
      assessment_opportunities: [
        {
          direction: 'finished',
          product: 'Custom roller shades',
          relationship: 'potential_input',
          facts: [fact('core_product', 'Custom roller shades')],
        },
      ],
    },
    target: { country: 'Canada', product: 'roller blind fabric' },
    id: 'fixture-partial-role',
  });
  assert.equal(result.grade, 'B');
  assert.equal(result.status, '可开发');
  assert.equal(result.score, 40);
  assert.equal(result.dimensions.R.score, null, '未知角色不补分');
  assert.equal(result.supplyOpportunity.procurementStatus, 'unconfirmed');
  assert.equal(result.supplyOpportunity.basisProduct, 'Custom roller shades');
});

test('邻近产品、仅安装、身份冲突与明确无关仍限制初评', () => {
  for (const [product, role, extra, status] of [
    ['adjacent_product', 'specialist_supply', [], '低投入开发'],
    ['core_product', 'installation_only', [], '低投入开发'],
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

test('明确市场不匹配不能因主营和供货角色被评为A', () => {
  const result = evaluate(
    ['core_product', 'specialist_supply'].map((kind) => fact(kind)),
    {
      country_match: 'not_matched',
    },
  );
  assert.equal(result.grade, null);
  assert.equal(result.matchLevel, '不匹配');
  assert.equal(result.status, '暂不开发');
});

test('无可用机会时只有四项未知，不生成海关缺项', () => {
  const result = evaluate([], { assessment_opportunities: [] });
  assert.equal(result.score, 0);
  assert.equal(result.grade, 'C');
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

test('只读取当前结构的评估摘要', () => {
  const current = evaluate(baseline.map((k) => fact(k)));
  assert.equal(
    readAssessmentSummary(formatAssessmentReason(current)).ruleVersion,
    'acquisition-v5.0',
  );
  const old = formatAssessmentReason(current).replace('acquisition-v5.0', 'acquisition-v2.1');
  assert.equal(readAssessmentSummary(old), null);
});
