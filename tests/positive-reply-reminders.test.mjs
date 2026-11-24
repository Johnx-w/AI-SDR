import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutreachService } from '../server/outreach-service.mjs';
import { mailboxAccountKey, positiveReplyTaskSql } from '../server/mail-conversations.mjs';
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
  for (const [index, args] of messages.entries()) {
    service.conversations.putMessage(args[0], received(...args));
    assert.deepEqual(
      service.conversations.positiveReplyTasks().map((item) => item.requestType),
      ['quote', 'catalog', 'meeting'].slice(0, index + 1),
      '来信按时间顺序逐条形成待办',
    );
  }
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
  assert.equal(Date.parse(reminders[0].receivedAt), Date.parse('2026-03-01T08:00:00Z'));

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
  assert.deepEqual(
    service.conversations.positiveReplyTasks().map((item) => item.requestType),
    ['catalog', 'meeting'],
    '实际发出的索价回复只结束对应待办',
  );
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

  service.conversations.putMessage(boxes[0], {
    messageId: '<meeting-answer@one.example>',
    inReplyTo: meeting.externalId,
    direction: 'outbound',
    source: 'imap',
    deliveryStatus: 'sent',
    from: boxes[0].email,
    to: meeting.from,
    toAddresses: [meeting.from],
    subject: 'Re: Product',
    bodyText: 'The meeting is confirmed.',
    occurredAt: '2026-03-05T09:00:00Z',
  });
  assert.deepEqual(service.conversations.positiveReplyTasks(), []);
});

test('积极回复等待时长以服务器收件时间而非邮件 Date 头起算', (t) => {
  const service = new OutreachService({
    mailboxes: { list: () => structuredClone(boxes), send: assert.fail },
    now: () => Date.parse('2026-03-05T12:00:00Z'),
  });
  t.after(() => service.close());
  service.conversations.putMessage(
    boxes[0],
    received(boxes[0], 'delayed', 'Please provide a quotation.', '2026-03-01T08:00:00Z', {
      receivedAt: '2026-03-04T08:00:00Z',
    }),
  );
  const [task] = service.conversations.positiveReplyTasks();
  assert.equal(Date.parse(task.receivedAt), Date.parse('2026-03-04T08:00:00Z'));
  assert.equal(task.waitingHours, 28);
  const plan = service.db
    .prepare('EXPLAIN QUERY PLAN ' + positiveReplyTaskSql(boxes.length))
    .all(...boxes.flatMap((box) => [mailboxAccountKey(box), box.email.toLowerCase()]), 25, 0);
  assert(
    plan.some((step) => /mailbox_positive_tasks/.test(step.detail)),
    plan.map((step) => step.detail).join('\n'),
  );
  assert(
    plan.some((step) => /mailbox_reply_parent/.test(step.detail)),
    plan.map((step) => step.detail).join('\n'),
  );
});
test('同线程新来信只打开新请求，内部 QA 始终排除', (t) => {
  const service = new OutreachService({
    mailboxes: { list: () => structuredClone(boxes), send: assert.fail },
  });
  t.after(() => service.close());
  const inbox = service.conversations,
    box = boxes[0],
    now = Date.parse('2026-03-02T09:00:00Z');
  const q = received(box, 'q', 'Please send a quote.', '2026-03-01T08:00:00Z');
  inbox.putMessage(box, q);
  const [first] = inbox.positiveReplyTasks();
  updateThreadWorkflow(service.db, first.threadId, { state: 'done' }, now);
  inbox.putMessage(
    box,
    received(box, 'thanks', 'Thanks!', '2026-03-03T09:00:00Z', {
      from: q.from,
      inReplyTo: q.messageId,
    }),
  );
  assert.equal(inbox.positiveReplyTasks().length, 0);
  inbox.putMessage(
    box,
    received(box, 'next', 'Please send a catalog.', '2026-03-04T09:00:00Z', {
      from: q.from,
      inReplyTo: q.messageId,
    }),
  );
  inbox.putMessage(
    box,
    received(box, 'qa', 'Please send a quote.', '2026-03-05T09:00:00Z', {
      from: boxes[1].email,
      subject: '[AI-SDR Internal QA check]',
    }),
  );
  assert.deepEqual(
    inbox.positiveReplyTasks().map((i) => i.requestType),
    ['catalog'],
  );
});
test('旧库首次读取恢复线下完成事实，重开后补录更早的请求也保持结案', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'positive-migration-'));
  const config = {
    path: join(directory, 'outreach.sqlite'),
    mailboxes: { list: () => structuredClone(boxes), send: assert.fail },
  };
  let service = new OutreachService(config);
  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const box = boxes[0],
    old = received(box, 'old', 'Please provide a quote.', '2026-03-01T08:00:00Z');
  service.conversations.putMessage(box, old);
  const [task] = service.conversations.positiveReplyTasks();
  service.db
    .prepare('INSERT INTO mail_thread_workflow VALUES(?,?,NULL,?)')
    .run(task.threadId, 'done', '2026-03-03T08:00:00.000Z');
  service.db.exec(
    'DELETE FROM mailbox_summary_migrations WHERE version=4; DROP TRIGGER mail_completed_history; DROP TABLE mail_offline_handled; DROP TABLE mail_thread_completions',
  );
  await service.close();
  service = new OutreachService(config);
  assert.equal(service.conversations.positiveReplyCount(), 0);
  const later = received(box, 'later', 'Yes, happy to meet next week.', '2026-03-04T08:00:00Z', {
    from: old.from,
    inReplyTo: old.messageId,
  });
  const backdated = received(
    box,
    'backdated',
    'Please send your catalog.',
    '2026-03-02T08:00:00Z',
    { from: old.from, inReplyTo: old.messageId },
  );
  for (const m of [later, backdated, old, backdated]) service.conversations.putMessage(box, m);
  await service.close();
  service = new OutreachService(config);
  assert.deepEqual(
    service.conversations.positiveReplyTasks().map((t) => t.requestType),
    ['meeting'],
  );
});
