import test from 'node:test';
import assert from 'node:assert/strict';
import {
  communicationRounds,
  communicationRoundFields,
  customerReplyText,
  knownReplyType,
} from '../server/communication-rounds.mjs';

const message = (id, direction, minute, extra = {}) => ({
  id,
  customerId: 'customer',
  conversationId: 'conversation',
  channel: 'email',
  account: 'sales@example.com',
  direction,
  occurredAt: '2026-11-09T08:' + String(minute).padStart(2, '0') + ':00Z',
  body: '正文 ' + id,
  from: direction === 'outbound' ? 'sales@example.com' : 'buyer@example.org',
  externalId: '<' + id + '@example.org>',
  ...extra,
});

test('一轮保留所有回复，后发邮件不占用之前回执，按回复编号归还迟到回复', () => {
  const graph = [
    message('first', 'outbound', 0, { notes: '业务员手动纪要' }),
    message('auto', 'inbound', 1, {
      classification: 'auto_reply',
      notes: '来自沟通中心的真实邮件同步。',
    }),
    message('second', 'outbound', 2),
    message('human', 'inbound', 3, {
      inReplyTo: '<first@example.org>',
      replyAnalysis: {
        replyType: '真人客户回复',
        customerInfo: '联系人：Kyla',
        demandSummary: '暂不考虑新供应商。',
      },
    }),
    message('survey', 'inbound', 4, {
      references: ['<first@example.org>', '<human@example.org>'],
      classification: 'auto_reply',
    }),
  ];
  const { rounds, aliases } = communicationRounds(graph);
  assert.equal(rounds.length, 2);
  assert.deepEqual(
    rounds[0].replies.map((m) => m.id),
    ['auto', 'human', 'survey'],
  );
  assert.equal(aliases.get('human'), 'first');
  const first = communicationRoundFields(rounds[0]),
    second = communicationRoundFields(rounds[1]);
  assert.equal(first.发送内容摘要, graph[0].body);
  assert.equal(first.回复类型, '真人客户回复');
  for (const m of rounds[0].replies) assert(first.收到回复内容.includes(m.body));
  assert.equal(first.提取客户信息, '联系人：Kyla');
  assert.equal(first.客户需求摘要, '暂不考虑新供应商。');
  assert.equal(first.业务员纪要, '业务员手动纪要');
  assert.equal(second.回复类型, '无回复');
  assert.equal(second.收到回复内容, null);
});

test('不跨客户、会话、渠道或账号合并；主动来信和纪要也不丢失', () => {
  const first = message('out', 'outbound', 0);
  for (const different of [
    { customerId: 'other' },
    { conversationId: 'other' },
    { account: 'other@example.com' },
    { channel: 'whatsapp' },
  ]) {
    const result = communicationRounds([
      first,
      message('in', 'inbound', 1, { ...different, inReplyTo: first.externalId }),
    ]);
    assert.equal(result.rounds.length, 2);
  }
  assert.equal(
    communicationRounds([message('note', 'note', 0), message('in', 'inbound', 1)]).rounds.length,
    2,
  );
});

test('策略拒收不当成地址失效，历史 normal 自动回执可被识别', () => {
  const base = {
    from: 'mailer-daemon@example.com',
    subject: 'Delivery Status Notification (Failure)',
  };
  assert.equal(
    knownReplyType({ ...base, body: 'Message blocked. Sender not allowed by policy.' }),
    '系统自动回复',
  );
  assert.equal(
    knownReplyType({ ...base, body: 'Address not found. The email account does not exist.' }),
    '联系方式失效',
  );
  assert.equal(
    knownReplyType({ classification: 'normal', subject: '[Request received]', body: 'Thank you.' }),
    '系统自动回复',
  );
  assert.equal(knownReplyType({ body: 'We are not looking for suppliers.' }), null);
});

test('客户原文证据排除引用历史，完整收信正文仍不截断', () => {
  const body =
    'Hi Lucy,\nNo current sourcing needs.\nAbdul\n--- original message ---\nWe supply 1000 blinds.\nLucy Wang';
  assert.equal(customerReplyText({ body }), 'Hi Lucy,\nNo current sourcing needs.\nAbdul');
  const incoming = message('in', 'inbound', 1, {
    body,
    replyAnalysis: { replyType: '真人客户回复', demandSummary: '暂不采购' },
  });
  assert(
    communicationRoundFields(communicationRounds([incoming]).rounds[0]).收到回复内容.includes(body),
  );
});
