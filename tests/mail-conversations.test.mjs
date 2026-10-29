import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutreachService } from '../server/outreach-service.mjs';

const at = '2026-10-27T04:00:00.000Z';
const received = (id, extra = {}) => ({
  uid: 1,
  messageId: `<${id}@buyer.example>`,
  from: 'buyer@buyer.example',
  to: 'sales@brand.example',
  direction: 'inbound',
  subject: 'Product question',
  bodyText: 'Please share the product information.',
  occurredAt: at,
  unread: true,
  ...extra,
});
const batch = (messages, nextUid = 2, uidValidity = '1') => ({
  folders: [{ path: 'INBOX', uidValidity, nextUid, messages }],
  hasMore: false,
});

test('format upgrade rescans old cached mail once and enriches HTML without clearing original text or read state', async (t) => {
  const h = harness(t);
  h.respond(batch([received('old-format')]));
  await h.inbox.sync({ mailboxId: 'one' });
  const id = h.inbox.list().items[0].id;
  h.inbox.markRead(id, false);
  const stateRow = h.service.db.prepare('SELECT account_key,data FROM mailbox_sync_state').get();
  const oldState = JSON.parse(stateRow.data);
  delete oldState.contentVersion;
  h.service.db
    .prepare('UPDATE mailbox_sync_state SET data=? WHERE account_key=?')
    .run(JSON.stringify(oldState), stateRow.account_key);
  h.respond((_id, options) => {
    assert.deepEqual(options.cursors, {});
    return batch([
      received('old-format', {
        bodyText: 'Parser produced different text',
        bodyHtml: '<table><tr><td>Original styled content</td></tr></table>',
        bodyFormatVersion: 2,
        replyTo: ['reply@buyer.example'],
        toAddresses: ['sales@brand.example'],
        references: ['<parent@buyer.example>'],
      }),
    ]);
  });
  assert.equal((await h.inbox.sync({ mailboxId: 'one' })).imported, 0);
  const detail = h.inbox.detail(id);
  assert.equal(detail.conversation.unread, false);
  assert.equal(detail.messages[0].bodyText, 'Please share the product information.');
  assert.match(detail.messages[0].bodyHtml, /<table>/);
  assert.deepEqual(detail.messages[0].replyTo, ['reply@buyer.example']);
  h.respond((_id, options) => {
    assert.equal(options.cursors.INBOX.nextUid, 2);
    return batch([]);
  });
  await h.inbox.sync({ mailboxId: 'one' });
});

function harness(t, extra = {}) {
  const boxes = [
    { id: 'one', email: 'sales@brand.example', configured: true, paused: true },
    { id: 'two', email: 'other@brand.example', configured: true, paused: false },
  ];
  const calls = [];
  let response = batch([]);
  const mailboxes = {
    list: () => structuredClone(boxes),
    readMailbox: async (id, options) => {
      calls.push({ id, options });
      return typeof response === 'function' ? response(id, options) : structuredClone(response);
    },
    send() {
      throw new Error('Inbox must never send');
    },
  };
  const service = new OutreachService({ mailboxes, now: () => Date.parse(at), ...extra });
  t.after(() => service.close());
  return {
    service,
    inbox: service.conversations,
    calls,
    boxes,
    respond(value) {
      response = value;
    },
  };
}

test('mailbox classification reaches business recording and resync preserves previously recorded classifications', async (t) => {
  const recorded = [];
  const h = harness(t, { recordCommunication: async (detail) => recorded.push(detail) });
  h.respond(batch([received('automatic', { classification: 'auto_reply' })]));
  await h.inbox.sync({ mailboxId: 'one' });
  const id = h.inbox.list().items[0].id;
  assert.equal(h.inbox.detail(id).messages[0].classification, 'auto_reply');
  assert.equal(recorded[0].messages[0].classification, 'auto_reply');
  h.respond(batch([received('automatic', { classification: 'normal', bodyFormatVersion: 2 })]));
  await h.inbox.sync({ mailboxId: 'one' });
  assert.equal(h.inbox.detail(id).messages[0].classification, 'auto_reply');
  assert.equal(recorded.at(-1).messages[0].classification, 'auto_reply');
});

test('cached reads never connect; an accepted first touch joins an actual reply with its original mailbox', async (t) => {
  const h = harness(t);
  h.service.putDelivery({
    id: 'delivery',
    campaignId: 'campaign',
    mailboxId: 'one',
    from: h.boxes[0].email,
    to: 'buyer@buyer.example',
    subject: 'Introduction',
    bodyText: 'Our approved company introduction.',
    status: 'accepted',
    messageId: '<first@brand.example>',
    sentAt: '2026-10-26T04:00:00Z',
    customerId: 'company',
    companyName: 'Buyer Company',
  });
  let list = h.inbox.list();
  assert.equal(list.items.length, 1);
  assert.deepEqual(h.calls, []);
  const threadId = list.items[0].id;
  assert.equal(h.inbox.detail(threadId).messages[0].deliveryStatus, 'accepted');
  h.respond(batch([received('reply', { inReplyTo: '<first@brand.example>' })]));
  assert.equal((await h.inbox.sync({ mailboxId: 'one' })).imported, 1);
  list = h.inbox.list({ unread: true, q: 'Buyer Company' });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, threadId);
  assert.equal(list.items[0].messageCount, 2);
  assert.equal(list.items[0].customerId, 'company');
  assert.equal(h.inbox.detail(threadId).messages.at(-1).deliveryStatus, 'received');
});

test('read state survives repeat sync and only a newly received message restores unread', async (t) => {
  const h = harness(t);
  const message = received('reply');
  h.respond(batch([message]));
  await h.inbox.sync({ mailboxId: 'one' });
  const id = h.inbox.list().items[0].id;
  h.inbox.markRead(id, false);
  assert.equal(h.inbox.list({ unread: true }).items.length, 0);
  assert.equal((await h.inbox.sync({ mailboxId: 'one' })).imported, 0);
  assert.equal(h.inbox.list().items[0].unread, false);
  h.respond(batch([received('second', { uid: 2, references: [message.messageId] })], 3));
  await h.inbox.sync({ mailboxId: 'one' });
  assert.equal(h.inbox.list({ unread: true }).items.length, 1);
  assert.equal(h.inbox.detail(id).messages.length, 2);
});

test('late references merge replies, while equal subjects and message IDs in another account stay separate', async (t) => {
  const h = harness(t);
  h.respond(
    batch(
      [
        received('a', { inReplyTo: '<root-a@buyer.example>' }),
        received('b', { uid: 2, inReplyTo: '<root-b@buyer.example>' }),
      ],
      3,
    ),
  );
  await h.inbox.sync({ mailboxId: 'one' });
  assert.equal(h.inbox.list().items.length, 2);
  h.respond(
    batch(
      [
        received('join', {
          uid: 3,
          references: ['<root-a@buyer.example>', '<root-b@buyer.example>'],
        }),
      ],
      4,
    ),
  );
  await h.inbox.sync({ mailboxId: 'one' });
  assert.equal(h.inbox.list().items.length, 1);
  assert.equal(h.inbox.list().items[0].messageCount, 3);
  await h.inbox.sync({ mailboxId: 'two' });
  assert.equal(h.inbox.list().items.length, 2);
  assert.equal(h.inbox.list({ mailboxId: 'two' }).items[0].messageCount, 1);
});

test('UIDVALIDITY resets deduplicate existing messages and retain persisted sync and local read state', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mail-conversations-'));
  t.after(async () => {
    await h.service.close();
    await second.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'outreach.sqlite');
  const h = harness(t, { path });
  h.respond(batch([received('persisted')]));
  await h.inbox.sync({ mailboxId: 'one' });
  const id = h.inbox.list().items[0].id;
  h.inbox.markRead(id, false);
  const second = new OutreachService({
    path,
    mailboxes: {
      list: () => structuredClone(h.boxes),
      readMailbox: async (_id, options) => {
        assert.equal(options.cursors.INBOX.nextUid, 2);
        return batch([received('persisted', { uid: 8 })], 9, '2');
      },
    },
    now: () => Date.parse(at),
  });
  t.after(() => second.close());
  assert.equal(second.conversations.list().items[0].unread, false);
  assert.equal((await second.conversations.sync({ mailboxId: 'one' })).imported, 0);
  assert.equal(second.conversations.detail(id).messages.length, 1);
});

test('a partial failure retains the previous cursor and content without leaking provider diagnostics', async (t) => {
  const h = harness(t);
  h.respond(batch([received('initial')]));
  await h.inbox.sync({ mailboxId: 'one' });
  const successfulAt = h.inbox.list().mailboxes[0].lastSyncAt;
  h.respond(() => {
    throw new Error('AUTH failed with private-password');
  });
  const result = await h.inbox.sync({ mailboxId: 'one' });
  assert.equal(result.imported, 0);
  assert.equal(result.mailboxes[0].lastSyncAt, successfulAt);
  assert.ok(result.mailboxes[0].error);
  assert.doesNotMatch(JSON.stringify(result), /private-password/);
  h.respond((_id, options) => {
    assert.deepEqual(options.cursors, { INBOX: { uidValidity: '1', nextUid: 2 } });
    return batch([received('new', { uid: 2 })], 3);
  });
  await h.inbox.sync({ mailboxId: 'one' });
  assert.equal(h.inbox.list().mailboxes[0].error, null);
  assert.equal(h.inbox.list().items.length, 2);
});

test('invalid batches roll back all messages and cursor; one failing account does not block another', async (t) => {
  const h = harness(t);
  h.respond((id) =>
    id === 'one'
      ? batch([received('valid'), received('invalid', { uid: 2, from: 'bad address' })], 3)
      : batch([received('other')]),
  );
  const result = await h.inbox.sync();
  assert.equal(result.imported, 1);
  assert.equal(h.inbox.list({ mailboxId: 'one' }).items.length, 0);
  assert.equal(result.mailboxes[0].lastSyncAt, null);
  assert.ok(result.mailboxes[0].error);
  assert.equal(h.inbox.list({ mailboxId: 'two' }).items.length, 1);
});

test('concurrent manual requests share one read; changing mailbox identity hides the old cache and resets cursors', async (t) => {
  const h = harness(t);
  let release;
  h.respond(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = h.inbox.sync({ mailboxId: 'one' });
  const second = h.inbox.sync({ mailboxId: 'one' });
  assert.equal(h.calls.length, 1);
  release(batch([received('original')]));
  await Promise.all([first, second]);
  const original = h.inbox.list().items[0].id;
  h.boxes[0].email = 'replacement@brand.example';
  assert.equal(h.inbox.list().items.length, 0);
  assert.throws(() => h.inbox.detail(original), { status: 404 });
  h.respond((_id, options) => {
    assert.deepEqual(options.cursors, {});
    return batch([]);
  });
  await h.inbox.sync({ mailboxId: 'one' });
});

test('unknown sends do not become sent mail; IMAP sent confirmation deduplicates acceptance without rewriting original content', async (t) => {
  const h = harness(t);
  const delivery = {
    id: 'send',
    campaignId: 'c',
    mailboxId: 'one',
    from: h.boxes[0].email,
    to: 'buyer@buyer.example',
    subject: 'Intro',
    bodyText: 'Original body',
    status: 'unknown',
    messageId: '<send@brand.example>',
    sentAt: at,
  };
  h.service.putDelivery(delivery);
  assert.equal(h.inbox.list().items.length, 0);
  h.service.putDelivery({ ...delivery, status: 'accepted' });
  const id = h.inbox.list().items[0].id;
  h.respond(
    batch([
      received('unused', {
        direction: 'outbound',
        from: delivery.from,
        to: delivery.to,
        messageId: delivery.messageId,
        bodyText: 'Provider transformed body',
      }),
    ]),
  );
  assert.equal((await h.inbox.sync({ mailboxId: 'one' })).imported, 0);
  const detail = h.inbox.detail(id);
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].bodyText, 'Original body');
  assert.equal(detail.messages[0].deliveryStatus, 'sent');
});

test('customer links use unambiguous exact addresses from local data only', async (t) => {
  const h = harness(t, {
    customers: () => [{ id: 'company', name: 'Buyer', email: 'buyer@buyer.example' }],
  });
  h.respond(batch([received('known')]));
  await h.inbox.sync({ mailboxId: 'one' });
  assert.equal(h.inbox.list().items[0].customerId, 'company');
  assert.throws(() => h.inbox.markRead(h.inbox.list().items[0].id, true), { status: 400 });
  await assert.rejects(h.inbox.sync({ mailboxId: 'unknown' }), { status: 404 });
});

test('a reply reusing an outgoing Message-ID stays an incoming fact rather than upgrading SMTP acceptance', async (t) => {
  const h = harness(t);
  h.service.putDelivery({
    id: 'send',
    campaignId: 'c',
    mailboxId: 'one',
    from: h.boxes[0].email,
    to: 'buyer@buyer.example',
    subject: 'Intro',
    bodyText: 'Original body',
    status: 'accepted',
    messageId: '<reused@brand.example>',
    sentAt: at,
  });
  const id = h.inbox.list().items[0].id;
  h.respond(batch([received('unused', { messageId: '<reused@brand.example>' })]));
  await h.inbox.sync({ mailboxId: 'one' });
  const messages = h.inbox.detail(id).messages;
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((m) => m.deliveryStatus).sort(), ['accepted', 'received']);
});

test('search includes earlier message bodies and full text beyond the list preview', async (t) => {
  const h = harness(t);
  h.respond(batch([received('first', { bodyText: 'A'.repeat(500) + 'requested-specification' })]));
  await h.inbox.sync({ mailboxId: 'one' });
  h.respond(
    batch(
      [received('second', { uid: 2, inReplyTo: '<first@buyer.example>', bodyText: 'Thanks' })],
      3,
    ),
  );
  await h.inbox.sync({ mailboxId: 'one' });
  assert.equal(h.inbox.list({ q: 'requested-specification' }).items.length, 1);
});
