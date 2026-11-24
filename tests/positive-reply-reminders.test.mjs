import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutreachService } from '../server/outreach-service.mjs';
import { updateThreadWorkflow } from '../server/mail-thread-workflow.mjs';

const boxes = [
  { id: 'one', email: 'sales@one.example', configured: true },
  { id: 'two', email: 'sales@two.example', configured: true },
];
const received = (mailbox, id, bodyText, occurredAt, patch = {}) => ({
  messageId: `<${id}@buyer.example>`,
  direction: 'inbound',
  source: 'imap',
  deliveryStatus: 'received',
  from: `${id}@customer.example`,
  to: mailbox.email,
  toAddresses: [mailbox.email],
  subject: 'Re: Product',
  bodyText,
  occurredAt,
  receivedAt: occurredAt,
  ...patch,
});

test('积极回复待办按来信时间出现，以实际回复或线下完成结束并跨邮箱、重复同步、重启幂等', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'positive-replies-'));
  const path = join(directory, 'outreach.sqlite');
  const mailboxes = { list: () => structuredClone(boxes), send: assert.fail };
  let service = new OutreachService({
    path,
    mailboxes,
    now: () => Date.parse('2026-03-05T12:00:00Z'),
  });
  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const messages = [
    [boxes[0], 'quote', 'Please send your price list.', '2026-03-01T08:00:00Z'],
    [boxes[1], 'catalog', 'Could you share your latest catalogue?', '2026-03-02T08:00:00Z'],
    [
      boxes[0],
      'meeting',
      'We are interested and happy to arrange a meeting.',
      '2026-03-03T08:00:00Z',
    ],
  ];
  for (const args of messages) service.conversations.putMessage(args[0], received(...args));
  service.conversations.putMessage(
    boxes[0],
    received(
      boxes[0],
      'notice',
      'Automatic reply: our support team received case #88412.',
      '2026-03-03T09:00:00Z',
    ),
  );
  service.conversations.putMessage(
    boxes[0],
    received(boxes[0], 'bounce', 'Address not found.', '2026-03-03T10:00:00Z', {
      from: 'postmaster@buyer.example',
      subject: 'Delivery failure',
    }),
  );
  // Replaying an already cached message does not create another reminder.
  service.conversations.putMessage(boxes[0], received(...messages[0]));
  let reminders = service.conversations.positiveReplyTasks();
  assert.deepEqual(
    reminders.map((item) => item.requestType),
    ['quote', 'catalog', 'meeting'],
  );
  assert.deepEqual(
    reminders.map((item) => item.mailboxId),
    ['one', 'two', 'one'],
  );
  assert.ok(reminders.every((item) => item.to.includes('thread=' + item.threadId)));

  const meeting = reminders[2];
  service.replies.saveDraft(meeting.threadId, {
    replyToMessageId: meeting.messageId,
    bodyHtml: '<p>Unsent draft</p>',
    attachments: [],
    revision: 0,
  });
  assert.equal(service.conversations.positiveReplyTasks().length, 3, '草稿不能结束待办');

  const quote = reminders[0];
  service.conversations.putMessage(boxes[0], {
    messageId: '<quote-answer@one.example>',
    inReplyTo: quote.externalId,
    direction: 'outbound',
    source: 'manual',
    deliveryStatus: 'accepted',
    from: boxes[0].email,
    to: quote.from,
    toAddresses: [quote.from],
    subject: 'Re: Product',
    bodyText: 'Attached is the requested price list.',
    occurredAt: '2026-03-04T08:00:00Z',
  });
  const catalog = reminders[1];
  updateThreadWorkflow(
    service.db,
    catalog.threadId,
    { state: 'done' },
    Date.parse('2026-03-04T09:00:00Z'),
  );
  assert.deepEqual(
    service.conversations.positiveReplyTasks().map((item) => item.requestType),
    ['meeting'],
  );

  service.close();
  service = new OutreachService({ path, mailboxes, now: () => Date.parse('2026-03-05T12:00:00Z') });
  reminders = service.conversations.positiveReplyTasks();
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].id, meeting.id);
  assert.equal(reminders[0].waitingHours, 52);
});
