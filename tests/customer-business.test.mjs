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
  f.task = (conversation, overrides = {}, options = {}) =>
    f.business.saveTask(
      {
        customerId: conversation.customerId,
        conversationId: conversation.id,
        title: '补问规格',
        kind: 'clarify_specs',
        channel: conversation.channel,
        dueAt: f.due(),
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
    const task = await f.task(conversation);
    await assert.rejects(
      () =>
        f.business.saveTask({
          ...task,
          customerId: secondCustomer.customerId,
          conversationId: secondCustomer.id,
        }),
      (error) => error.status === 409,
    );
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

test('任务时间由用户明确设置，状态不能通过普通保存绕过，手工行动需执行说明', async () => {
  const f = fixture();
  try {
    const conversation = await f.conversation();
    await assert.rejects(
      () => f.task(conversation, { dueAt: undefined }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      () => f.task(conversation, { dueAt: '2026-02-30T10:00:00Z' }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      () => f.task(conversation, { status: 'completed' }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      () => f.task(conversation, { status: 'cancelled' }),
      (error) => error.status === 409,
    );
    const task = await f.task(
      conversation,
      { kind: 'manual_review' },
      { idempotencyKey: 'manual-task-create-001' },
    );
    assert.equal(task.dueAt, f.due());
    await assert.rejects(
      () => f.business.saveTask({ ...task, status: 'completed' }),
      (error) => error.status === 409,
    );
    await assert.rejects(
      () => f.business.actTask(task.id, { action: 'complete', expectedVersion: task.version }),
      (error) => error.status === 400,
    );
    const completed = await f.business.actTask(task.id, {
      action: 'complete',
      expectedVersion: task.version,
      notes: '已核对资料，后续消息仍须按内容审核',
    });
    assert.equal(completed.status, 'completed');
    assert.equal(completed.audit.at(-1).notes, '已核对资料，后续消息仍须按内容审核');
    assert.equal(f.business.get('conversations', conversation.id).ownership, 'auto');
    await assert.rejects(
      () => f.business.saveTask({ ...completed, title: '覆盖执行记录' }),
      (error) => error.status === 409,
    );
    assert.equal(
      (
        await f.task(
          conversation,
          { kind: 'manual_review' },
          { idempotencyKey: 'manual-task-create-001' },
        )
      ).id,
      completed.id,
    );
  } finally {
    f.business.close();
  }
});

async function twoDemands(f) {
  const conversation = await f.conversation();
  const source = await f.message(conversation);
  const first = await f.demand(conversation, source);
  const second = await f.demand(conversation, source, {
    title: '另一需求',
    productText: 'outdoor zip screens',
    evidenceQuote: 'outdoor zip screens',
  });
  f.advance();
  const sent = await f.message(conversation, {
    direction: 'outbound',
    deliveryStatus: 'sent',
    from: conversation.account,
    to: conversation.participant,
    demandIds: [first.id, second.id],
    body: 'Please confirm the specifications for both products.',
  });
  f.advance();
  return { conversation, source, first, second, sent };
}

test('一封统一回复支持两项需求，客户对其中一项的回复只暂停相关跟进', async () => {
  const f = fixture();
  try {
    const { conversation, first, second, sent } = await twoDemands(f);
    const taskA = await f.task(conversation, { demandIds: [first.id], basisMessageId: sent.id });
    const taskB = await f.task(conversation, { demandIds: [second.id], basisMessageId: sent.id });
    assert.equal((await f.business.preflightTask(taskA.id)).ready, true);
    f.advance();
    const reply = await f.message(conversation, {
      body: 'The roller blinds should be 120 cm wide.',
      demandIds: [first.id],
    });
    const paused = f.business.get('tasks', taskA.id);
    assert.equal(paused.status, 'paused');
    assert(paused.audit.at(-1).reasons.some((reason) => reason.includes('已回复')));
    assert.equal(f.business.get('tasks', taskB.id).status, 'pending');
    assert.equal((await f.business.preflightTask(taskB.id)).ready, true);
    await assert.rejects(
      () => f.business.actTask(paused.id, { action: 'resume', expectedVersion: paused.version }),
      (error) => error.status === 409,
    );
    const adjusted = await f.business.saveTask({
      ...paused,
      basisMessageId: reply.id,
      dueAt: f.due(),
    });
    const resumed = await f.business.actTask(adjusted.id, {
      action: 'resume',
      expectedVersion: adjusted.version,
      notes: '已处理新消息并安排下一步',
    });
    assert.equal(resumed.status, 'pending');
    assert.equal((await f.business.preflightTask(resumed.id)).automaticSend, false);
  } finally {
    f.business.close();
  }
});

test('自动回复不会当作客户推进，未分类的新来信保守暂停会话内跟进', async () => {
  const f = fixture();
  try {
    const { conversation, first, sent } = await twoDemands(f);
    const task = await f.task(conversation, { demandIds: [first.id], basisMessageId: sent.id });
    f.advance();
    await f.message(conversation, { classification: 'auto_reply', body: 'Out of office.' });
    assert.equal(f.business.get('tasks', task.id).status, 'pending');
    assert.equal((await f.business.preflightTask(task.id)).ready, true);
    f.advance();
    await f.message(conversation, { body: 'We have a new question.' });
    assert.equal(f.business.get('tasks', task.id).status, 'paused');
  } finally {
    f.business.close();
  }
});

test('客户全局拒绝阻止其他会话与渠道的新旧任务，另一客户不受影响', async () => {
  const f = fixture();
  try {
    const email = await f.conversation();
    await f.message(email);
    const emailTask = await f.task(email);
    const whatsapp = await f.conversation({
      channel: 'whatsapp',
      account: 'our-whatsapp',
      participant: 'customer-whatsapp',
    });
    await f.message(whatsapp, {
      account: 'our-whatsapp',
      from: 'customer-whatsapp',
      to: 'our-whatsapp',
    });
    const whatsappTask = await f.task(whatsapp);
    const other = await f.conversation({ customerId: 'customer-b' });
    const otherTask = await f.task(other);
    f.advance();
    await f.message(email, { classification: 'unsubscribe', body: 'Do not contact us again.' });
    assert.equal(f.business.context(email.customerId).doNotContact, true);
    assert.equal(f.business.get('tasks', emailTask.id).status, 'paused');
    assert.equal(f.business.get('tasks', whatsappTask.id).status, 'paused');
    assert.equal(f.business.get('tasks', otherTask.id).status, 'pending');
    const future = await f.task(whatsapp, { title: '后续 WhatsApp 联系' });
    assert.equal(future.status, 'paused');
    assert(
      (await f.business.preflightTask(future.id)).reasons.some((reason) =>
        reason.includes('拒绝联系'),
      ),
    );
  } finally {
    f.business.close();
  }
});

test('仅某项需求拒绝联系时保留其他独立需求的接待', async () => {
  const f = fixture();
  try {
    const { conversation, first, second, sent } = await twoDemands(f);
    const firstTask = await f.task(conversation, {
      demandIds: [first.id],
      basisMessageId: sent.id,
    });
    const secondTask = await f.task(conversation, {
      demandIds: [second.id],
      basisMessageId: sent.id,
    });
    f.advance();
    await f.message(conversation, {
      classification: 'unsubscribe',
      body: 'Stop following up this roller blind request.',
      demandIds: [first.id],
    });
    assert.equal(f.business.context(conversation.customerId).doNotContact, false);
    assert.equal(f.business.get('tasks', firstTask.id).status, 'paused');
    assert.equal(f.business.get('tasks', secondTask.id).status, 'pending');
    assert.equal((await f.business.preflightTask(secondTask.id)).ready, true);
  } finally {
    f.business.close();
  }
});

test('硬退信只阻止对应渠道联系入口，投诉交由整段会话人工处理', async () => {
  const f = fixture();
  try {
    const first = await f.conversation();
    await f.message(first);
    const firstTask = await f.task(first);
    const second = await f.conversation({ participant: 'another-buyer@customer-a.test' });
    await f.message(second, { from: second.participant });
    const secondTask = await f.task(second);
    f.advance();
    await f.message(first, {
      classification: 'hard_bounce',
      from: 'mailer-daemon@provider.test',
      body: 'The original recipient address does not exist.',
    });
    assert.equal(f.business.get('tasks', firstTask.id).status, 'paused');
    assert.equal(f.business.get('tasks', secondTask.id).status, 'pending');
    f.advance();
    await f.message(second, {
      classification: 'complaint',
      from: second.participant,
      body: 'We require a manager to address this serious complaint.',
    });
    assert.equal(f.business.get('conversations', second.id).ownership, 'human');
    assert.equal(f.business.get('tasks', secondTask.id).status, 'paused');
    assert.equal((await f.business.preflightTask(secondTask.id)).ready, false);
  } finally {
    f.business.close();
  }
});

test('执行前核对 T5 审核、版本、生效日期及 T2 人工开发状态，需求接管不会自动恢复', async () => {
  const f = fixture();
  try {
    const conversation = await f.conversation();
    const source = await f.message(conversation);
    let demand = await f.demand(conversation, source);
    let task = await f.task(conversation, { demandIds: [demand.id], executionMode: 'automatic' });
    assert.deepEqual(task.productIds, ['product-a']);
    assert.equal((await f.business.preflightTask(task.id)).ready, true);
    f.products.get('product-a').version = 2;
    assert(
      (await f.business.preflightTask(task.id)).reasons.some((reason) =>
        reason.includes('版本已变化'),
      ),
    );
    task = await f.business.saveTask({ ...task });
    assert(
      (await f.business.preflightTask(task.id)).reasons.some((reason) =>
        reason.includes('版本已变化'),
      ),
      '需求旧版本仍须核对，不能只刷新任务绕过',
    );
    demand = await f.business.saveDemand({ ...demand });
    assert.equal((await f.business.preflightTask(task.id)).ready, true);
    f.products.get('product-a').status = 'draft';
    assert(
      (await f.business.preflightTask(task.id)).reasons.some((reason) =>
        reason.includes('尚未审核'),
      ),
    );
    f.products.get('product-a').status = 'approved';
    f.products.get('product-a').effectiveDate = '2999-01-01';
    assert(
      (await f.business.preflightTask(task.id)).reasons.some((reason) =>
        reason.includes('尚未生效'),
      ),
    );
    f.products.get('product-a').effectiveDate = '';
    f.customers.get('customer-a').fields['开发状态'] = '暂缓开发';
    assert(
      (await f.business.preflightTask(task.id)).reasons.some((reason) => reason.includes('T2')),
    );
    assert.equal(f.customers.get('customer-a').fields['开发状态'], '暂缓开发');
    f.customers.get('customer-a').fields['开发状态'] = '待开发';
    demand = await f.business.saveDemand({ ...demand, ownership: 'human' });
    task = f.business.get('tasks', task.id);
    assert.equal(task.status, 'paused');
    demand = await f.business.saveDemand({ ...demand, ownership: 'auto' });
    assert.equal(f.business.get('tasks', task.id).status, 'paused');
    const resumed = await f.business.actTask(task.id, {
      action: 'resume',
      expectedVersion: task.version,
    });
    assert.equal(resumed.status, 'pending');
    const currentConversation = f.business.get('conversations', conversation.id);
    await f.business.saveConversation({ ...currentConversation, status: 'closed' });
    assert.equal(f.business.get('tasks', task.id).status, 'paused');
  } finally {
    f.business.close();
  }
});

test('沟通任务完成必须关联覆盖全部需求的实际已发消息，失败或未知消息不能证明完成', async () => {
  const f = fixture();
  try {
    const { conversation, first, second } = await twoDemands(f);
    const task = await f.task(conversation, { demandIds: [first.id, second.id] });
    f.advance();
    for (const deliveryStatus of ['failed', 'unknown']) {
      const message = await f.message(conversation, {
        direction: 'outbound',
        deliveryStatus,
        from: conversation.account,
        to: conversation.participant,
        demandIds: [first.id, second.id],
        body: 'Attempt to send unified reply.',
      });
      await assert.rejects(
        () =>
          f.business.actTask(task.id, {
            action: 'complete',
            expectedVersion: task.version,
            resultMessageId: message.id,
          }),
        (error) => error.status === 409,
      );
    }
    assert(
      (await f.business.preflightTask(task.id)).reasons.some((reason) =>
        reason.includes('结果尚未确认'),
      ),
    );
    const partial = await f.message(conversation, {
      direction: 'outbound',
      deliveryStatus: 'sent',
      from: conversation.account,
      to: conversation.participant,
      demandIds: [first.id],
      body: 'Only the first request was addressed.',
    });
    await assert.rejects(
      () =>
        f.business.actTask(task.id, {
          action: 'complete',
          expectedVersion: task.version,
          resultMessageId: partial.id,
        }),
      (error) => error.status === 409,
    );
    f.advance();
    const sent = await f.message(conversation, {
      direction: 'outbound',
      deliveryStatus: 'sent',
      from: conversation.account,
      to: conversation.participant,
      demandIds: [first.id, second.id],
      body: 'Unified actual reply covering both product requests.',
    });
    const done = await f.business.actTask(task.id, {
      action: 'complete',
      expectedVersion: task.version,
      resultMessageId: sent.id,
    });
    assert.equal(done.status, 'completed');
    assert.equal(done.resultMessageId, sent.id);
    assert.equal(done.completedAt, f.time());
    assert.equal(f.business.get('conversations', conversation.id).ownership, 'auto');
    assert.equal(f.business.view().messages.filter((message) => message.id === sent.id).length, 1);
  } finally {
    f.business.close();
  }
});

test('首联任务由真实发出消息补齐会话，记录操作不发送消息或建立虚假询盘', async () => {
  const f = fixture();
  try {
    const task = await f.business.saveTask({
      customerId: 'customer-a',
      title: '首次联系企业',
      kind: 'first_contact',
      channel: 'email',
      dueAt: f.due(),
    });
    const check = await f.business.preflightTask(task.id);
    assert.equal(check.ready, true);
    assert.equal(check.automaticSend, false);
    assert.equal(f.business.view().messages.length, 0);
    assert.equal(f.business.view().demands.length, 0);
    const conversation = await f.conversation();
    f.advance();
    const sent = await f.message(conversation, {
      direction: 'outbound',
      deliveryStatus: 'sent',
      from: conversation.account,
      to: conversation.participant,
      body: 'Manually recorded first contact.',
    });
    const done = await f.business.actTask(task.id, {
      action: 'complete',
      expectedVersion: task.version,
      resultMessageId: sent.id,
    });
    assert.equal(done.conversationId, conversation.id);
    assert.equal(f.business.view().demands.length, 0);
    assert.equal(f.business.view().messages.length, 1);
    assert.equal(f.business.context('customer-a').fixedEmail, conversation.account);
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

test('人工接管后仍可安排人工提醒，系统计划暂停且不会自动发信', async () => {
  const f = fixture();
  try {
    const conversation = await f.conversation({ ownership: 'human' });
    await f.message(conversation);
    const manual = await f.task(conversation);
    assert.equal(manual.executionMode, 'manual');
    assert.equal(manual.status, 'pending');
    assert.equal((await f.business.preflightTask(manual.id)).ready, true);
    const automatic = await f.task(conversation, { executionMode: 'automatic' });
    assert.equal(automatic.status, 'paused');
    const check = await f.business.preflightTask(automatic.id);
    assert.equal(check.ready, false);
    assert(check.reasons.some((reason) => reason.includes('人工接管')));
    assert.equal(check.automaticSend, false);
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
