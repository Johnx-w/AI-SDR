import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { assessCompany } from '../server/customer-assessment.mjs';

const website = 'https://buyer.example.org/';
const fact = (kind, value, source_url = website + 'screens') => ({
  kind,
  value,
  quote: 'Original evidence: ' + value,
  source_url,
});
function fixture() {
  const mainFacts = [
    fact('core_product', 'Zip screens'),
    fact('specialist_supply', '定制窗饰专业供应商'),
    fact('current_supply_process', '量尺后定制交付'),
    fact('custom_made', '按尺寸定制'),
    fact('motorized_system', '电动升降系统'),
  ];
  const otherFact = fact('secondary_product', '独立材料方向的面料', website + 'fabric');
  const snapshot = assessCompany({
    id: 'ev-dimension-fixture',
    at: Date.parse('2026-10-24T10:00:00Z'),
    research: {
      source_url: website,
      company_name: 'Buyer Screens',
      entity_type: 'business',
      facts: [],
      assessment_opportunities: [
        { direction: 'finished', product: 'Zip screens', facts: mainFacts },
        { direction: 'materials', product: 'Blind fabric', facts: [otherFact] },
      ],
    },
    target: { product: 'zip screens', country: 'United States' },
  });
  const stored = { ...snapshot, recordId: 'rec-dimension' };
  const lead = {
    id: stored.recordId,
    website,
    name: 'Buyer Screens',
    grade: stored.grade,
    ratingReason: '',
  };
  const engine = new NativeAcquisition({
    env: {},
    providers: {},
    feishu: {},
    store: {
      contactCorrections: () => ({}),
      companyIdentity: () => null,
      customsEvidence: () => [],
    },
    assessments: {
      latest: () => stored,
      summary: () => stored,
    },
  });
  return { stored, lead, mainFacts, otherFact, engine };
}

test('客户评估接口保留主供货方向各维度的事实、原文和来源，不跨方向拼接依据', () => {
  const { engine, stored, lead, otherFact } = fixture();
  const before = structuredClone(stored);
  const data = engine.decorateLeads({ leads: [lead], syncedAt: 'test' });
  const assessment = data.leads[0].assessment;
  assert.equal(assessment.product, 'Zip screens');
  assert.equal(assessment.score, stored.score);
  assert.equal(assessment.grade, stored.grade);
  assert.equal(assessment.ruleVersion, stored.ruleVersion);
  for (const [key, dimension] of Object.entries(stored.dimensions)) {
    assert.deepEqual(assessment.dimensions[key].facts, dimension.facts);
    assert.equal(assessment.dimensions[key].score, dimension.score);
    assert.equal(assessment.dimensions[key].maximum, dimension.maximum);
    assert.equal(assessment.dimensions[key].missing, dimension.missing);
    assert.ok(!assessment.dimensions[key].facts.some((entry) => entry.value === otherFact.value));
  }
  assert.ok(
    data.leads[0].facts.some((entry) => entry.value === otherFact.value),
    '企业证据仍保留其他方向',
  );
  assert.deepEqual(stored, before, '展示装饰不会修改已有评估快照');
});

test('旧评估缺少逐项事实时返回空依据，未知分数及冲突保持原样', () => {
  const { engine, stored, lead } = fixture();
  delete stored.dimensions.P.facts;
  stored.dimensions.D = { score: null, maximum: 20, missing: '持续经营资料不足' };
  stored.dimensions.R.conflict = true;
  const assessment = engine.decorateLeads({ leads: [lead] }).leads[0].assessment;
  assert.deepEqual(assessment.dimensions.P.facts, []);
  assert.deepEqual(assessment.dimensions.D, {
    score: null,
    maximum: 20,
    missing: '持续经营资料不足',
    facts: [],
  });
  assert.equal(assessment.dimensions.R.conflict, true);
  assert.equal(assessment.score, stored.score, '资料展示不重新计分');
});

test('维度只输出可检查的事实字段，不把内部元数据混进前端依据', () => {
  const { engine, stored, lead } = fixture();
  stored.dimensions.P.facts[0].internal_analysis = 'internal-only';
  const [entry] = engine.decorateLeads({ leads: [lead] }).leads[0].assessment.dimensions.P.facts;
  assert.deepEqual(Object.keys(entry).sort(), ['kind', 'quote', 'source_url', 'value']);
  assert.equal(entry.quote, stored.dimensions.P.facts[0].quote);
  assert.equal(entry.source_url, stored.dimensions.P.facts[0].source_url);
});
