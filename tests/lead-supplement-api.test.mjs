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

function fixture({ gradeOnly = false, potentialInput = false, mirrorFields = false } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'lead-supplements-'));
  const env = {
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
      初评结果: 'B',
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
    ...(mirrorFields
      ? ['评级依据摘要', '开发状态', '最近联系时间', '最近回复时间'].map((field_name) => ({
          field_name,
          type: 1,
        }))
      : []),
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
      assert.deepEqual(externalCalls, []);
    },
    fetchImpl: async (url, options = {}) => {
      const path = new URL(url).pathname;
      if (path.endsWith('/tables'))
        return Response.json({ code: 0, data: { items: [], has_more: false } });
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

test('人工核实角色可提升优先级，V 未知不形成补档任务，证据重启后保留', async () => {
  const f = fixture();
  try {
    assert.equal(f.lead().score, 55);
    const r = await f.save(f.input());
    assert.equal(r.lead.score, 85);
    assert.equal(r.lead.grade, 'A');
    assert.equal(r.lead.assessment.dimensions.R.score, 30);
    assert.equal(r.lead.assessment.dimensions.V.score, null);
    assert.deepEqual(r.lead.assessment.missing, []);
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
    assert.equal(f.writes(), 1, 'V 事实留在本地快照，优先级未变无需再写飞书');
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
    const input = { product: 'roller blinds', country: 'United States' };
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
        assert.equal(f.record().fields.初评结果, 'B');
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
      if (conflict === 'remote-fields') f.changeFields({ 初评结果: 'C' });
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
    } finally {
      f.dispose();
    }
  }
});

test('实际HTTP补充入口验证保存编号和跨站请求，保存及刷新使用后台当前快照', async () => {
  const f = fixture({ mirrorFields: true });
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
    assert.equal(f.writes(), 0);
    await fetch(base + '/api/v1/business/sync', { method: 'POST' });
    assert.equal(f.writes(), 1);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    f.dispose({ engineClosed: true });
  }
});

test('HTTP补充先完成本地保存，飞书失败不要求重填表单，恢复后继续同步', async () => {
  const f = fixture({ mirrorFields: true });
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
    const remoteBefore = f.record();
    f.mode('no-commit');
    const saved = await post(input, 'recovery-original-key');
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).lead.score, 85);
    assert.deepEqual(await (await fetch(url)).json(), { pending: null });
    const sync = () =>
      fetch(`http://127.0.0.1:${app.address().port}/api/v1/business/sync`, { method: 'POST' });
    await sync();
    const libraryUrl = `http://127.0.0.1:${app.address().port}/api/v1/leads/real`;
    const local = await (await fetch(libraryUrl)).json();
    assert.equal(local.leads[0].score, 85);
    assert.equal(local.sync.pendingWrites, 1);
    assert.deepEqual(f.record(), remoteBefore);
    f.mode('normal');
    await sync();
    const synced = await (await fetch(libraryUrl + '/refresh', { method: 'POST' })).json();
    assert.equal(synced.sync.pendingWrites, 0);
    assert.equal(synced.leads[0].score, 85);
    assert.deepEqual(await (await fetch(url)).json(), { pending: null });
    assert.equal(f.writes(), 2);
  } finally {
    await new Promise((resolve) => app.close(resolve));
    f.dispose({ engineClosed: true });
  }
});

test('手工采购确认退役，法人确认仍可保存并重启读取', async () => {
  const f = fixture();
  try {
    const { dimension, facts, ...body } = f.input();
    await assert.rejects(() => f.save({ ...body, category: 'purchase_need' }, 'retired-purchase'), {
      status: 400,
    });
    assert.equal(f.writes(), 0);
    const result = await f.save(
      {
        ...body,
        category: 'legal_name',
        content: 'Buyer Blinds LLC',
        evidence: '登记证已核对，法人全称 Buyer Blinds LLC',
        product: '',
        direction: '',
      },
      'legal-confirm-key',
    );
    assert.equal(result.lead.companyIdentity.legal_name, 'Buyer Blinds LLC');
    f.restart();
    assert.equal(f.lead().companyIdentity.legal_name, 'Buyer Blinds LLC');
  } finally {
    f.dispose();
  }
});
