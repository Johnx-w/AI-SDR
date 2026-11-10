import { CustomerBusiness } from '../server/customer-business.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { BUSINESS_TABLES, buildBusinessTableFields } from '../server/customer-business-feishu.mjs';
import { PRODUCT_KNOWLEDGE_FEISHU_FIELDS } from '../server/product-knowledge-feishu.mjs';

const ids = { customers: 't2', products: 't5', demands: 't1', messages: 't3', tasks: 't4' };
const ok = (data) => Response.json({ code: 0, data });
const time = (offset = 0) => new Date(Date.now() + offset).toISOString();
const beforeTime = time(-60000);

function remoteFixture() {
  const tables = [
    { table_id: 't2', name: 'T2 客户主表' },
    { table_id: 't5', name: 'T5 产品资料库' },
    ...Object.entries(BUSINESS_TABLES).map(([key, value]) => ({
      table_id: ids[key],
      name: value.name,
    })),
  ];
  const fields = new Map([
    [
      't2',
      ['公司名称', '企业官网', '来源链接', '初评结果', '开发状态'].map((field_name, index) => ({
        field_name,
        type: 1,
        field_id: 'c' + index,
      })),
    ],
    [
      't5',
      PRODUCT_KNOWLEDGE_FEISHU_FIELDS.map((field, index) => ({
        ...structuredClone(field),
        field_id: 'p' + index,
      })),
    ],
    ...Object.entries(buildBusinessTableFields(ids)).map(([key, definitions]) => [
      ids[key],
      definitions.map((field, index) => ({ ...structuredClone(field), field_id: key + index })),
    ]),
  ]);
  const records = new Map([
    [
      't2',
      [1, 2].map((number) => ({
        record_id: 'customer-' + number,
        fields: {
          公司名称: 'Customer ' + number,
          企业官网: 'https://buyer' + number + '.example.org/',
          初评结果: 'A',
          开发状态: '待开发',
        },
      })),
    ],
    ['t5', []],
    ['t1', []],
    ['t3', []],
    ['t4', []],
  ]);
  const calls = [],
    writes = [],
    state = { businessUnavailable: false };
  const fetchImpl = async (url, init = {}) => {
    const endpoint = new URL(String(url));
    assert.equal(
      endpoint.origin,
      'https://open.feishu.cn',
      'HTTP tests must not access external services',
    );
    calls.push({ path: endpoint.pathname, method: init.method || 'GET' });
    if (endpoint.pathname.endsWith('/auth/v3/tenant_access_token/internal'))
      return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 7200 });
    const marker = '/tables';
    const suffix = endpoint.pathname
      .slice(endpoint.pathname.indexOf(marker) + marker.length)
      .split('/')
      .filter(Boolean);
    if (!suffix.length) return ok({ items: structuredClone(tables), has_more: false });
    const [tableId, resource, recordId] = suffix;
    assert(records.has(tableId), 'Unexpected table ID in mocked Feishu');
    if (state.businessUnavailable && ['t1', 't3', 't4'].includes(tableId) && resource === 'fields')
      return Response.json({ code: 1254000, msg: 'fixture unavailable' });
    if (resource === 'fields')
      return ok({ items: structuredClone(fields.get(tableId)), has_more: false });
    assert.equal(resource, 'records');
    const method = init.method || 'GET';
    if (method === 'GET' && !recordId)
      return ok({ items: structuredClone(records.get(tableId)), has_more: false });
    if (method === 'GET') {
      const record = records.get(tableId).find((item) => item.record_id === recordId);
      return record
        ? ok({ record: structuredClone(record) })
        : Response.json({ code: 1254043, msg: 'fixture record missing' });
    }
    const body = JSON.parse(init.body);
    writes.push({
      tableId,
      recordId,
      method,
      fields: structuredClone(body.fields),
      token: endpoint.searchParams.get('client_token'),
    });
    if (method === 'POST') {
      const record = {
        record_id: tableId + '-remote-' + records.get(tableId).length,
        fields: structuredClone(body.fields),
      };
      records.get(tableId).push(record);
      return ok({ record: structuredClone(record) });
    }
    assert.equal(method, 'PUT');
    const record = records.get(tableId).find((item) => item.record_id === recordId);
    assert(record, 'Cannot update absent mock record');
    Object.assign(record.fields, structuredClone(body.fields));
    return ok({ record: structuredClone(record) });
  };
  return { tables, fields, records, calls, writes, state, fetchImpl };
}

async function serve(folder, remote) {
  const env = {
    TAVILY_API_KEY: 'fixture-search',
    DEEPSEEK_API_KEY: 'fixture-model',
    FEISHU_APP_ID: 'fixture-app-id',
    FEISHU_APP_SECRET: 'fixture-secret',
    FEISHU_APP_TOKEN: 'fixture-base',
    FEISHU_TABLE_ID: 't2',
    CONNECTIONS_PATH: join(folder, 'connections.json'),
    BATCH_DB_PATH: join(folder, 'state.sqlite'),
    PRODUCT_DB_PATH: join(folder, 'state.sqlite'),
    PRODUCT_KNOWLEDGE_DB_PATH: join(folder, 'state.sqlite'),
    CUSTOMER_BUSINESS_DB_PATH: join(folder, 'business.sqlite'),
    BUSINESS_MIRROR_JOURNAL_PATH: join(folder, 'mirror.json'),
    SCHEDULE_DB_PATH: ':memory:',
  };
  const app = createApp({
    env,
    fetchImpl: remote.fetchImpl,
    nativeImpl: { decorateLeads: (data) => data, close() {} },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port;
  return {
    async call(path = '/api/v1/business', { method = 'GET', body, key } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    },
    close: () => (app.listening ? new Promise((resolve) => app.close(resolve)) : Promise.resolve()),
  };
}

test('客户业务HTTP只读，全部旧手工维护入口返回405且不创建记录', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'business-readonly-'));
  const server = await serve(folder, remoteFixture());
  try {
    for (const kind of ['conversations', 'messages', 'demands', 'tasks']) {
      for (const method of ['POST', 'PUT']) {
        const result = await server.call('/api/v1/business/' + kind, {
          method,
          body: { customerId: 'customer-1' },
          key: 'no-manual-write',
        });
        assert.equal(result.status, 405);
      }
    }
    for (const action of ['preflight', 'action'])
      assert.equal(
        (
          await server.call('/api/v1/business/tasks/old-task/' + action, {
            method: 'POST',
            body: {},
          })
        ).status,
        405,
      );
    const result = await server.call();
    assert.equal(result.status, 200);
    assert.equal(result.body.tasks.length, 0);
    assert.equal(result.body.demands.length, 0);
  } finally {
    await server.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
test('只读任务列表过滤旧人工和MOCK，底层真实历史仍保留', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'business-history-'));
  const store = new CustomerBusiness({
    path: join(folder, 'business.sqlite'),
    scope: 'fixture-base/t2',
  });
  const base = {
    customerId: 'customer-1',
    version: 1,
    status: 'pending',
    dueAt: time(),
    productIds: [],
    demandIds: [],
    messageIds: [],
  };
  store.put('tasks', { ...base, id: 'old-manual', notes: 'MOCK', origin: 'manual' });
  store.put('tasks', { ...base, id: 'automatic', origin: 'automatic-followup' });
  store.close();
  const server = await serve(folder, remoteFixture());
  try {
    const result = await server.call();
    assert.equal(result.status, 200);
    assert.deepEqual(
      result.body.tasks.map((r) => r.id),
      ['automatic'],
    );
    assert.equal(
      (await server.call('/api/v1/business/tasks/old-manual')).body.record.notes,
      'MOCK',
    );
  } finally {
    await server.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
