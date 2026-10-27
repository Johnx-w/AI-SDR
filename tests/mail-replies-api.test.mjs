import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { OutreachService } from '../server/outreach-service.mjs';

test('manual reply API saves a large attachment draft, sends only its original recipient and replays without resending', async (t) => {
  const sent = [],
    archived = [];
  const mailbox = {
    id: 'one',
    email: 'sales@brand.example',
    configured: true,
    smtpStatus: 'connected',
    signature: 'Sales team',
    dailyLimit: 0,
    paused: false,
  };
  const service = new OutreachService({
    mailboxes: {
      list: () => [mailbox],
      readMailbox: async () => ({
        folders: [
          {
            path: 'INBOX',
            uidValidity: '1',
            nextUid: 2,
            messages: [
              {
                uid: 1,
                from: 'buyer@buyer.example',
                to: mailbox.email,
                toAddresses: [mailbox.email],
                replyTo: ['contact@buyer.example'],
                messageId: '<question@buyer.example>',
                subject: 'Catalog',
                bodyText: 'Please send the catalog.',
                direction: 'inbound',
                bodyFormatVersion: 2,
                occurredAt: '2026-10-27T04:00:00Z',
              },
            ],
          },
        ],
        hasMore: false,
      }),
      send: async (_id, value) => {
        sent.push(value);
        return { accepted: [value.to], messageId: value.messageId };
      },
      saveSent: async (_id, value) => {
        archived.push(value.messageId);
        return { saved: true };
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
  const headers = {
    'Content-Type': 'application/json',
  };
  const request = (path, method = 'GET', body, extra = {}) =>
    fetch(base + path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...extra,
    });
  await request('/sync', 'POST', { mailboxId: 'one' });
  const list = await (await request('')).json();
  const id = list.items[0].id;
  const detail = await (await request('/' + id)).json();
  assert.equal(detail.replyContext.to, 'contact@buyer.example');
  assert.equal(detail.replyContext.from, mailbox.email);
  const draft = {
    replyToMessageId: detail.messages[0].id,
    bodyHtml: '<p><strong>Catalog attached</strong></p><script>alert(1)</script>',
    bodyText: 'untrusted alternate',
    attachments: [
      {
        id: 'file',
        name: 'catalog.txt',
        contentType: 'text/plain',
        size: 50000,
        contentBase64: Buffer.alloc(50000, 65).toString('base64'),
      },
    ],
    revision: 0,
  };
  const savedResponse = await request('/' + id + '/draft', 'PUT', draft);
  assert.equal(savedResponse.status, 200);
  const saved = (await savedResponse.json()).draft;
  assert.equal(saved.bodyText, 'Catalog attached');
  assert.doesNotMatch(saved.bodyHtml, /script|alert/);
  assert.equal(sent.length, 0);
  assert.equal((await request('/' + id + '/reply', 'POST', {}, { headers: {} })).status, 415);
  assert.equal(
    (
      await request(
        '/' + id + '/reply',
        'POST',
        {},
        { headers: { ...headers, Origin: 'https://foreign.example' } },
      )
    ).status,
    403,
  );
  const send = {
    ...saved,
    draftRevision: saved.revision,
    idempotencyKey: 'manual-reply-test-once',
    to: 'unexpected@outside.example',
  };
  const result = await request('/' + id + '/reply', 'POST', send);
  assert.equal(result.status, 200);
  const completed = await result.json();
  assert.equal(completed.reply.status, 'accepted');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'contact@buyer.example');
  assert.equal(sent[0].expectedAccount, mailbox.email);
  assert.equal(sent[0].inReplyTo, '<question@buyer.example>');
  assert.equal(sent[0].attachments.length, 1);
  const outgoing = completed.messages.find((message) => message.source === 'manual');
  assert.equal(outgoing.attachments[0].name, 'catalog.txt');
  assert.equal(outgoing.attachments[0].contentBase64, undefined);
  assert.equal((await request('/' + id + '/reply', 'POST', send)).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(archived.length, 1);
  assert.equal((await (await request('/' + id + '/draft')).json()).draft, null);
  assert.equal((await request('/missing/draft')).status, 404);
});
