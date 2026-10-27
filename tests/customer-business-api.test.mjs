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
    assert.notEqual(tableId, 't2', 'Business flow must not modify enterprise records');
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
    ACQUISITION_PROVIDER: 'native',
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

const conversationInput = (customerId = 'customer-1') => ({
  customerId,
  title: 'Product inquiry',
  channel: 'email',
  account: 'sales@example.org',
  participant: 'buyer@example.org',
});
const messageInput = (conversation, changes = {}) => ({
  customerId: conversation.customerId,
  conversationId: conversation.id,
  channel: 'email',
  direction: 'inbound',
  deliveryStatus: 'received',
  subject: 'Two products',
  body: 'We need roller blinds and outdoor zip screens.',
  from: 'buyer@example.org',
  to: 'sales@example.org',
  account: 'sales@example.org',
  occurredAt: beforeTime,
  actualConfirmed: true,
  origin: 'manual',
  externalId: 'inbound-' + conversation.id,
  ...changes,
});
const demandInput = (conversation, message, changes = {}) => ({
  customerId: conversation.customerId,
  conversationId: conversation.id,
  sourceMessageId: message.id,
  title: 'Roller blinds',
  category: 'indoor',
  direction: 'finished',
  productText: 'roller blinds',
  evidenceQuote: 'roller blinds',
  ...changes,
});
const taskInput = (conversation, demands, changes = {}) => ({
  customerId: conversation.customerId,
  conversationId: conversation.id,
  demandIds: demands.map((item) => item.id),
  title: 'Clarify specifications in one reply',
  kind: 'clarify_specs',
  channel: 'email',
  dueAt: time(3600000),
  ...changes,
});
async function create(server, kind, body, key) {
  const result = await server.call('/api/v1/business/' + kind, { method: 'POST', body, key });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert(result.body.record);
  return result.body;
}
async function basicGraph(server, { productId } = {}) {
  const conversation = (
    await create(server, 'conversations', conversationInput(), 'graph-conversation-001')
  ).record;
  const message = (
    await create(server, 'messages', messageInput(conversation), 'graph-message-001')
  ).record;
  const first = (
    await create(
      server,
      'demands',
      demandInput(conversation, message, productId ? { productIds: [productId] } : {}),
      'graph-demand-001',
    )
  ).record;
  const second = (
    await create(
      server,
      'demands',
      demandInput(conversation, message, {
        title: 'Outdoor zip screens',
        category: 'outdoor',
        productText: 'outdoor zip screens',
        evidenceQuote: 'outdoor zip screens',
      }),
      'graph-demand-002',
    )
  ).record;
  return { conversation, message, demands: [first, second] };
}

test('业务HTTP串联一封真实来信、两个需求和一个任务，关联T2/T5且可按企业和产品筛选', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'business-api-graph-'));
  const remote = remoteFixture();
  const knowledge = new ProductKnowledge(join(folder, 'state.sqlite'));
  const product = knowledge.save({
    name: '已审核卷帘',
    category: 'indoor',
    direction: 'finished',
    status: 'approved',
    sourceUrl: 'https://company.example.org/catalog',
    approvedBy: 'Johnson',
  });
  knowledge.close();
  const t2 = structuredClone(remote.records.get('t2'));
  let server;
  try {
    server = await serve(folder, remote);
    const empty = await server.call();
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.demands, []);
    assert.equal(empty.body.customers.length, 2);
    const graph = await basicGraph(server, { productId: product.id });
    const task = (
      await create(server, 'tasks', taskInput(graph.conversation, graph.demands), 'graph-task-001')
    ).record;
    const state = (await server.call()).body;
    assert.equal(state.conversations.length, 1);
    assert.equal(state.messages.length, 1);
    assert.equal(state.demands.length, 2);
    assert.equal(state.tasks.length, 1);
    assert.deepEqual(
      state.messages[0].demandIds.sort(),
      graph.demands.map((entry) => entry.id).sort(),
    );
    assert.equal(state.customerContexts[0].fixedEmail, 'sales@example.org');
    assert.deepEqual(task.productIds, [product.id]);
    assert.equal(remote.records.get('t5').length, 1);
    assert.equal(remote.records.get('t1').length, 2);
    assert.equal(remote.records.get('t3').length, 1);
    assert.equal(remote.records.get('t4').length, 1);
    assert.deepEqual(remote.records.get('t2'), t2);
    const productFilter = await server.call('/api/v1/business?productId=' + product.id);
    assert.equal(productFilter.body.demands.length, 1);
    assert.equal(productFilter.body.tasks.length, 1);
    assert.equal(productFilter.body.conversations.length, 1);
    const customerFilter = await server.call('/api/v1/business?customerId=customer-2');
    assert.deepEqual(customerFilter.body.demands, []);
    assert.deepEqual(customerFilter.body.messages, []);
    const preflight = await server.call('/api/v1/business/tasks/' + task.id + '/preflight', {
      method: 'POST',
    });
    assert.equal(preflight.status, 200);
    assert.equal(preflight.body.ready, true, JSON.stringify(preflight.body));
    assert.equal(preflight.body.automaticSend, false);
  } finally {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('新增回复暂停原跟进，完成任务必须关联同会话及全部需求的真实已发送消息', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'business-api-followup-'));
  const remote = remoteFixture();
  let server;
  try {
    server = await serve(folder, remote);
    const graph = await basicGraph(server);
    let task = (
      await create(
        server,
        'tasks',
        taskInput(graph.conversation, graph.demands),
        'followup-task-001',
      )
    ).record;
    const actionPath = '/api/v1/business/tasks/' + task.id + '/action';
    const invalid = await server.call(actionPath, {
      method: 'POST',
      body: {
        action: 'complete',
        expectedVersion: task.version,
        resultMessageId: graph.message.id,
      },
    });
    assert.equal(invalid.status, 409);
    await create(
      server,
      'messages',
      messageInput(graph.conversation, {
        externalId: 'followup-new-reply',
        body: 'Please use the revised dimensions.',
        occurredAt: time(1000),
      }),
      'followup-reply-001',
    );
    task = (await server.call('/api/v1/business/tasks/' + task.id)).body.record;
    assert.equal(task.status, 'paused');
    const blocked = await server.call('/api/v1/business/tasks/' + task.id + '/preflight', {
      method: 'POST',
    });
    assert.equal(blocked.body.ready, false);
    assert(blocked.body.reasons.some((reason) => reason.includes('客户已回复')));
    const unknown = (
      await create(
        server,
        'messages',
        messageInput(graph.conversation, {
          direction: 'outbound',
          deliveryStatus: 'unknown',
          from: 'sales@example.org',
          to: 'buyer@example.org',
          body: 'Outcome unknown',
          externalId: 'followup-unknown',
          occurredAt: time(2000),
          demandIds: graph.demands.map((demand) => demand.id),
        }),
        'followup-unknown-001',
      )
    ).record;
    assert.equal(
      (
        await server.call(actionPath, {
          method: 'POST',
          body: { action: 'complete', expectedVersion: task.version, resultMessageId: unknown.id },
        })
      ).status,
      409,
    );
    const sent = (
      await create(
        server,
        'messages',
        messageInput(graph.conversation, {
          direction: 'outbound',
          deliveryStatus: 'sent',
          from: 'sales@example.org',
          to: 'buyer@example.org',
          body: 'Please confirm specifications for both products.',
          externalId: 'followup-sent',
          occurredAt: time(3000),
          demandIds: graph.demands.map((demand) => demand.id),
        }),
        'followup-sent-001',
      )
    ).record;
    const completed = await server.call(actionPath, {
      method: 'POST',
      body: {
        action: 'complete',
        expectedVersion: task.version,
        resultMessageId: sent.id,
        notes: '已实际发出统一回复',
      },
    });
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.record.status, 'completed');
    assert.equal(completed.body.record.resultMessageId, sent.id);
    assert.equal(completed.body.feishu.status, 'synced', JSON.stringify(completed.body.feishu));
    assert(remote.records.get('t4')[0].fields['执行结果沟通'].length === 1);
    assert.match(remote.records.get('t4')[0].fields['实际执行记录'], /已实际发出统一回复/);
  } finally {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('跨企业关联、覆盖沟通原文与切换固定邮箱被HTTP拒绝，已有记录保留', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'business-api-identity-'));
  const remote = remoteFixture();
  let server;
  try {
    server = await serve(folder, remote);
    const graph = await basicGraph(server);
    const second = (
      await create(
        server,
        'conversations',
        conversationInput('customer-2'),
        'identity-conversation-002',
      )
    ).record;
    const cross = await server.call('/api/v1/business/demands', {
      method: 'POST',
      key: 'identity-cross-001',
      body: demandInput(second, graph.message),
    });
    assert.equal(cross.status, 409);
    const badTask = await server.call('/api/v1/business/tasks', {
      method: 'POST',
      key: 'identity-cross-task',
      body: taskInput(second, graph.demands),
    });
    assert.equal(badTask.status, 409);
    const message = (await server.call('/api/v1/business/messages/' + graph.message.id)).body
      .record;
    const changed = await server.call('/api/v1/business/messages', {
      method: 'PUT',
      body: { ...message, body: 'Overwritten original', expectedVersion: message.version },
    });
    assert.equal(changed.status, 409);
    const mailbox = await server.call('/api/v1/business/conversations', {
      method: 'POST',
      key: 'identity-new-mailbox',
      body: { ...conversationInput(), account: 'another@example.org' },
    });
    assert.equal(mailbox.status, 409);
    const state = (await server.call()).body;
    assert.equal(state.demands.length, 2);
    assert.equal(state.tasks.length, 0);
    assert.equal(state.messages[0].body, graph.message.body);
    assert.equal(remote.writes.filter((write) => write.tableId === 't2').length, 0);
    assert.equal(remote.writes.filter((write) => write.tableId === 't5').length, 0);
  } finally {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('新增幂等键在HTTP重放和服务重启后保持相同业务编号，不重复镜像消息', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'business-api-idempotency-'));
  const remote = remoteFixture();
  let server;
  try {
    server = await serve(folder, remote);
    const input = conversationInput();
    const first = await create(server, 'conversations', input, 'restart-conversation-001');
    const replay = await create(server, 'conversations', input, 'restart-conversation-001');
    assert.equal(replay.record.id, first.record.id);
    const conflict = await server.call('/api/v1/business/conversations', {
      method: 'POST',
      key: 'restart-conversation-001',
      body: { ...input, title: 'Different body' },
    });
    assert.equal(conflict.status, 409);
    const body = messageInput(first.record);
    const message = await create(server, 'messages', body, 'restart-message-001');
    await server.close();
    server = await serve(folder, remote);
    const after = await create(server, 'messages', body, 'restart-message-001');
    assert.equal(after.record.id, message.record.id);
    assert.equal(after.record.createdAt, message.record.createdAt);
    assert.equal((await server.call()).body.messages.length, 1);
    assert.equal(remote.records.get('t3').length, 1);
    assert.equal(
      remote.writes.filter((write) => write.tableId === 't3' && write.method === 'POST').length,
      1,
    );
  } finally {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('飞书暂不可读时HTTP仍保留本地沟通，手动重新同步不增加重复消息', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'business-api-pending-'));
  const remote = remoteFixture();
  let server;
  try {
    server = await serve(folder, remote);
    const conversation = (
      await create(server, 'conversations', conversationInput(), 'pending-conversation-001')
    ).record;
    remote.state.businessUnavailable = true;
    const saved = await create(
      server,
      'messages',
      messageInput(conversation),
      'pending-message-001',
    );
    assert.equal(saved.feishu.status, 'pending');
    assert.equal((await server.call()).body.messages[0].id, saved.record.id);
    assert.equal(remote.records.get('t3').length, 0);
    remote.state.businessUnavailable = false;
    const synchronized = await server.call('/api/v1/business/sync', { method: 'POST' });
    assert.equal(synchronized.status, 200);
    assert.equal(synchronized.body.feishu.status, 'synced', JSON.stringify(synchronized.body));
    await server.call('/api/v1/business/sync', { method: 'POST' });
    assert.equal(remote.records.get('t3').length, 1);
    assert.equal(
      remote.writes.filter((write) => write.tableId === 't3' && write.method === 'POST').length,
      1,
    );
  } finally {
    await server?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
