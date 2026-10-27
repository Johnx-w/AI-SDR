import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { recordMailConversation } from '../server/mail-conversation-business.mjs';

function setup(t) {
  const store = new CustomerBusiness({ customer: async (id) => ({ record_id: id, fields: {} }) });
  t.after(() => store.close());
  const conversation = {
    id: 'mail-thread',
    customerId: 'customer',
    account: 'sales@brand.example',
    participant: 'buyer@buyer.example',
    subject: 'Product request',
  };
  const incoming = {
    id: 'incoming',
    direction: 'inbound',
    from: 'buyer@buyer.example',
    to: conversation.account,
    subject: conversation.subject,
    bodyText: 'Please share the catalog.',
    occurredAt: '2026-10-27T04:00:00Z',
    deliveryStatus: 'received',
    source: 'imap',
    messageId: '<incoming@buyer.example>',
  };
  return {
    store,
    conversation,
    incoming,
    record(messages, override = {}) {
      return recordMailConversation({
        store,
        conversation: { ...conversation, ...override },
        messages,
      });
    },
  };
}

test('only matched real messages enter customer business; no demands or tasks are invented', async (t) => {
  const h = setup(t);
  assert.equal((await h.record([h.incoming], { customerId: undefined })).recorded, 0);
  assert.equal(h.store.all('messages').length, 0);
  assert.equal((await h.record([h.incoming])).recorded, 1);
  assert.equal((await h.record([h.incoming])).recorded, 0);
  assert.equal(h.store.all('messages')[0].body, h.incoming.bodyText);
  assert.equal(h.store.all('demands').length, 0);
  assert.equal(h.store.all('tasks').length, 0);
  assert.equal(h.store.context('customer').fixedEmail, h.conversation.account);
});

test('manual SMTP acceptance remains distinct from sent-folder confirmation and preserves human ownership', async (t) => {
  const h = setup(t);
  const existing = await h.store.saveConversation({
    customerId: 'customer',
    title: 'Human owned',
    channel: 'email',
    account: h.conversation.account,
    participant: h.conversation.participant,
    ownership: 'human',
    owner: '业务员',
  });
  const outgoing = {
    ...h.incoming,
    id: 'outgoing',
    direction: 'outbound',
    from: h.conversation.account,
    to: h.incoming.from,
    source: 'manual',
    bodyText: 'Here is our catalog.',
    deliveryStatus: 'accepted',
    messageId: '<reply@brand.example>',
  };
  await h.record([h.incoming, outgoing]);
  assert.equal(h.store.all('conversations').length, 1);
  assert.equal(h.store.get('conversations', existing.id).ownership, 'human');
  const prior = h.store
    .all('messages')
    .find((message) => message.externalId === outgoing.messageId);
  assert.equal(prior.deliveryStatus, 'accepted');
  assert.match(prior.notes, /服务商已接受/);
  await h.record([h.incoming, { ...outgoing, source: 'imap', deliveryStatus: 'sent' }]);
  assert.equal(h.store.get('messages', prior.id).deliveryStatus, 'sent');
  assert.equal(h.store.get('messages', prior.id).body, outgoing.bodyText);
  assert.equal(h.store.all('messages').length, 2);
});

test('mailbox conflicts and changed original messages do not rewrite customer facts', async (t) => {
  const h = setup(t);
  await h.record([h.incoming]);
  await assert.rejects(h.record([{ ...h.incoming, bodyText: 'changed original' }]), /原文/);
  await assert.rejects(
    h.record([{ ...h.incoming, id: 'other', messageId: '<other@buyer.example>' }], {
      account: 'other@brand.example',
    }),
    /固定邮箱/,
  );
  assert.equal(h.store.all('messages').length, 1);
  assert.equal(h.store.all('messages')[0].body, h.incoming.bodyText);
});

test('unknown or failed replies never become successfully sent business messages', async (t) => {
  const h = setup(t);
  const messages = ['unknown', 'failed', 'sending'].map((deliveryStatus, i) => ({
    ...h.incoming,
    id: String(i),
    direction: 'outbound',
    from: h.conversation.account,
    to: h.incoming.from,
    deliveryStatus,
  }));
  assert.equal((await h.record(messages)).recorded, 0);
  assert.equal(h.store.all('messages').length, 0);
});
