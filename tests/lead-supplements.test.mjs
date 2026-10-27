import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCompany } from '../server/customer-assessment.mjs';
import {
  validateSupplement,
  applySupplementsToResearch,
  recomputeFromSnapshot,
} from '../server/lead-supplements.mjs';

const at = Date.parse('2026-10-25T04:00:00Z');
const source = 'https://blinds.example/products';
const fact = (kind, value = kind) => ({ kind, value, quote: value, source_url: source });
const research = {
  source_url: source,
  company_name: 'Example Blinds',
  entity_type: 'business',
  incomplete_reason: '保留原官网研究限制',
  checked_urls: [source],
  facts: [
    { field: 'products', value: 'roller blinds', quote: 'roller blinds', source_url: source },
  ],
  assessment_opportunities: [
    {
      direction: 'finished',
      product: 'roller blinds',
      facts: [fact('core_product'), fact('current_supply_process'), fact('company_since', '2009')],
    },
    {
      direction: 'materials',
      product: 'blind fabric',
      facts: [fact('secondary_product')],
    },
  ],
};
const initial = () =>
  assessCompany({
    research,
    target: { product: 'roller blinds', country: 'Australia' },
    at,
    id: 'base',
  });
const form = (overrides = {}) => ({
  expectedAssessmentId: 'base',
  category: 'assessment',
  dimension: 'R',
  direction: 'finished',
  product: 'roller blinds',
  content: '人工已确认该产品由企业专业供货',
  evidence: '2026-10-25 客户来电确认：我们专业生产及供货卷帘',
  confirmedBy: '张工',
  facts: [{ kind: 'specialist_supply', value: '专业卷帘制造及供货' }],
  ...overrides,
});
const confirmation = (overrides = {}) => ({
  ...validateSupplement(form(overrides), { at }),
  id: 'confirmation-1',
  confirmedAt: new Date(at).toISOString(),
});

test('人工确认经营角色按现有规则重算，补齐R但保留未知V和原研究限制', () => {
  const before = initial();
  assert.equal(before.dimensions.R.score, null);
  assert.equal(before.score, 55);
  const entry = confirmation();
  const result = recomputeFromSnapshot(before, [entry], { id: 'recomputed', at: at + 1 });
  assert.equal(result.score, 85);
  assert.equal(result.grade, 'A');
  assert.equal(result.dimensions.R.score, 30);
  assert.equal(result.dimensions.V.score, null);
  assert.deepEqual(result.missing, ['定制/电动或工程配套特征尚未取得依据']);
  assert.equal(result.incompleteReason, research.incomplete_reason);
  assert.deepEqual(result.checkedUrls, [source]);
  assert.deepEqual(result.target, before.target);
  const used = result.dimensions.R.facts[0];
  assert.equal(used.origin, 'manual');
  assert.equal(used.confirmationId, entry.id);
  assert.equal(used.confirmedBy, '张工');
  assert.equal(used.confirmedAt, entry.confirmedAt);
  assert.equal(used.quote, entry.evidence);
  assert.equal(used.source_url, '');
  assert.deepEqual(result.facts, before.facts, '人工事实不冒充官网研究 facts');
});

test('人工确认特征只在所选产品与方向评分，其他产品不能借分', () => {
  const result = recomputeFromSnapshot(initial(), [confirmation()], { id: 'recomputed', at });
  const materials = result.opportunities.find((item) => item.direction === 'materials');
  assert.equal(materials.dimensions.R.score, null);
  assert.equal(materials.score, 30);
  assert.equal(
    materials.facts.some((item) => item.origin === 'manual'),
    false,
  );
  assert.throws(
    () =>
      recomputeFromSnapshot(initial(), [confirmation({ product: 'unassessed product' })], {
        id: 'bad-scope',
        at,
      }),
    { status: 409 },
  );
});

test('人工补充不掩盖相反官网证据，不把冲突当作已经补齐', () => {
  const contradictory = structuredClone(research);
  contradictory.assessment_opportunities[0].facts.push(fact('installation_only', '只提供安装'));
  const before = assessCompany({
    research: contradictory,
    target: initial().target,
    at,
    id: 'contradictory',
  });
  const result = recomputeFromSnapshot(before, [confirmation()], { id: 'conflict', at });
  const finished = result.opportunities.find((item) => item.direction === 'finished');
  assert.equal(finished.dimensions.R.score, null);
  assert.equal(finished.dimensions.R.conflict, true);
  assert.ok(finished.missing.includes('同一产品的供货角色相互冲突，需核实'));
  assert.ok(finished.facts.some((item) => item.kind === 'installation_only' && !item.origin));
});

test('重复重算保留最新人工归属但不累积网点数量或篡改原输入', () => {
  const original = structuredClone(research);
  const first = confirmation({
    dimension: 'D',
    facts: [
      { kind: 'current_supply_process', value: '人工确认供货流程' },
      { kind: 'operating_outlet', value: 'Main showroom' },
    ],
  });
  const newer = { ...first, id: 'confirmation-2', confirmedBy: '李工' };
  const merged = applySupplementsToResearch(research, [first, newer]);
  assert.deepEqual(research, original);
  const manual = merged.assessment_opportunities[0].facts.filter(
    (item) => item.origin === 'manual',
  );
  assert.equal(manual.length, 2);
  assert.ok(
    manual.every((item) => item.confirmationId === newer.id && item.confirmedBy === '李工'),
  );
  const once = recomputeFromSnapshot(initial(), [first, newer], { id: 'once', at });
  const twice = recomputeFromSnapshot(once, [first, newer], { id: 'twice', at: at + 1 });
  assert.deepEqual(twice.dimensions, once.dimensions);
  assert.equal(twice.opportunities[0].facts.length, once.opportunities[0].facts.length);
});

test('新官网研究中消失的产品不会被历史人工资料重新捏造', () => {
  const updated = {
    ...research,
    assessment_opportunities: research.assessment_opportunities.slice(1),
  };
  const merged = applySupplementsToResearch(updated, [confirmation()]);
  assert.equal(merged.assessment_opportunities.length, 1);
  assert.deepEqual(merged.assessment_opportunities[0], updated.assessment_opportunities[0]);
  const snapshot = assessCompany({
    research: updated,
    target: initial().target,
    at,
    id: 'updated',
  });
  const legal = {
    ...confirmation(),
    category: 'legal_name',
    id: 'legal-2',
    content: 'Example Ltd',
  };
  const recomputed = recomputeFromSnapshot(snapshot, [confirmation(), legal], {
    id: 'updated-with-legal',
    at,
  });
  assert.equal(recomputed.opportunities.length, 1);
  assert.equal(recomputed.opportunities[0].product, 'blind fabric');
  assert.equal(recomputed.opportunities[0].dimensions.R.score, null);
});

test('经营法人和实际采购确认不参与评分，也不写为公开采购需求', () => {
  const legal = { ...confirmation(), category: 'legal_name', content: 'Example Blinds Pty Ltd' };
  const purchase = {
    ...confirmation(),
    category: 'purchase_need',
    content: '客户需要样品',
    sourceMessageId: 'message-1',
  };
  const result = recomputeFromSnapshot(initial(), [legal, purchase], { id: 'non-scoring', at });
  assert.equal(result.score, 55);
  assert.equal(result.dimensions.R.score, null);
  assert.deepEqual(result.facts, initial().facts);
  assert.equal(Object.hasOwn(result, 'purchaseDemand'), false);
});

test('只接受逐维度事实、所填证据、确认人和服务器控制的审计时间', () => {
  for (const patch of [
    { score: 100 },
    { confirmedAt: '2026-01-01' },
    { id: 'fake' },
    { expectedAssessmentId: '' },
    { evidence: ' ' },
    { confirmedBy: '' },
    { facts: [] },
    { facts: [{ kind: 'custom_made', value: '定制' }] },
    { facts: [{ kind: 'specialist_supply', value: '供货', score: 30 }] },
    { sourceUrl: 'javascript:alert(1)' },
    { sourceUrl: 'https://user:password@example.test/' },
    { sourceUrl: 'local screenshot' },
    { direction: 'retail' },
  ])
    assert.throws(() => validateSupplement(form(patch), { at }), { status: 400 });
  assert.equal(validateSupplement(form({ sourceUrl: source }), { at }).sourceUrl, source);
});

test('经营年限与日期有效，未来日期、重复事实及无沟通记录的采购需求均被拒绝', () => {
  for (const [kind, value] of [
    ['company_since', '2030'],
    ['company_since', '2026-02-31'],
    ['company_since', '2026-10-26'],
    ['company_since', '1700'],
    ['company_years', '200'],
    ['company_years', '-1'],
    ['company_years', '5 years'],
  ])
    assert.throws(
      () => validateSupplement(form({ dimension: 'D', facts: [{ kind, value }] }), { at }),
      { status: 400 },
    );
  assert.equal(
    validateSupplement(
      form({ dimension: 'D', facts: [{ kind: 'company_since', value: '2020-02-29' }] }),
      {
        at,
      },
    ).facts[0].value,
    '2020-02-29',
  );
  assert.throws(
    () => validateSupplement(form({ facts: [form().facts[0], form().facts[0]] }), { at }),
    { status: 400 },
  );
  const { dimension, facts, ...base } = form();
  assert.throws(() => validateSupplement({ ...base, category: 'purchase_need' }, { at }), {
    status: 400,
  });
  assert.equal(
    validateSupplement({ ...base, category: 'purchase_need', sourceMessageId: 'message-1' }, { at })
      .sourceMessageId,
    'message-1',
  );
  assert.equal(
    validateSupplement({ ...base, category: 'legal_name', product: '', direction: '' }, { at })
      .category,
    'legal_name',
  );
});
