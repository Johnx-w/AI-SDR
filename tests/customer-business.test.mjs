import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CustomerBusiness } from '../server/customer-business.mjs';

function fixture({ path = ':memory:', scope = 'app/t2' } = {}) {
  let clock = Date.parse('2026-10-24T01:00:00.000Z');
  const customers = new Map(
    ['customer-a', 'customer-b'].map((id) => [
      id,
      { record_id: id, fields: { 初评结果: 'A', 开发状态: '待开发' } },
    ]),
  );
  const products = new Map([
    [
      'product-a',
      {
        id: 'product-a',
        name: '卷帘',
        version: 1,
        status: 'approved',
        effectiveDate: '2026-01-01',
      },
    ],
    [
      'product-b',
      { id: 'product-b', name: '户外帘', version: 1, status: 'draft', effectiveDate: '' },
    ],
  ]);
  const options = {
    path,
    scope,
    now: () => new Date(clock),
    customer: async (id) => structuredClone(customers.get(id) || null),
    product: async (id) => structuredClone(products.get(id) || null),
  };
  const f = {
    business: new CustomerBusiness(options),
    options,
    customers,
    products,
    advance: (milliseconds = 1000) => {
      clock += milliseconds;
    },
    time: () => new Date(clock).toISOString(),
    due: () => new Date(clock + 3600000).toISOString(),
  };
  f.conversation = (overrides = {}, options = {}) =>
    f.business.saveConversation(
      {
        customerId: 'customer-a',
        title: '客户采购沟通',
        channel: 'email',
        account: 'sales@our-company.test',
        participant: 'buyer@customer-a.test',
        ...overrides,
      },
      options,
    );
  f.message = (conversation, overrides = {}, options = {}) =>
    f.business.saveMessage(
      {
        customerId: conversation.customerId,
        conversationId: conversation.id,
        channel: conversation.channel,
        account: conversation.account || 'sales@our-company.test',
        direction: 'inbound',
        from: 'buyer@customer-a.test',
        to: conversation.account || 'sales@our-company.test',
        occurredAt: f.time(),
        deliveryStatus: 'received',
        classification: 'normal',
        body: 'We need roller blinds and outdoor zip screens.',
        actualConfirmed: true,
        ...overrides,
      },
      options,
    );
  f.demand = (conversation, source, overrides = {}, options = {}) =>
    f.business.saveDemand(
      {
        customerId: conversation.customerId,
        conversationId: conversation.id,
        sourceMessageId: source.id,
        title: '卷帘采购需求',
        category: 'indoor',
        direction: 'finished',
        productText: 'roller blinds',
        productIds: ['product-a'],
        evidenceQuote: 'roller blinds',
        ...overrides,
      },
      options,
    );
  return f;
}

test('一封真实来信可关联多项需求，T2 企业不重复，T5 草稿只表示待核实且跨重启持久', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'customer-business-graph-'));
  const f = fixture({ path: join(folder, 'business.sqlite') });
  try {
    assert.deepEqual(f.business.view().demands, []);
    const conversation = await f.conversation({}, { idempotencyKey: 'conversation-create-001' });
    const source = await f.message(
      conversation,
      { externalId: '<customer-inquiry-001>' },
      { idempotencyKey: 'message-create-001' },
    );
    const first = await f.demand(conversation, source, {}, { idempotencyKey: 'demand-create-001' });
    const second = await f.demand(conversation, source, {
      title: '户外帘需求',
      category: 'outdoor',
      productText: 'outdoor zip screens',
      productIds: ['product-b'],
      evidenceQuote: 'outdoor zip screens',
    });
    assert.equal(first.productReadiness, 'ready');
    assert.equal(second.productReadiness, 'pending');
    assert.deepEqual(first.productVersions, { 'product-a': 1 });
    const linked = f.business.get('messages', source.id);
    assert.deepEqual(linked.demandIds, [first.id, second.id]);
    assert.equal(linked.version, 3);
    assert.equal(f.business.view().conversations.length, 1);
    assert.equal(f.business.view().messages.length, 1);
    assert.equal(f.business.view().customerContexts.length, 1);
    assert.equal(
      (await f.demand(conversation, source, {}, { idempotencyKey: 'demand-create-001' })).id,
      first.id,
    );
    assert.equal(f.business.get('messages', source.id).version, 3);
    f.business.close();
    f.business = new CustomerBusiness(f.options);
    assert.equal(f.business.view().demands.length, 2);
    assert.equal(
      (await f.conversation({}, { idempotencyKey: 'conversation-create-001' })).id,
      conversation.id,
    );
    const filtered = f.business.view({ productId: 'product-b' });
    assert.equal(filtered.demands.length, 1);
    assert.equal(filtered.demands[0].id, second.id);
    assert.equal(filtered.messages[0].id, source.id);
    await assert.rejects(
      () =>
        f.conversation({ title: '同编号不同内容' }, { idempotencyKey: 'conversation-create-001' }),
      (error) => error.status === 409,
    );
  } finally {
    f.business.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('跨客户、未知 T2/T5 及跨客户表引用均被拒绝，潜客评级不生成询盘', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'customer-business-scope-'));
  const path = join(folder, 'business.sqlite');
  const f = fixture({ path });
  const other = fixture({ path, scope: 'different-app/t2' });
  try {
    assert.equal(f.business.view().demands.length, 0);
    const conversation = await f.conversation();
    const source = await f.message(conversation);
    await assert.rejects(
      () => f.message(conversation, { customerId: 'customer-b' }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      () => f.conversation({ customerId: 'not-in-t2' }),
      (error) => error.status === 404,
    );
    await assert.rejects(
      () => f.demand(conversation, source, { productIds: ['not-in-t5'] }),
      (error) => error.status === 404,
    );
    await assert.rejects(
      () => f.demand(conversation, source, { evidenceQuote: 'We intend to import 1000 pieces' }),
      (error) => error.status === 400,
    );
    const outward = await f.message(conversation, {
      direction: 'outbound',
      deliveryStatus: 'sent',
      from: conversation.account,
      to: conversation.participant,
    });
    await assert.rejects(
      () => f.demand(conversation, outward),
      (error) => error.status === 409,
    );
    assert.equal(f.business.view().demands.length, 0);
    assert.equal(other.business.get('conversations', conversation.id), null);
    await assert.rejects(
      () => other.message(conversation),
      (error) => error.status === 404,
    );
    const secondCustomer = await f.conversation({ customerId: 'customer-b' });
    await assert.rejects(
      () => f.demand(secondCustomer, source),
      (error) => error.status === 409,
    );
  } finally {
    f.business.close();
    other.business.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('原始消息不可覆盖，同一外部消息重放不重复且不同原文冲突', async () => {
  const f = fixture();
  try {
    const conversation = await f.conversation();
    const source = await f.message(conversation, { externalId: '<same-message>' });
    const replay = await f.message(
      conversation,
      { externalId: '<same-message>' },
      { idempotencyKey: 'duplicate-message-request' },
    );
    assert.equal(replay.id, source.id);
    assert.equal(f.business.view().messages.length, 1);
    await assert.rejects(
      () =>
        f.message(conversation, {
          externalId: '<same-message>',
          body: 'Different original message',
        }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      () => f.business.saveMessage({ ...source, body: '改写原文' }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      () => f.business.saveMessage({ ...source, classification: 'unsubscribe' }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      () => f.message(conversation, { actualConfirmed: false }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      () => f.message(conversation, { direction: 'outbound', deliveryStatus: 'draft' }),
      (error) => error.status === 400,
    );
    const updated = await f.business.saveMessage({ ...source, notes: '保留原文，补充人工备注' });
    assert.equal(updated.version, 2);
    assert.equal(updated.body, source.body);
    await assert.rejects(
      () => f.business.saveMessage({ ...source, notes: '旧页面覆盖' }),
      (error) => error.status === 409,
    );
    const demand = await f.demand(conversation, updated);
    const current = f.business.get('messages', source.id);
    await assert.rejects(
      () => f.business.saveMessage({ ...current, demandIds: [] }),
      (error) => error.status === 409,
    );
    assert(current.demandIds.includes(demand.id));
  } finally {
    f.business.close();
  }
});

test('客户邮箱只在实际收发邮件后绑定，失败记录和内部纪要不绑定或授权切换', async () => {
  const f = fixture();
  try {
    let conversation = await f.conversation({ account: '' });
    await f.message(conversation, {
      direction: 'note',
      deliveryStatus: 'recorded',
      channel: 'phone',
      account: '',
      from: '',
      to: '',
      body: '电话询问 roller blinds。',
    });
    assert.equal(f.business.context(conversation.customerId).fixedEmail, '');
    await f.message(conversation, {
      direction: 'outbound',
      deliveryStatus: 'failed',
      account: 'first@our-company.test',
      from: 'first@our-company.test',
      to: conversation.participant,
    });
    assert.equal(f.business.context(conversation.customerId).fixedEmail, '');
    conversation = await f.business.saveConversation({
      ...conversation,
      account: 'second@our-company.test',
    });
    await f.message(conversation, {
      account: 'second@our-company.test',
      to: 'second@our-company.test',
    });
    assert.equal(f.business.context(conversation.customerId).fixedEmail, 'second@our-company.test');
    await assert.rejects(
      () => f.conversation({ account: 'first@our-company.test' }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      () => f.business.saveConversation({ ...conversation, account: 'first@our-company.test' }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      () =>
        f.message(conversation, {
          account: 'first@our-company.test',
          to: 'first@our-company.test',
        }),
      (error) => error.status === 409,
    );
    const another = await f.conversation({
      title: '另一品类会话',
      account: 'second@our-company.test',
    });
    await f.message(another, { account: 'second@our-company.test', to: 'second@our-company.test' });
    assert.equal(f.business.view().customerContexts.length, 1);
  } finally {
    f.business.close();
  }
});

test('成功创建的幂等重放不依赖当时 T2/T5 在线状态', async () => {
  const f = fixture();
  try {
    const conversation = await f.conversation(
      {},
      { idempotencyKey: 'offline-replay-conversation' },
    );
    const source = await f.message(conversation);
    const demand = await f.demand(
      conversation,
      source,
      {},
      { idempotencyKey: 'offline-replay-demand' },
    );
    f.business.customer = async () => {
      throw new Error('T2 unavailable');
    };
    f.business.product = async () => {
      throw new Error('T5 unavailable');
    };
    assert.equal(
      (await f.conversation({}, { idempotencyKey: 'offline-replay-conversation' })).id,
      conversation.id,
    );
    assert.equal(
      (await f.demand(conversation, source, {}, { idempotencyKey: 'offline-replay-demand' })).id,
      demand.id,
    );
    assert.equal(f.business.view().demands.length, 1);
  } finally {
    f.business.close();
  }
});

test('内部备注不能冒充采购询盘，已确认的实际电话沟通可作为原始依据', async () => {
  const f = fixture();
  try {
    const conversation = await f.conversation();
    const internal = await f.message(conversation, {
      channel: 'other',
      direction: 'note',
      deliveryStatus: 'recorded',
      from: '',
      to: '',
      account: '',
      body: 'Consider roller blinds for this prospect.',
    });
    await assert.rejects(
      () => f.demand(conversation, internal),
      (error) => error.status === 409,
    );
    const call = await f.message(conversation, {
      channel: 'phone',
      direction: 'note',
      deliveryStatus: 'recorded',
      from: '',
      to: '',
      account: '',
      body: 'Customer said: We need roller blinds.',
    });
    assert.equal((await f.demand(conversation, call)).sourceMessageId, call.id);
  } finally {
    f.business.close();
  }
});

test('并发登记不同邮箱时只保留第一个实际绑定，另一条记录完整回滚', async () => {
  const f = fixture();
  try {
    const first = await f.conversation({ account: '' });
    const second = await f.conversation({ account: '' });
    const results = await Promise.allSettled([
      f.message(first, { account: 'first@our-company.test', to: 'first@our-company.test' }),
      f.message(second, { account: 'second@our-company.test', to: 'second@our-company.test' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result) => result.status === 'rejected');
    assert.equal(rejected.reason.status, 409);
    const messages = f.business.view().messages;
    assert.equal(messages.length, 1);
    assert.equal(f.business.context('customer-a').fixedEmail, messages[0].account);
    const unmatched = f.business.get(
      'conversations',
      messages[0].conversationId === first.id ? second.id : first.id,
    );
    assert.equal(unmatched.account, '');
  } finally {
    f.business.close();
  }
});
