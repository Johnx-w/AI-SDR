import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateLeadDevelopment } from '../server/lead-development.mjs';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { recordOutreachInBusiness } from '../server/outreach-business.mjs';

const lead = { id: 'customer-1', status: '待开发', version: 'profile-v1' };
const message = (patch = {}) => ({
  id: 'inbound-1',
  customerId: lead.id,
  conversationId: 'conversation-1',
  channel: 'email',
  direction: 'inbound',
  deliveryStatus: 'received',
  classification: 'normal',
  actualConfirmed: true,
  body: 'Please quote 500 roller blinds.',
  demandIds: [],
  occurredAt: '2026-10-28T01:00:00.000Z',
  ...patch,
});
const demand = (patch = {}) => ({
  id: 'demand-1',
  customerId: lead.id,
  conversationId: 'conversation-1',
  sourceMessageId: 'inbound-1',
  evidenceQuote: '500 roller blinds',
  stage: 'new',
  ...patch,
});
const listed = (graph = {}, customer = lead) =>
  decorateLeadDevelopment({ leads: [customer] }, graph).leads[0];

test('正式首封发送登记后已有客户立即显示已联系，真实回复和已推进需求继续提升进度', async (t) => {
  const store = new CustomerBusiness({ customer: async (id) => ({ record_id: id }) });
  t.after(() => store.close());
  const saved = await recordOutreachInBusiness({
    store,
    delivery: {
      id: 'delivery-1',
      campaignId: 'campaign-1',
      customerId: lead.id,
      mode: 'production',
      status: 'accepted',
      from: 'sales@company.example',
      to: 'buyer@customer.example',
      subject: 'Roller blind introduction',
      bodyText: 'Our roller blinds introduction.',
      messageId: '<delivery-1@company.example>',
      sentAt: '2026-10-27T08:00:00.000Z',
    },
  });
  assert.equal(listed(store.view()).status, '已联系');
  const reply = await store.saveMessage({
    ...message(),
    id: undefined,
    conversationId: saved.conversation.id,
    account: 'sales@company.example',
    from: 'buyer@customer.example',
    to: 'sales@company.example',
  });
  assert.equal(listed(store.view()).status, '已回复');
  await store.saveDemand({
    ...demand(),
    id: undefined,
    conversationId: saved.conversation.id,
    sourceMessageId: reply.id,
    title: 'Roller blinds quotation',
    direction: 'finished',
    productText: 'roller blinds',
    stage: 'quoting',
  });
  assert.equal(listed(store.view()).status, '跟进中');
  assert.equal(lead.status, '待开发', '展示进度不能覆盖原始档案');
});

test('仅真实已发送或服务商接受的正式沟通计为已联系', () => {
  for (const status of ['sent', 'accepted'])
    assert.equal(
      listed({ messages: [message({ direction: 'outbound', deliveryStatus: status })] }).status,
      '已联系',
    );
  for (const patch of [
    { direction: 'outbound', deliveryStatus: 'draft' },
    { direction: 'outbound', deliveryStatus: 'failed' },
    { direction: 'outbound', deliveryStatus: 'unknown' },
    { direction: 'outbound', deliveryStatus: 'sent', actualConfirmed: false },
    { direction: 'note', deliveryStatus: 'recorded' },
  ])
    assert.equal(listed({ messages: [message(patch)] }).status, '待开发', JSON.stringify(patch));
  assert.equal(
    listed({ tasks: [{ customerId: lead.id, kind: 'first_contact', status: 'pending' }] }).status,
    '待开发',
  );
});

test('现有发送器及总览识别的未联系状态别名也随实际发送推进', () => {
  for (const status of [
    '',
    '未记录',
    '未联系',
    '尚未联系',
    'pending_outreach',
    '未开发',
    '待联系',
    '新线索',
  ]) {
    const customer = { ...lead, status };
    assert.equal(listed({}, customer).status, ['', '未记录'].includes(status) ? '待开发' : status);
    assert.equal(
      listed(
        { messages: [message({ direction: 'outbound', deliveryStatus: 'accepted' })] },
        customer,
      ).status,
      '已联系',
    );
    assert.equal(listed({ messages: [message()] }, customer).status, '已回复');
  }
});

test('收到真实正常来信才显示已回复，自动回复及异常消息不抬升进度', () => {
  assert.equal(listed({ messages: [message()] }).status, '已回复');
  for (const patch of [
    { classification: 'auto_reply' },
    { classification: 'unsubscribe' },
    { classification: 'hard_bounce' },
    { classification: 'complaint' },
    { actualConfirmed: false },
    { deliveryStatus: 'unknown' },
    { customerId: 'customer-2' },
  ]) {
    const status = listed({ messages: [message(patch)] }).status;
    assert.ok(['待开发', '停止开发'].includes(status), JSON.stringify(patch));
  }
});

test('有真实客户需求且已进入规格、报价、寄样或议价阶段才显示跟进中', () => {
  for (const stage of ['clarifying', 'quoting', 'sampling', 'negotiating'])
    assert.equal(
      listed({ messages: [message()], demands: [demand({ stage })] }).status,
      '跟进中',
      stage,
    );
  for (const stage of ['new', 'won', 'lost', 'closed'])
    assert.equal(
      listed({ messages: [message()], demands: [demand({ stage })] }).status,
      '已回复',
      stage,
    );
  const phone = message({ channel: 'phone', direction: 'note', deliveryStatus: 'recorded' });
  assert.equal(
    listed({ messages: [phone], demands: [demand({ stage: 'quoting' })] }).status,
    '跟进中',
  );
});

test('未核实、跨客户或跨会话的需求以及官网描述不能冒充实际跟进', () => {
  for (const patch of [
    { sourceMessageId: 'missing' },
    { customerId: 'customer-2' },
    { conversationId: 'other-conversation' },
    { evidenceQuote: 'not in customer original' },
    { evidenceQuote: '' },
  ])
    assert.equal(
      listed({ messages: [message()], demands: [demand({ stage: 'quoting', ...patch })] }).status,
      '已回复',
      JSON.stringify(patch),
    );
  for (const source of [
    message({ actualConfirmed: false }),
    message({ classification: 'auto_reply' }),
    message({ direction: 'outbound', deliveryStatus: 'sent' }),
    message({ direction: 'note', deliveryStatus: 'recorded', channel: 'other' }),
  ])
    assert.notEqual(
      listed({ messages: [source], demands: [demand({ stage: 'quoting' })] }).status,
      '跟进中',
    );
  assert.equal(listed({ demands: [demand({ stage: 'quoting' })] }).status, '待开发');
});

test('新需求在实际发送与该需求关联的后续回复后进入跟进中，计划和失败回复不计入', () => {
  const response = message({
    id: 'outbound-1',
    direction: 'outbound',
    deliveryStatus: 'sent',
    body: 'Please confirm the sizes.',
    demandIds: ['demand-1'],
    occurredAt: '2026-10-28T02:00:00.000Z',
  });
  const graph = { messages: [message(), response], demands: [demand()] };
  assert.equal(listed(graph).status, '跟进中');
  for (const patch of [
    { demandIds: [] },
    { deliveryStatus: 'failed' },
    { deliveryStatus: 'unknown' },
    { actualConfirmed: false },
    { conversationId: 'other-conversation' },
    { customerId: 'customer-2' },
    { occurredAt: '2026-10-28T00:00:00.000Z' },
  ])
    assert.equal(
      listed({ ...graph, messages: [message(), { ...response, ...patch }] }).status,
      '已回复',
      JSON.stringify(patch),
    );
  assert.equal(
    listed({
      messages: [message()],
      demands: [demand()],
      tasks: [
        { customerId: lead.id, demandIds: ['demand-1'], kind: 'quote_followup', status: 'pending' },
      ],
    }).status,
    '已回复',
  );
});

test('自动状态只推进已有进度并保留人工限制，暂缓恢复后按真实沟通显示进度', () => {
  for (const sourceStatus of [
    '已回复',
    '跟进中',
    '已成交',
    '暂缓开发',
    '停止开发',
    '暂不开发',
    '人工跟进中',
  ])
    assert.equal(
      listed(
        { messages: [message({ direction: 'outbound', deliveryStatus: 'sent' })] },
        { ...lead, status: sourceStatus },
      ).status,
      sourceStatus,
    );
  const graph = {
    messages: [message()],
    demands: [demand({ stage: 'quoting' })],
    customerContexts: [{ customerId: lead.id, development: { version: 1, paused: true } }],
  };
  assert.equal(listed(graph).status, '暂缓开发');
  graph.customerContexts[0].development = { version: 2, paused: false };
  assert.equal(listed(graph).status, '跟进中');
});

test('列表详情导出状态及版本一致，仅有效进度或本客户暂缓变化影响内容版本', () => {
  const graph = { messages: [message()] };
  const first = listed(graph);
  const detail = decorateLeadDevelopment(
    { lead: { ...lead, version: undefined }, version: lead.version },
    graph,
  );
  const exported = listed(graph, { ...lead, version: undefined });
  assert.equal(first.status, detail.lead.status);
  assert.equal(first.status, exported.status);
  assert.equal(first.version, detail.version);
  assert.notEqual(first.version, lead.version);
  assert.equal(
    listed({ messages: [...graph.messages, message({ id: 'another-reply' })] }).version,
    first.version,
  );
  assert.equal(
    listed({ messages: [...graph.messages, message({ id: 'other', customerId: 'customer-2' })] })
      .version,
    first.version,
  );
  assert.equal(
    listed({ messages: [], tasks: [{ customerId: lead.id, status: 'pending' }] }).version,
    lead.version,
  );
  const other = { ...lead, id: 'customer-2', version: 'other-v1' };
  const snapshot = { leads: [lead, other] };
  const decorated = decorateLeadDevelopment(snapshot, graph);
  assert.equal(decorated.leads[1], other);
  assert.equal(snapshot.leads[0].status, '待开发');
});
