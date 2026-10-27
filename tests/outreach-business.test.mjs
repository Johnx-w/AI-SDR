import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { recordOutreachInBusiness } from '../server/outreach-business.mjs';

const delivery = {
  id: 'delivery-1',
  campaignId: 'campaign-1',
  mode: 'production',
  status: 'accepted',
  customerId: 'customer-1',
  from: 'Sales@company.example',
  to: 'buyer@customer.example',
  subject: 'Product introduction',
  bodyText: 'Hello,\n\nAn approved product introduction.',
  messageId: '<delivery-1@company.example>',
  sentAt: '2026-10-26T08:00:00.000Z',
};
function fixture(t, options = {}) {
  const store = new CustomerBusiness({
    scope: 'test-scope',
    customer: async (id) => (['customer-1', 'customer-2'].includes(id) ? { record_id: id } : null),
    now: () => new Date('2026-10-26T08:01:00.000Z'),
    ...options,
  });
  t.after(() => store.close());
  return store;
}
const record = (store, patch = {}) =>
  recordOutreachInBusiness({ store, delivery: { ...delivery, ...patch } });

test('accepted production send records actual outbound facts and fixes the customer mailbox without creating a demand', async (t) => {
  const store = fixture(t);
  const result = await record(store);
  assert.equal(result.created, true);
  assert.equal(result.message.origin, 'outreach');
  assert.equal(result.message.deliveryStatus, 'sent');
  assert.equal(result.message.externalId, delivery.messageId);
  assert.equal(result.message.occurredAt, delivery.sentAt);
  assert.equal(result.message.from, delivery.from);
  assert.equal(result.message.body, delivery.bodyText);
  assert.deepEqual(result.message.demandIds, []);
  assert.match(result.message.notes, /SMTP.*不是客户收件/);
  assert.equal(result.conversation.account, 'sales@company.example');
  assert.equal(store.context(delivery.customerId).fixedEmail, 'sales@company.example');
  assert.equal(store.view().messages.length, 1);
  assert.equal(store.view().demands.length, 0);
  assert.equal(store.view().tasks.length, 0);
});

test('same delivery replays idempotently after restart and cannot mutate original facts or provenance', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'outreach-business-'));
  const path = join(directory, 'business.sqlite');
  const firstStore = new CustomerBusiness({
    path,
    scope: 'test-scope',
    customer: async (id) => ({ record_id: id }),
  });
  const original = await record(firstStore);
  firstStore.close();
  const store = fixture(t, { path });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repeated = await record(store);
  assert.equal(repeated.created, false);
  assert.deepEqual(repeated.message, original.message);
  store.customer = async () => {
    throw new Error('customer source temporarily unavailable');
  };
  assert.equal((await record(store)).created, false);
  for (const patch of [
    { customerId: 'customer-2' },
    { bodyText: 'Changed body' },
    { from: 'other@company.example' },
    { to: 'other@customer.example' },
    { campaignId: 'different-campaign' },
    { messageId: '<changed@company.example>' },
  ]) {
    await assert.rejects(record(store, patch), { status: 409 });
  }
  assert.equal(store.view().messages.length, 1);
  assert.equal(store.view().conversations.length, 1);
});

test('same SMTP message identity cannot be attached to a second delivery or another customer', async (t) => {
  const store = fixture(t);
  await record(store);
  await assert.rejects(record(store, { id: 'delivery-2' }), { status: 409 });
  await assert.rejects(record(store, { id: 'delivery-2', customerId: 'customer-2' }), {
    status: 409,
  });
  assert.equal(store.view().messages.length, 1);
  assert.equal(store.context('customer-2').fixedEmail, '');
});

test('pilot, test, draft, unknown, incomplete and nonexistent-customer deliveries never become business facts', async (t) => {
  const store = fixture(t);
  for (const patch of [
    { mode: 'internal_test' },
    { mode: 'pilot' },
    { status: 'draft' },
    { status: 'unknown' },
    { status: 'failed' },
    { messageId: '' },
    { sentAt: '' },
    { bodyText: '' },
    { from: 'invalid' },
    { customerId: 'missing' },
  ]) {
    await assert.rejects(record(store, patch));
  }
  assert.equal(store.view().messages.length, 0);
  assert.equal(store.view().conversations.length, 0);
  assert.equal(store.context('customer-1').fixedEmail, '');
});

test('conflicting fixed mailbox, stop-contact and human ownership prevent new bridge writes', async (t) => {
  const store = fixture(t);
  store.putContext({ ...store.context('customer-1'), fixedEmail: 'other@company.example' });
  await assert.rejects(record(store), { status: 409 });
  store.putContext({ ...store.context('customer-1'), fixedEmail: '', doNotContact: true });
  await assert.rejects(record(store), { status: 409 });
  store.putContext({ ...store.context('customer-1'), doNotContact: false });
  await store.saveConversation({
    customerId: 'customer-1',
    title: 'Human work',
    channel: 'email',
    account: 'sales@company.example',
    participant: delivery.to,
    ownership: 'human',
  });
  await assert.rejects(record(store), { status: 409 });
  assert.equal(store.view().messages.length, 0);
  assert.equal(store.context('customer-1').fixedEmail, '');
});

test('existing actual inbound message blocks a new first outreach record', async (t) => {
  const store = fixture(t);
  const conversation = await store.saveConversation({
    customerId: 'customer-1',
    title: 'Incoming inquiry',
    channel: 'email',
    account: 'sales@company.example',
    participant: delivery.to,
  });
  await store.saveMessage({
    customerId: 'customer-1',
    conversationId: conversation.id,
    channel: 'email',
    direction: 'inbound',
    from: delivery.to,
    to: delivery.from,
    account: 'sales@company.example',
    body: 'An existing inbound message',
    occurredAt: delivery.sentAt,
    deliveryStatus: 'received',
    actualConfirmed: true,
    origin: 'manual',
  });
  await assert.rejects(record(store), { status: 409 });
  assert.equal(store.view().messages.length, 1);
});

test('an empty matching auto conversation is reused and any write failure rolls back all changes', async (t) => {
  const store = fixture(t);
  const conversation = await store.saveConversation({
    customerId: 'customer-1',
    title: 'Prepared conversation',
    channel: 'email',
    account: '',
    participant: delivery.to,
  });
  const put = store.put.bind(store);
  store.put = (kind, value) => {
    if (kind === 'messages') throw new Error('synthetic write failure');
    return put(kind, value);
  };
  await assert.rejects(record(store), /synthetic write failure/);
  assert.equal(store.get('conversations', conversation.id).account, '');
  assert.equal(store.get('conversations', conversation.id).version, 1);
  assert.equal(store.context('customer-1').fixedEmail, '');
  store.put = put;
  const result = await record(store);
  assert.equal(result.conversation.id, conversation.id);
  assert.equal(result.conversation.version, 2);
  assert.equal(store.view().conversations.length, 1);
  assert.equal((await record(store)).created, false);
});

test('the public manual message API remains unable to create outreach-origin records', async (t) => {
  const store = fixture(t);
  const result = await record(store);
  await assert.rejects(store.saveMessage({ ...result.message, id: undefined }), { status: 400 });
  assert.equal(store.view().messages.length, 1);
});
