import test from 'node:test';
import assert from 'node:assert/strict';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import {
  ProductKnowledgeFeishu,
  PRODUCT_KNOWLEDGE_FEISHU_FIELDS,
} from '../server/product-knowledge-feishu.mjs';

function product(overrides = {}) {
  const knowledge = new ProductKnowledge();
  try {
    return knowledge.save({
      name: '卷帘',
      englishName: 'Roller blinds',
      category: 'indoor',
      direction: 'finished',
      deliveryForms: ['成品'],
      aliases: ['roller shades'],
      specifications: '经审核规格说明',
      moq: '按项目确认',
      leadTime: '按订单确认',
      brands: ['示例品牌'],
      markets: ['United States'],
      sourceUrl: 'https://example.com/roller',
      attachments: ['https://example.com/catalog.pdf'],
      status: 'approved',
      approvedBy: '审核人',
      effectiveDate: '2026-01-01',
      notes: '内部备注',
      ...overrides,
    });
  } finally {
    knowledge.close();
  }
}

function fixture() {
  const state = {
    rows: [],
    calls: [],
    tables: [
      { table_id: 't2', name: 'T2 客户主表' },
      { table_id: 't12', name: 'T12 客户评估历史表' },
      { table_id: 't5', name: 'T5 产品资料库' },
    ],
    fields: structuredClone(PRODUCT_KNOWLEDGE_FEISHU_FIELDS),
    failWrite: '',
    corruptReadback: false,
  };
  const client = {
    async tables() {
      state.calls.push({ method: 'tables' });
      return structuredClone(state.tables);
    },
    async fields(tableId) {
      assert.equal(tableId, 't5');
      state.calls.push({ method: 'fields', tableId });
      return structuredClone(state.fields);
    },
    async records(tableId) {
      assert.equal(tableId, 't5');
      state.calls.push({ method: 'records', tableId });
      return structuredClone(state.rows);
    },
    async record(id, tableId) {
      assert.equal(tableId, 't5');
      state.calls.push({ method: 'record', tableId, id });
      const row = structuredClone(state.rows.find((item) => item.record_id === id));
      if (!row) throw new Error('Record missing');
      if (state.corruptReadback) row.fields['备注'] = 'not the saved local value';
      return row;
    },
    async write(action, fields, id, token, tableId) {
      assert.equal(tableId, 't5');
      state.calls.push({
        method: 'write',
        action,
        fields: structuredClone(fields),
        id,
        token,
        tableId,
      });
      if (state.failWrite === 'before') throw new Error('SECRET-do-not-leak');
      let row = action === 'update' ? state.rows.find((item) => item.record_id === id) : null;
      if (!row) {
        row = { record_id: 'record-' + (state.rows.length + 1), fields: {} };
        state.rows.push(row);
      }
      for (const [name, value] of Object.entries(fields)) {
        if (value === null) delete row.fields[name];
        else row.fields[name] = structuredClone(value);
      }
      if (state.failWrite === 'after') throw new Error('Lost response after committed write');
      return structuredClone(row);
    },
  };
  const mirror = new ProductKnowledgeFeishu({
    env: { FEISHU_APP_TOKEN: 'isolated-test-app' },
    client,
  });
  return { state, mirror };
}

test('T5 镜像完整创建并读回核对，再次同步不重复写入且不访问 T2/T12 记录', async () => {
  const { state, mirror } = fixture();
  const saved = product();
  assert.equal(PRODUCT_KNOWLEDGE_FEISHU_FIELDS[0].field_name, '产品编号');
  const first = await mirror.sync(saved);
  assert.equal(first.status, 'synced');
  assert.equal(first.version, saved.version);
  assert.equal(first.tableId, 't5');
  assert.equal(state.rows[0].fields['品类'], '室内成品帘');
  assert.equal(state.rows[0].fields['审核状态'], '已审核');
  assert.equal(state.rows[0].fields['审核时间'], Date.parse(saved.approvedAt));
  assert.equal(state.rows[0].fields['来源链接'].link, saved.sourceUrl);
  assert.match(
    state.calls.find((call) => call.method === 'write').token,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/u,
  );
  const second = await mirror.sync(saved);
  assert.equal(second.recordId, first.recordId);
  assert.equal(state.calls.filter((call) => call.method === 'write').length, 1);
  assert.equal(state.rows.length, 1);
  assert(state.calls.filter((call) => call.tableId).every((call) => call.tableId === 't5'));
});

test('未配置连接、未建 T5 或同名表冲突均不伪装同步成功', async () => {
  const unconfigured = new ProductKnowledgeFeishu({
    env: {},
    fetchImpl: () => {
      throw new Error('No network expected');
    },
  });
  assert.equal((await unconfigured.info()).configured, false);
  assert.equal((await unconfigured.sync(product())).status, 'not_configured');
  const { state, mirror } = fixture();
  state.tables = state.tables.filter((table) => table.table_id !== 't5');
  assert.equal((await mirror.sync(product())).status, 'not_configured');
  state.tables = [
    { table_id: 't5', name: 'T5 产品资料库' },
    { table_id: 'duplicate', name: 'T5 产品资料库' },
  ];
  assert.equal((await mirror.sync(product())).status, 'pending');
  assert.equal(state.calls.filter((call) => call.method === 'write').length, 0);
});

test('更新时显式清空旧来源、附件、规格、审核人和时间，未知值保持为空', async () => {
  const { state, mirror } = fixture();
  const saved = product();
  assert.equal((await mirror.sync(saved)).status, 'synced');
  const cleared = {
    ...saved,
    englishName: '',
    specifications: '',
    aliases: [],
    sourceUrl: '',
    attachments: [],
    moq: '',
    leadTime: '',
    brands: [],
    markets: [],
    effectiveDate: '',
    notes: '',
    status: 'draft',
    approvedBy: '',
    approvedAt: '',
    version: 2,
  };
  const result = await mirror.sync(cleared);
  assert.equal(result.status, 'synced');
  const write = state.calls.filter((call) => call.method === 'write').at(-1);
  for (const name of [
    '英文名称',
    '已核实参数',
    '产品别名',
    '来源链接',
    '附件链接',
    'MOQ',
    '常规交期',
    '适用品牌',
    '适用市场',
    '生效日期',
    '备注',
    '审核人',
    '审核时间',
  ]) {
    assert.equal(write.fields[name], null, name);
    assert.equal(state.rows[0].fields[name], undefined, name);
  }
  assert.equal(write.action, 'update');
  assert.equal(state.rows[0].fields['审核状态'], '待审核');
  assert.equal(state.rows[0].fields['资料版本'], 2);
});

test('远端写入成功但响应丢失时只读回核对，不自动再次写入', async () => {
  const { state, mirror } = fixture();
  state.failWrite = 'after';
  const saved = product();
  assert.equal((await mirror.sync(saved)).status, 'synced');
  assert.equal(state.calls.filter((call) => call.method === 'write').length, 1);
  assert.equal(state.rows.length, 1);
  assert.equal((await mirror.sync(saved)).status, 'synced');
  assert.equal(state.calls.filter((call) => call.method === 'write').length, 1);
});

test('未确认写入保留 pending，手动重试复用稳定客户端令牌且不泄漏上游错误', async () => {
  const { state, mirror } = fixture();
  state.failWrite = 'before';
  const saved = product();
  const first = await mirror.sync(saved);
  assert.equal(first.status, 'pending');
  assert(!first.error.includes('SECRET'));
  assert.equal(state.calls.filter((call) => call.method === 'write').length, 1);
  state.failWrite = '';
  const second = await mirror.sync(saved);
  assert.equal(second.status, 'synced');
  const writes = state.calls.filter((call) => call.method === 'write');
  assert.equal(writes.length, 2);
  assert.equal(writes[0].token, writes[1].token);
  assert.equal(state.rows.length, 1);
});

test('逐字段读回不一致、字段类型错误和产品编号重复时停止同步', async () => {
  const { state, mirror } = fixture();
  const saved = product();
  state.corruptReadback = true;
  assert.equal((await mirror.sync(saved)).status, 'pending');
  assert.equal(state.calls.filter((call) => call.method === 'write').length, 1);
  state.corruptReadback = false;
  state.fields.find((field) => field.field_name === 'MOQ').type = 2;
  assert.equal((await mirror.sync(saved)).status, 'pending');
  assert.equal(state.calls.filter((call) => call.method === 'write').length, 1);
  state.fields = structuredClone(PRODUCT_KNOWLEDGE_FEISHU_FIELDS);
  state.rows.push({ ...structuredClone(state.rows[0]), record_id: 'duplicate' });
  assert.equal((await mirror.sync(saved)).status, 'pending');
  assert.equal(state.calls.filter((call) => call.method === 'write').length, 1);
});

test('较旧版本同步不会覆盖已经核对的新版本', async () => {
  const { state, mirror } = fixture();
  const saved = product();
  const newer = { ...saved, version: 2, notes: '最新资料' };
  const [newResult, oldResult] = await Promise.all([mirror.sync(newer), mirror.sync(saved)]);
  assert.equal(newResult.status, 'synced');
  assert.equal(oldResult.status, 'pending');
  assert.equal(state.rows[0].fields['资料版本'], 2);
  assert.equal(state.rows[0].fields['备注'], '最新资料');
  assert.equal(state.calls.filter((call) => call.method === 'write').length, 1);
});
