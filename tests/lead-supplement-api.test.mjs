import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { assessCompany } from '../server/customer-assessment.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';
import { resolveCustomerField } from '../server/customer-fields.mjs';
import { createApp } from '../server/app.mjs';

const customerId = 'rec-supplement';
const website = 'https://buyer.example.org/';
const source = website + 'products';
const scope = 'test-base/test-table';
const fact = (kind, value = kind) => ({ kind, value, quote: value, source_url: source });

function fixture({ gradeOnly = false, potentialInput = false } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'lead-supplements-'));
  const env = {
    ACQUISITION_PROVIDER: 'native',
    FEISHU_APP_ID: 'test-app',
    FEISHU_APP_SECRET: 'test-secret',
    FEISHU_APP_TOKEN: 'test-base',
    FEISHU_TABLE_ID: 'test-table',
    ACQUISITION_DB_PATH: join(folder, 'acquisition.sqlite'),
    BATCH_DB_PATH: join(folder, 'acquisition.sqlite'),
    CONNECTIONS_PATH: join(folder, 'connections.json'),
  };
  let record = {
    record_id: customerId,
    fields: {
      公司名称: 'Buyer Blinds',
      国家: 'United States',
      企业官网: { link: website, text: website },
      来源链接: website,
      企业经营产品: 'roller blinds',
      初评结果: 'C',
      开发状态: '待开发',
      邮箱: 'buyer@buyer.example.org',
    },
  };
  const snapshot = assessCompany({
    research: {
      source_url: website,
      company_name: 'Buyer Blinds',
      entity_type: 'business',
      facts: [
        { field: 'products', value: 'roller blinds', quote: 'roller blinds', source_url: source },
      ],
      checked_urls: [source],
      assessment_opportunities: [
        {
          direction: 'finished',
          product: 'roller blinds',
          ...(potentialInput ? { relationship: 'potential_input' } : {}),
          facts: [
            fact('core_product'),
            fact('current_supply_process'),
            fact('company_since', '2009'),
          ],
        },
      ],
    },
    target: {
      product: potentialInput ? 'roller blind fabric' : 'roller blinds',
      country: 'United States',
    },
    id: 'initial-assessment',
    at: Date.now() - 60000,
  });
  let writes = 0;
  let writeMode = 'normal';
  const externalCalls = [];
  const forbidExternal = async (...args) => {
    externalCalls.push(args);
    throw new Error('Supplement must not research websites or call a model');
  };
  const definitions = [
    { field_name: '初评结果', type: 3 },
    ...(!gradeOnly
      ? ['主要供货机会', '待确认事项'].map((field_name) => ({ field_name, type: 1 }))
      : []),
  ];
  const feishu = {
    record: async (id) => {
      assert.equal(id, customerId);
      return structuredClone(record);
    },
    fields: async () => structuredClone(definitions),
    write: async (method, fields, id) => {
      assert.equal(method, 'update');
      assert.equal(id, customerId);
      const physicalFields = Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [
          resolveCustomerField(definitions, name) || name,
          value,
        ]),
      );
      assert.ok(
        Object.keys(physicalFields).every((name) =>
          definitions.some((field) => field.field_name === name),
        ),
        '精简T2只写现有列',
      );
      writes++;
      if (writeMode === 'no-commit') throw new Error('remote unavailable before commit');
      record = { ...record, fields: { ...record.fields, ...structuredClone(physicalFields) } };
      if (writeMode === 'lost-response') throw new Error('response lost after commit');
      return structuredClone(record);
    },
  };
  const open = () =>
    new NativeAcquisition({
      env,
      feishu,
      fetchImpl: forbidExternal,
      readPage: forbidExternal,
      providers: {
        web: { search: forbidExternal, extract: forbidExternal },
        model: { research: forbidExternal },
      },
    });
  let engine = open();
  engine.assessments.save(snapshot, record);
  const business = new CustomerBusiness({
    path: env.BATCH_DB_PATH,
    scope,
    customer: async (id) => ({ record_id: id, fields: {} }),
  });
  const f = {
    env,
    business,
    externalCalls,
    get engine() {
      return engine;
    },
    initial: snapshot,
    writes: () => writes,
    record: () => structuredClone(record),
    changeFields: (fields) => {
      record = { ...record, fields: { ...record.fields, ...structuredClone(fields) } };
    },
    mode: (value) => {
      writeMode = value;
    },
    lead: () => engine.decorateLeads({ leads: [mapFeishuRecord(record)] }).leads[0],
    input: (overrides = {}) => ({
      expectedAssessmentId: engine.assessments.latest(customerId)?.id || null,
      category: 'assessment',
      dimension: 'R',
      direction: 'finished',
      product: 'roller blinds',
      content: '已确认专业制造和供应卷帘',
      evidence: '电话核实：我们专业制造和供应卷帘。',
      confirmedBy: '张工',
      facts: [{ kind: 'specialist_supply', value: '专业制造和供应卷帘' }],
      ...overrides,
    }),
    save: (input, key = 'supplement-0001') =>
      engine.supplementRecord(customerId, input, key, business),
    restart: () => {
      engine.close();
      engine = open();
    },
    dispose: ({ engineClosed = false } = {}) => {
      if (!engineClosed) engine.close();
      business.close();
      rmSync(folder, { recursive: true, force: true });
    },
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/auth/v3/tenant_access_token/internal'))
        return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 3600 });
      if (path.endsWith('/records'))
        return Response.json({ code: 0, data: { items: [record], has_more: false } });
      if (path.endsWith('/records/' + customerId))
        return Response.json({ code: 0, data: { record } });
      if (path.endsWith('/fields'))
        return Response.json({ code: 0, data: { items: definitions, has_more: false } });
      return forbidExternal(url, options);
    },
  };
  f.message = async ({ customer = customerId, channel = 'email', ...overrides } = {}) => {
    const conversation = await business.saveConversation({
      customerId: customer,
      title: '实际采购沟通',
      channel,
      account: channel === 'email' ? 'sales@our.example.org' : '',
      participant: '采购负责人',
    });
    return business.saveMessage({
      customerId: customer,
      conversationId: conversation.id,
      channel,
      account: conversation.account || 'sales@our.example.org',
      direction: 'inbound',
      from: 'buyer@buyer.example.org',
      to: 'sales@our.example.org',
      occurredAt: new Date().toISOString(),
      deliveryStatus: 'received',
      classification: 'normal',
      body: 'We need 300 roller blinds with motorized controls.',
      actualConfirmed: true,
      ...overrides,
    });
  };
  return f;
}

test('补齐R和V按规则55→85→95，缺项逐项清除，人工证据与官网证据分开且重启保留', async () => {
  const f = fixture();
  try {
    assert.equal(f.lead().score, 55);
    const r = await f.save(f.input());
    assert.equal(r.lead.score, 85);
    assert.equal(r.lead.grade, 'A');
    assert.equal(r.lead.assessment.dimensions.R.score, 30);
    assert.equal(r.lead.assessment.dimensions.V.score, null);
    assert.deepEqual(r.lead.assessment.missing, ['定制/电动或工程配套特征尚未取得依据']);
    assert.ok(!r.lead.pendingQuestions.includes('该品类经营角色尚未取得充分依据'));
    assert.equal(r.lead.confirmations[0].content, '已确认专业制造和供应卷帘');
    assert.equal(r.lead.confirmations[0].product, 'roller blinds');
    assert.equal(r.lead.confirmations[0].evidence, '电话核实：我们专业制造和供应卷帘。');
    assert.equal(r.lead.confirmations[0].confirmedBy, '张工');
    assert.ok(Number.isFinite(Date.parse(r.lead.confirmations[0].confirmedAt)));
    assert.equal(r.lead.assessment.dimensions.R.facts[0].origin, 'manual');
    assert.ok(r.lead.facts.every((item) => item.origin !== 'manual'));
    const v = await f.save(
      f.input({
        dimension: 'V',
        content: '支持按尺寸定制和电动控制',
        evidence: '来信确认支持定制及电机系统。',
        facts: [
          { kind: 'custom_made', value: '按尺寸定制' },
          { kind: 'motorized_system', value: '电机控制系统' },
        ],
      }),
      'supplement-0002',
    );
    assert.equal(v.lead.score, 95);
    assert.equal(v.lead.assessment.complete, true);
    assert.deepEqual(v.lead.assessment.missing, []);
    assert.equal(v.lead.pendingQuestions, '');
    assert.equal(f.record().fields.待确认事项, '');
    assert.equal(f.record().fields.画像JSON, undefined);
    assert.equal(f.record().fields.评级依据, undefined);
    const beforeRestart = f.lead();
    f.restart();
    const refreshed = f.lead();
    assert.equal(refreshed.score, 95);
    assert.deepEqual(refreshed.confirmations, beforeRestart.confirmations);
    assert.deepEqual(refreshed.assessment.dimensions, beforeRestart.assessment.dimensions);
    assert.equal(refreshed.status, beforeRestart.status);
    assert.equal(f.writes(), 2);
    assert.deepEqual(f.externalCalls, []);
  } finally {
    f.dispose();
  }
});

test('幂等重试不重复写入，变更相同编号内容、旧版本及错误产品均被拒绝', async () => {
  const f = fixture();
  try {
    const input = f.input();
    const first = await f.save(input);
    const again = await f.save(input);
    assert.equal(again.confirmation.id, first.confirmation.id);
    assert.equal(f.writes(), 1);
    await assert.rejects(() => f.save({ ...input, content: '复用编号改写' }), { status: 409 });
    await assert.rejects(() => f.save(input, 'different-save-key'), { status: 409 });
    await assert.rejects(
      () => f.save(f.input({ product: 'unassessed fabric' }), 'wrong-product-key'),
      { status: 409 },
    );
    assert.equal(f.writes(), 1);
    assert.equal(f.lead().confirmations.length, 1);
    assert.deepEqual(f.externalCalls, []);
  } finally {
    f.dispose();
  }
});

test('人工确认后官网研究失败沿用此前完整事实和人工依据，保持85分及原官网取证时间', async () => {
  const f = fixture();
  try {
    const websiteResearchTime = Date.parse('2026-10-24T02:00:00Z');
    f.changeFields({ 最近研究时间: websiteResearchTime });
    const confirmed = await f.save(f.input());
    const originalFacts = structuredClone(f.engine.assessments.latest(customerId).facts);
    const roleFact = structuredClone(confirmed.lead.assessment.dimensions.R.facts[0]);
    assert.equal(confirmed.lead.score, 85);
    const input = { product: 'roller blinds', country: 'United States', audience: 'BC' };
    const item = {
      source_url: website,
      target_record_id: customerId,
      operation_id: 'failed-website-after-manual',
    };
    const { operation } = f.engine.store.begin(item.operation_id, { input, item });
    operation.stage = 'research';
    f.engine.store.save(operation);
    const result = await f.engine.persistIncompleteAssessment(
      operation,
      input,
      item,
      '官网暂时无法访问',
      [source],
    );
    assert.equal(result.outcome, 'completed');
    assert.equal(result.更新, 1);
    assert.equal(result.assessment.score, 85);
    const refreshed = f.lead();
    assert.equal(refreshed.score, 85);
    assert.equal(refreshed.grade, 'A');
    assert.equal(refreshed.assessment.dimensions.P.score, 40);
    assert.equal(refreshed.assessment.dimensions.D.score, 15);
    assert.equal(refreshed.assessment.dimensions.R.score, 30);
    assert.equal(refreshed.assessment.dimensions.V.score, null);
    assert.deepEqual(refreshed.assessment.dimensions.R.facts[0], roleFact);
    assert.equal(refreshed.confirmations[0].id, confirmed.confirmation.id);
    assert.deepEqual(f.engine.assessments.latest(customerId).facts, originalFacts);
    assert.ok(refreshed.facts.every((fact) => fact.origin !== 'manual'));
    assert.match(refreshed.assessment.incompleteReason, /沿用此前官网证据与人工确认资料/);
    assert.match(refreshed.assessment.incompleteReason, /官网暂时无法访问/);
    assert.equal(f.record().fields.最近研究时间, websiteResearchTime);
    assert.equal(refreshed.updatedAt, confirmed.lead.updatedAt);
    assert.equal(
      Object.hasOwn(f.engine.store.get(item.operation_id).fields, '最近研究时间'),
      false,
    );
    assert.equal(f.engine.store.get(item.operation_id).state, 'completed');
    assert.deepEqual(f.externalCalls, []);
    f.restart();
    assert.equal(f.lead().score, 85);
    assert.equal(f.lead().confirmations[0].id, confirmed.confirmation.id);
    assert.equal(f.record().fields.最近研究时间, websiteResearchTime);
  } finally {
    f.dispose();
  }
});

test('远端提交后响应丢失通过读回确认；未提交时不激活事实，同编号重试可恢复', async () => {
  for (const mode of ['lost-response', 'no-commit']) {
    const f = fixture();
    try {
      f.mode(mode);
      const input = f.input();
      if (mode === 'lost-response') {
        const result = await f.save(input);
        assert.equal(result.lead.score, 85);
        assert.equal(f.writes(), 1);
      } else {
        await assert.rejects(() => f.save(input), { status: 502 });
        assert.equal(f.lead().score, 55);
        assert.deepEqual(f.lead().confirmations, []);
        assert.equal(f.record().fields.初评结果, 'C');
        f.restart();
        assert.equal(f.lead().score, 55);
        f.mode('normal');
        const restored = await f.save(input);
        assert.equal(restored.lead.score, 85);
        assert.equal(restored.lead.confirmations.length, 1);
        assert.equal(f.writes(), 2);
      }
      const before = f.writes();
      await f.save(input);
      assert.equal(f.writes(), before);
      assert.deepEqual(f.externalCalls, []);
    } finally {
      f.dispose();
    }
  }
});

test('仅初评结果一列的精简T2仍能补资料，资料历史按客户表隔离', async () => {
  const f = fixture({ gradeOnly: true });
  try {
    const result = await f.save(f.input());
    assert.equal(result.lead.score, 85);
    assert.equal(f.record().fields.初评结果, 'A');
    assert.equal(f.record().fields.待确认事项, undefined);
    assert.equal(result.lead.confirmations.length, 1);
    const foreign = new NativeAcquisition({
      env: { ...f.env, FEISHU_TABLE_ID: 'other-table' },
      fetchImpl: async () => {
        throw new Error('No external calls');
      },
    });
    try {
      assert.deepEqual(foreign.supplements.confirmations(customerId, website), []);
    } finally {
      foreign.close();
    }
    assert.deepEqual(f.externalCalls, []);
  } finally {
    f.dispose();
  }
});

test('待核对保存遇到远端字段变化或新评估时停止覆盖，保留尝试审计并允许重新补充', async () => {
  for (const conflict of ['remote-fields', 'new-assessment']) {
    const f = fixture();
    try {
      f.mode('no-commit');
      const input = f.input();
      await assert.rejects(() => f.save(input, 'pending-save-key'), { status: 502 });
      const pending = f.engine.supplements.pending(customerId);
      assert.equal(pending.state, 'prepared');
      assert.equal(pending.confirmation.confirmedBy, '张工');
      if (conflict === 'remote-fields') f.changeFields({ 初评结果: 'B' });
      else
        f.engine.assessments.save(
          {
            ...f.initial,
            id: 'newer-automatic-assessment',
            evaluatedAt: new Date(Date.now() + 1000).toISOString(),
          },
          f.record(),
        );
      f.mode('normal');
      await assert.rejects(() => f.save(input, 'pending-save-key'), { status: 409 });
      assert.equal(f.writes(), 1, '旧保存不覆盖新字段或新评估');
      assert.deepEqual(f.lead().confirmations, []);
      assert.equal(f.engine.supplements.get(pending.id).state, 'superseded');
      assert.equal(f.engine.supplements.pending(customerId), null);
      const result = await f.save(f.input(), 'reviewed-new-save');
      assert.equal(result.lead.score, 85);
      assert.equal(result.lead.confirmations.length, 1);
      assert.equal(f.writes(), 2);
      assert.deepEqual(f.externalCalls, []);
    } finally {
      f.dispose();
    }
  }
});

test('法人和实际采购确认更新档案，采购依据必须来自同客户的真实来信或电话原文', async () => {
  const f = fixture();
  try {
    const source = await f.message();
    const wrongCustomer = await f.message({ customer: 'other-customer' });
    const outbound = await f.message({
      direction: 'outbound',
      deliveryStatus: 'sent',
      from: 'sales@our.example.org',
      to: 'buyer@buyer.example.org',
    });
    const automatic = await f.message({ classification: 'auto_reply' });
    const complaint = await f.message({ classification: 'complaint' });
    const notActual = { ...source, id: 'not-actual-message', actualConfirmed: false };
    f.business.put('messages', notActual);
    const purchase = (message, overrides = {}) => {
      const { facts, dimension, ...body } = f.input();
      return {
        ...body,
        category: 'purchase_need',
        content: '确认采购300套电动卷帘',
        sourceMessageId: message.id,
        evidence: '300 roller blinds with motorized controls',
        ...overrides,
      };
    };
    for (const [index, message] of [
      wrongCustomer,
      outbound,
      automatic,
      complaint,
      notActual,
    ].entries())
      await assert.rejects(() => f.save(purchase(message), 'rejected-purchase-' + index), {
        status: 400,
      });
    await assert.rejects(
      () => f.save(purchase(source, { evidence: '并不存在的来信原文' }), 'bad-evidence-key'),
      { status: 400 },
    );
    assert.equal(f.writes(), 0);
    const accepted = await f.save(purchase(source), 'actual-purchase-key');
    assert.equal(accepted.lead.manualPurchaseNeed, '确认采购300套电动卷帘');
    assert.equal(accepted.lead.score, 55);
    assert.equal(accepted.lead.confirmations[0].sourceMessageId, source.id);
    assert.equal(f.record().fields.公开采购需求, undefined);
    assert.deepEqual(f.business.view().demands, [], '补充档案不凭空创建业务需求记录');
    const { dimension, facts, ...legal } = f.input();
    const result = await f.save(
      {
        ...legal,
        category: 'legal_name',
        content: 'Buyer Blinds LLC',
        evidence: '登记证已核对，法人全称 Buyer Blinds LLC',
        product: '',
        direction: '',
      },
      'legal-confirm-key',
    );
    assert.equal(result.lead.companyIdentity.legal_name, 'Buyer Blinds LLC');
    assert.equal(result.lead.companyIdentity.status, 'legal_name_manual_confirmed');
    assert.equal(result.lead.manualPurchaseNeed, accepted.lead.manualPurchaseNeed);
    assert.equal(result.lead.score, 55);
    f.restart();
    assert.equal(f.lead().companyIdentity.legal_name, 'Buyer Blinds LLC');
    assert.equal(f.lead().confirmations.length, 2);
    assert.deepEqual(f.externalCalls, []);
  } finally {
    f.dispose();
  }
});

test('人工采购确认只清除对应材料产品的采购缺项，普通备注不能代替评分或主体/需求确认', async () => {
  const f = fixture({ potentialInput: true });
  try {
    const note = f.engine.assessments.latest(customerId).supplyOpportunity.note;
    const scoringMissing = f.lead().assessment.missing.filter((item) => item !== note);
    const { dimension, facts, ...profile } = f.input();
    for (const [index, pendingItem] of [
      ...scoringMissing,
      '经营法人名称待核实',
      '具体采购需求待确认',
      note,
    ].entries()) {
      await assert.rejects(
        () => f.save({ ...profile, category: 'profile', pendingItem }, 'invalid-profile-' + index),
        { status: 400 },
      );
    }
    assert.equal(f.writes(), 0);
    const message = await f.message({
      body: 'We need roller blinds now and will need 500m roller blind fabric.',
    });
    const purchase = {
      ...profile,
      category: 'purchase_need',
      pendingItem: note,
      sourceMessageId: message.id,
      evidence: 'We need roller blinds now',
      content: '已确认卷帘采购',
    };
    const wrongScope = await f.save(purchase, 'finished-purchase-key');
    assert.ok(wrongScope.lead.assessment.missing.includes(note));
    assert.ok(wrongScope.lead.pendingQuestions.includes(note));
    const rightScope = await f.save(
      {
        ...purchase,
        expectedAssessmentId: wrongScope.lead.assessment.id,
        direction: 'materials',
        product: 'roller blind fabric',
        content: '确认需要500米卷帘面料',
        evidence: 'will need 500m roller blind fabric',
      },
      'fabric-purchase-key',
    );
    assert.equal(rightScope.lead.score, 55);
    assert.deepEqual(rightScope.lead.assessment.missing, scoringMissing);
    assert.ok(!rightScope.lead.pendingQuestions.includes(note));
    assert.equal(
      f.engine.assessments.latest(customerId).supplyOpportunity.procurementStatus,
      'confirmed',
    );
    assert.equal(f.record().fields.公开采购需求, undefined);
    assert.deepEqual(f.externalCalls, []);
  } finally {
    f.dispose();
  }
});

test('采购确认接受真实电话纪要，保留引用原文与沟通关联', async () => {
  const f = fixture();
  try {
    const phone = await f.message({
      channel: 'phone',
      direction: 'note',
      deliveryStatus: 'recorded',
      body: '电话记录：客户确认需要200套卷帘。',
    });
    const { facts, dimension, ...input } = f.input();
    const result = await f.save({
      ...input,
      category: 'purchase_need',
      sourceMessageId: phone.id,
      content: '确认需要200套卷帘',
      evidence: '客户确认需要200套卷帘',
    });
    assert.equal(result.lead.manualPurchaseNeed, '确认需要200套卷帘');
    assert.equal(result.confirmation.sourceMessageId, phone.id);
    assert.equal(result.confirmation.evidence, '客户确认需要200套卷帘');
    assert.equal(result.lead.score, 55);
    assert.deepEqual(f.externalCalls, []);
  } finally {
    f.dispose();
  }
});

test('实际HTTP补充入口验证保存编号和跨站请求，保存及刷新使用后台当前快照', async () => {
  const f = fixture();
  const app = createApp({ env: f.env, fetchImpl: f.fetchImpl, nativeImpl: f.engine });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (body, headers = {}) =>
    fetch(base + `/api/v1/leads/real/${customerId}/supplements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  try {
    const input = f.input();
    assert.equal((await post(input)).status, 400);
    assert.equal((await post(input, { 'Idempotency-Key': 'short' })).status, 400);
    assert.equal(
      (await post(input, { 'Idempotency-Key': 'http-save-key', Origin: 'https://foreign.example' }))
        .status,
      403,
    );
    const response = await post(input, { 'Idempotency-Key': 'http-save-key' });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const result = await response.json();
    assert.equal(result.lead.score, 85);
    const refreshed = await (await fetch(base + '/api/v1/leads/real')).json();
    assert.equal(refreshed.leads[0].score, 85);
    assert.equal(refreshed.leads[0].confirmations[0].confirmedBy, '张工');
    assert.equal(f.writes(), 1);
    assert.deepEqual(f.externalCalls, []);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    f.dispose({ engineClosed: true });
  }
});

test('HTTP可恢复原未确认表单与保存编号，核对成功后不再提供待恢复记录', async () => {
  const f = fixture();
  const app = createApp({ env: f.env, fetchImpl: f.fetchImpl, nativeImpl: f.engine });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.address().port}/api/v1/leads/real/${customerId}/supplements`;
  const post = (input, key) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify(input),
    });
  try {
    const input = f.input();
    f.mode('no-commit');
    assert.equal((await post(input, 'recovery-original-key')).status, 502);
    const { pending } = await (await fetch(url)).json();
    assert.equal(pending.key, 'recovery-original-key');
    assert.deepEqual(pending.input, input);
    assert.equal(f.lead().score, 55);
    f.mode('normal');
    const saved = await post(pending.input, pending.key);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).lead.score, 85);
    assert.deepEqual(await (await fetch(url)).json(), { pending: null });
    assert.equal(f.writes(), 2);
    assert.deepEqual(f.externalCalls, []);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    f.dispose({ engineClosed: true });
  }
});
