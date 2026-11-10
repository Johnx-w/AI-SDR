import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { OutreachService } from '../server/outreach-service.mjs';

test('real mailbox conversations are directly accessible, enforce local origins and never send mail', async (t) => {
  const calls = [];
  const service = new OutreachService({
    customers: () => [{ id: 'buyer', name: 'Buyer', email: 'buyer@buyer.example' }],
    mailboxes: {
      list: () => [{ id: 'account', email: 'sales@brand.example', configured: true }],
      readMailbox: async (id, options) => {
        calls.push({ id, options });
        return {
          folders: [
            {
              path: 'INBOX',
              uidValidity: '1',
              nextUid: 2,
              messages: [
                {
                  uid: 1,
                  messageId: '<incoming@buyer.example>',
                  direction: 'inbound',
                  from: 'buyer@buyer.example',
                  to: 'sales@brand.example',
                  subject: '<script>Question</script>',
                  bodyText: '<img src="https://tracker.example/pixel">Original text',
                  occurredAt: '2026-10-27T04:00:00Z',
                  unread: true,
                },
              ],
            },
          ],
          hasMore: false,
        };
      },
      send() {
        throw new Error('Unexpected send');
      },
    },
  });
  const app = createApp({
    env: {},
    outreachServiceFactory: () => service,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}/api/v1/outreach/conversations`;
  const headers = { 'Content-Type': 'application/json' };
  const request = (suffix = '', options = {}) => fetch(base + suffix, { headers, ...options });
  assert.equal((await request('', { headers: {} })).status, 200);
  assert.equal(
    (await request('', { headers: { ...headers, Origin: 'https://foreign.example' } })).status,
    403,
  );
  assert.equal(
    (
      await request('/sync', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://foreign.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal((await request()).status, 200);
  assert.deepEqual(calls, []);
  const sync = await request('/sync', {
    method: 'POST',
    body: JSON.stringify({ mailboxId: 'account' }),
  });
  assert.equal(sync.status, 200);
  assert.equal((await sync.json()).imported, 1);
  assert.equal(calls.length, 1);
  const response = await request('?mailboxId=account&unread=1&q=Question');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const list = await response.json();
  assert.equal(list.items.length, 1);
  const id = list.items[0].id;
  const message = service.conversations.detail(id).messages[0];
  service.businessState = () => ({
    messages: [
      {
        id: 'actual',
        customerId: 'buyer',
        account: 'sales@brand.example',
        mailboxMessageId: message.id,
        demandReviewReason: '规格待澄清',
      },
      {
        id: 'other',
        customerId: 'buyer',
        account: 'other@brand.example',
        externalId: message.messageId,
      },
    ],
    demands: [
      { id: 'need', sourceMessageId: 'actual' },
      { id: 'wrong', sourceMessageId: 'other' },
    ],
  });
  const detail = await request('/' + id);
  const content = await detail.json();
  assert.equal(content.messages[0].source, 'imap');
  assert.deepEqual(
    content.demands.map((d) => d.id),
    ['need'],
  );
  assert.deepEqual(content.demandNotices, ['规格待澄清']);
  assert.equal((await (await request('?customerId=another')).json()).items.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(
    (await request('/' + id + '/read', { method: 'POST', body: '{"unread":false}' })).status,
    200,
  );
  assert.equal((await (await request('?unread=1')).json()).items.length, 0);
  assert.equal(
    (await request('/' + id + '/read', { method: 'POST', body: '{"unread":true}' })).status,
    400,
  );
  assert.equal((await request('/' + id, { method: 'DELETE' })).status, 405);
  assert.equal((await request('/missing')).status, 404);
  assert.equal((await request('/sync', { method: 'POST', body: '{"mailboxId":[]}' })).status, 400);
  assert.equal(
    (await request('/sync', { method: 'POST', body: '{"mailboxId":"missing"}' })).status,
    404,
  );
  assert.equal(calls.length, 1);
});
