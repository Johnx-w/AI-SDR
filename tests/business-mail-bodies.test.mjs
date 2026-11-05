import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { CustomerBusinessApi } from '../server/customer-business-api.mjs';

test('original mail lookup is limited to messages in an existing business conversation and does not synchronize', async (t) => {
  const store = new CustomerBusiness({ customer: async () => null });
  t.after(() => store.close());
  store.put('conversations', { id: 'one', customerId: 'customer' });
  store.put('messages', { id: 'mail', conversationId: 'one', channel: 'email' });
  store.put('messages', { id: 'phone', conversationId: 'one', channel: 'phone' });
  store.put('messages', { id: 'other', conversationId: 'two', channel: 'email' });
  const calls = [];
  const api = new CustomerBusinessApi({
    getEnv: () => ({}),
    mailBodies: (records) => {
      calls.push(records);
      return { mail: { bodyHtml: '<p>Original</p>' } };
    },
  });
  api.state = () => ({ store });
  api.synchronize = () => {
    throw new Error('Reading original mail must not synchronize');
  };
  const read = (id) =>
    api.handle(
      { method: 'GET' },
      new URL(`http://localhost/api/v1/business/conversations/${id}/mail-bodies`),
      () => {
        throw new Error('No write body');
      },
    );
  const result = await read('one');
  assert.deepEqual(
    calls[0].map((record) => record.id),
    ['mail'],
  );
  assert.equal(result.body.originals.mail.bodyHtml, '<p>Original</p>');
  await assert.rejects(read('missing'), { status: 404 });
  assert.equal(calls.length, 1);
});
