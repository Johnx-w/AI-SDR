import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { extractAutomaticDemands } from '../server/automatic-demands.mjs';
import { recordFollowUpTask } from '../server/outreach-follow-ups.mjs';

async function fixture() {
  const store = new CustomerBusiness({ customer: async (id) => ({ record_id: id }) });
  const conversation = await store.saveConversation({
    customerId: 'buyer',
    title: 'Inquiry',
    channel: 'email',
    account: 'sales@example.org',
  });
  const incoming = (body, extra = {}) =>
    store.saveMessage({
      customerId: 'buyer',
      conversationId: conversation.id,
      channel: 'email',
      direction: 'inbound',
      actualConfirmed: true,
      deliveryStatus: 'received',
      account: 'sales@example.org',
      from: 'buyer@example.net',
      to: 'sales@example.org',
      occurredAt: '2026-11-10T01:00:00Z',
      body,
      ...extra,
    });
  return { store, incoming, conversation };
}
const answer = (demands, reviewReason = '') => ({
  output_text: JSON.stringify({ demands, reviewReason }),
});
const demand = (quote, fields = {}) => ({
  existingId: '',
  title: '产品咨询',
  productText: '',
  specifications: '',
  quantity: '',
  unit: '',
  quote,
  ...fields,
});

test('明确产品咨询自动建需求，未知留空；补充同事项保留原始和新增证据，重复处理不建新单', async () => {
  const { store, incoming } = await fixture();
  let calls = 0;
  try {
    const first = await incoming('Please send information about PVC shutters.');
    const model = {
      research: async () => {
        calls++;
        return answer([demand(first.body, { productText: 'PVC shutters' })]);
      },
    };
    await extractAutomaticDemands(store, { model });
    assert.equal(store.all('demands').length, 1);
    const original = store.all('demands')[0];
    assert.equal(original.direction, '');
    assert.equal(original.quantity, '');
    await extractAutomaticDemands(store, { model });
    assert.equal(calls, 1);
    const second = await incoming('We need 200 units.', { occurredAt: '2026-11-10T02:00:00Z' });
    model.research = async ({ messages }) => {
      assert.match(messages[1].content, new RegExp(original.id));
      return answer([
        demand(second.body, { existingId: original.id, quantity: '200', unit: 'units' }),
      ]);
    };
    await extractAutomaticDemands(store, { model });
    const updated = store.all('demands')[0];
    assert.equal(store.all('demands').length, 1);
    assert.equal(updated.quantity, '200');
    assert.equal(updated.productText, 'PVC shutters');
    assert.equal(updated.sourceMessageId, first.id);
    assert.equal(updated.evidence.length, 2);
    assert(store.get('messages', second.id).demandIds.includes(updated.id));
  } finally {
    store.close();
  }
});

test('自动回执和拒绝不建需求，歧义留待核实，伪造引文不得写入', async () => {
  const { store, incoming } = await fixture();
  try {
    await incoming('I am away.', { classification: 'auto_reply' });
    await extractAutomaticDemands(store, {
      model: { research: () => assert.fail('自动回执不调用需求提取') },
    });
    assert.equal(store.all('demands').length, 0);
    await incoming('We are not looking to source externally.');
    await extractAutomaticDemands(store, { model: { research: async () => answer([]) } });
    assert.equal(store.all('demands').length, 0);
    const uncertain = await incoming('What about the other project?');
    await extractAutomaticDemands(store, {
      model: { research: async () => answer([], '不能确定所指项目') },
    });
    assert.equal(store.get('messages', uncertain.id).demandReviewReason, '不能确定所指项目');
    const source = await incoming('Please quote blinds.');
    await extractAutomaticDemands(store, {
      model: { research: async () => answer([demand(source.body, { quantity: '1000' })]) },
    });
    assert.equal(store.all('demands').length, 0);
    assert.match(store.get('messages', source.id).demandAnalysisError, /逐字依据/);
  } finally {
    store.close();
  }
});

test('飞书无关的本地需求写入失败可按缓存重试，更新后中断不重复追加证据', async () => {
  const { store, incoming } = await fixture();
  try {
    const source = await incoming('Please quote blinds.');
    let calls = 0;
    const model = {
      research: async () => {
        calls++;
        return answer([demand(source.body, { productText: 'blinds' })]);
      },
    };
    const save = store.saveDemand.bind(store);
    store.saveDemand = async (...args) => {
      const result = await save(...args);
      throw Error('模拟写入后中断');
    };
    await extractAutomaticDemands(store, { model });
    assert.equal(store.all('demands').length, 1);
    store.saveDemand = save;
    await extractAutomaticDemands(store, { model });
    assert.equal(calls, 1);
    assert.equal(store.all('demands').length, 1);
    assert.equal(store.get('messages', source.id).demandAnalysisError, '');
  } finally {
    store.close();
  }
});

test('T4投影只以追信动作及真实发送状态更新，重复投影不增加版本或记录', async () => {
  const { store, incoming } = await fixture();
  try {
    const source = await incoming('Original mail', { externalId: '<first@example.org>' });
    const first = { messageId: source.externalId, customerId: 'buyer' };
    const action = {
      id: 'followup-first-1',
      campaignId: 'campaign',
      step: 1,
      status: 'pending',
      dueAt: '2026-11-13T01:00:00Z',
      createdAt: '2026-11-10T01:00:00Z',
      updatedAt: '2026-11-10T01:00:00Z',
    };
    recordFollowUpTask(store, action, first);
    recordFollowUpTask(store, action, first);
    assert.equal(store.all('tasks').length, 1);
    assert.equal(store.all('tasks')[0].version, 1);
    recordFollowUpTask(store, { ...action, status: 'unknown', reason: '结果待核实' }, first);
    assert.equal(store.all('tasks')[0].status, 'pending');
    const accepted = { ...action, status: 'accepted', messageId: '<followup@example.org>' };
    assert.equal(recordFollowUpTask(store, accepted, first), false, '结果邮件未桥接时仍需重试关联');
    assert.equal(store.all('tasks')[0].status, 'completed');
    assert.equal(store.all('tasks')[0].origin, 'automatic-followup');
    const result = await incoming('Actual follow-up', { externalId: accepted.messageId });
    assert.equal(recordFollowUpTask(store, accepted, first), true);
    assert.equal(store.all('tasks')[0].resultMessageId, result.id);
  } finally {
    store.close();
  }
});
