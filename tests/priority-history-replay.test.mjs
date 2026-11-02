import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCompanyResearch } from '../server/company-research.mjs';
import { assessCompany } from '../server/customer-assessment.mjs';
import { assessmentSummaryFields } from '../server/customer-fields.mjs';
import { planPriorityHistoryReplay } from '../server/priority-history-replay.mjs';

const scope = 'base/customers';
const site = 'https://example-screens.test/';
const text =
  'Example Screens sells zip screens to dealers in the United States. We supply custom zip screens to trade customers.';
const target = { product: 'zip screens', country: 'United States', audience: 'B' };
const fact = (value) => ({ value, quote: text, source_url: site });

function fixture({ productKind = 'core_product', roleKind = 'specialist_supply' } = {}) {
  const page = { source_url: site, research_pages: [{ source_url: site, text }] };
  const response = {
    status: 'completed',
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({
              company_name: fact('Example Screens'),
              entity_type: fact('business'),
              actual_country: fact('United States'),
              products: [fact('zip screens')],
              assessment_opportunities: [
                {
                  direction: 'finished',
                  product: 'zip screens',
                  facts: [
                    { kind: productKind, value: 'zip screens', quote: text, source_url: site },
                    { kind: roleKind, value: 'supplies dealers', quote: text, source_url: site },
                  ],
                },
              ],
            }),
          },
        ],
      },
    ],
  };
  const research = parseCompanyResearch(response, page, target);
  const prior = assessCompany({
    research,
    target,
    id: 'old-assessment',
    at: Date.parse('2026-10-01T00:00:00Z'),
  });
  const old = {
    ...prior,
    ruleVersion: 'acquisition-v3.2',
    grade: 'B',
    status: '可开发',
    missing: ['持续经营资料不足'],
    reason: '旧规则评级依据',
  };
  const entry = { id: old.id, recordId: 'rec-example', snapshot: old };
  const operation = {
    id: 'operation-example',
    scope,
    state: 'completed',
    action: 'insert',
    stage: 'assessment',
    recordId: entry.recordId,
    source_url: site,
    input: { input: target, item: { source_url: site } },
    research_pages: page.research_pages,
    research_response: response,
    assessment: old,
    output: { outcome: 'completed', assessment: { id: old.id } },
  };
  const lead = {
    id: entry.recordId,
    name: 'Example Screens',
    website: site,
    grade: old.grade,
    ratingReason: old.reason,
    assessment: { id: old.id },
    fields: {
      初评结果: old.grade,
      主要供货机会: assessmentSummaryFields(old)['主要供货机会'],
      待确认事项: '持续经营资料不足',
    },
  };
  const record = {
    record_id: lead.id,
    fields: { ...lead.fields, 企业官网: site, 公司名称: 'Example Screens' },
  };
  return { operation, entry, lead, record, scope };
}

test('按原始官网证据重放旧 B 级，主营与供货角色同向证实为高优先', () => {
  const plan = planPriorityHistoryReplay(fixture());
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.snapshot.ruleVersion, 'acquisition-v4.0');
  assert.equal(plan.snapshot.grade, '高优先');
  assert.equal(plan.snapshot.matchLevel, '明确匹配');
  assert.equal(plan.fields['初评结果'], '高优先');
  assert.equal(plan.fields['待确认事项'], '');
  assert.equal(plan.fields['评级依据'], undefined);
  assert.ok(plan.snapshot.prioritySignals.some((signal) => signal.kind === 'core_product'));
  assert.equal(plan.snapshot.id, planPriorityHistoryReplay(fixture()).snapshot.id);
});

test('旧 B 级不能映射等级，副线即使有供货角色也归常规开发', () => {
  const plan = planPriorityHistoryReplay(fixture({ productKind: 'secondary_product' }));
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.snapshot.grade, '常规开发');
});

test('现有客户证据不足时只迁为待核实，不进入自动开发优先级', () => {
  const base = fixture();
  const content = base.operation.research_response.output[0].content[0];
  const raw = JSON.parse(content.text);
  raw.products = [];
  raw.assessment_opportunities = [];
  content.text = JSON.stringify(raw);
  const plan = planPriorityHistoryReplay(base);
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.snapshot.grade, null);
  assert.equal(plan.snapshot.status, '待核实');
  assert.equal(plan.snapshot.matchLevel, '待核实');
  assert.equal(plan.fields['初评结果'], '待核实');
});

test('旧待核实客户缺原始响应且从无事实时，只生成说明证据缺失的待核实快照', () => {
  const base = fixture();
  const old = {
    ...assessCompany({
      research: {
        source_url: site,
        company_name: 'Example Screens',
        entity_type: 'unknown',
        facts: [],
        assessment_opportunities: [],
        incomplete_reason: '旧研究中断',
      },
      target,
      id: 'old-assessment',
      at: Date.parse('2026-10-01T00:00:00Z'),
    }),
    ruleVersion: 'acquisition-v3.2',
    reason: '旧规则待核实依据',
  };
  base.entry.snapshot = old;
  old.companyName = null;
  base.operation.assessment = old;
  base.operation.research_response = null;
  base.operation.research_pages = undefined;
  base.operation.research = {
    source_url: site,
    entity_type: 'unknown',
    incomplete_reason: '旧研究中断',
    facts: [],
    assessment_opportunities: [],
  };
  base.lead.grade = '待核实';
  base.lead.ratingReason = old.reason;
  base.lead.fields = { 初评结果: '待核实', 主要供货机会: '', 待确认事项: '研究限制：旧研究中断' };
  base.record.fields = { ...base.lead.fields, 企业官网: site, 公司名称: base.lead.name };
  const plan = planPriorityHistoryReplay(base);
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.snapshot.grade, null);
  assert.equal(plan.snapshot.status, '待核实');
  assert.equal(plan.snapshot.matchLevel, '待核实');
  assert.equal(plan.snapshot.entityType, 'unknown');
  assert.deepEqual(plan.snapshot.facts, []);
  assert.deepEqual(plan.snapshot.opportunities, []);
  assert.equal(plan.snapshot.incompleteReason, '历史研究缺少可复核原始响应');
  assert.equal(plan.fields['初评结果'], '待核实');
  assert.equal(plan.fields['待确认事项'], '');
  old.facts.push({ kind: 'core_product', value: 'zip screens', quote: text, source_url: site });
  assert.equal(planPriorityHistoryReplay(base).reason, 'source_incomplete');
});

test('当前证据明确产品不匹配或主体非企业时仍跳过', () => {
  for (const mismatch of ['product', 'entity']) {
    const base = fixture();
    const content = base.operation.research_response.output[0].content[0];
    const raw = JSON.parse(content.text);
    const sentence =
      mismatch === 'product'
        ? 'We sell camping tents to households.'
        : 'I am an individual homeowner shopping for my own home.';
    base.operation.research_pages[0].text += ' ' + sentence;
    if (mismatch === 'product')
      raw.products = [{ value: 'camping tents', quote: sentence, source_url: site }];
    else raw.entity_type = { value: 'individual', quote: sentence, source_url: site };
    content.text = JSON.stringify(raw);
    assert.equal(planPriorityHistoryReplay(base).reason, 'evidence_requires_review');
  }
});

test('已有评级依据字段时同步新版依据，保留原研究时间', () => {
  const base = fixture();
  base.lead.fields['评级依据'] = base.entry.snapshot.reason;
  base.record.fields['评级依据'] = base.entry.snapshot.reason;
  const plan = planPriorityHistoryReplay(base);
  assert.equal(plan.ok, true, plan.reason);
  assert.equal(plan.fields['评级依据'], plan.snapshot.reason);
  assert.equal(plan.fields['最近研究时间'], undefined);
});

test('手工改级、待确认备注、远端字段变更和客户主体变化均跳过', () => {
  const base = fixture();
  for (const changed of [
    { ...base, lead: { ...base.lead, grade: 'A' } },
    {
      ...base,
      lead: { ...base.lead, fields: { ...base.lead.fields, 待确认事项: '销售人工备注' } },
    },
    { ...base, record: { ...base.record, fields: { ...base.record.fields, 初评结果: 'A' } } },
  ])
    assert.equal(planPriorityHistoryReplay(changed).reason, 'manual_override_or_changed_fields');
  assert.equal(
    planPriorityHistoryReplay({ ...base, lead: { ...base.lead, website: 'https://other.test/' } })
      .reason,
    'identity_or_target_changed',
  );
  assert.equal(
    planPriorityHistoryReplay({ ...base, lead: { ...base.lead, name: 'Renamed Screens' } }).reason,
    'identity_or_target_changed',
  );
  assert.equal(
    planPriorityHistoryReplay({
      ...base,
      record: { ...base.record, fields: { ...base.record.fields, 公司名称: 'Renamed Screens' } },
    }).reason,
    'identity_or_target_changed',
  );
});

test('原始响应缺失、旧评估编号不符或新版评估均不重放', () => {
  const base = fixture();
  for (const changed of [
    { ...base, operation: { ...base.operation, research_response: null } },
    {
      ...base,
      operation: { ...base.operation, assessment: { ...base.operation.assessment, id: 'other' } },
    },
    {
      ...base,
      entry: {
        ...base.entry,
        snapshot: { ...base.entry.snapshot, ruleVersion: 'acquisition-v4.0' },
      },
    },
    {
      ...base,
      entry: { ...base.entry, snapshot: { ...base.entry.snapshot, evaluatedAt: 'bad-date' } },
    },
  ])
    assert.equal(planPriorityHistoryReplay(changed).reason, 'source_incomplete');
});
