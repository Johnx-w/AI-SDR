import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutreachService } from '../server/outreach-service.mjs';
import { mailboxAccountKey, positiveReplyTaskSql } from '../server/mail-conversations.mjs';

import { createApp } from '../server/app.mjs';

const directory = mkdtempSync(join(tmpdir(), 'reply-read-benchmark-'));
const boxes = [
  { id: 'one', email: 'sales@one.example', configured: true },
  { id: 'two', email: 'sales@two.example', configured: true },
  { id: 'three', email: 'sales@three.example', configured: true },
];
const service = new OutreachService({
  path: join(directory, 'outreach.sqlite'),
  mailboxes: { list: () => structuredClone(boxes), send: assert.fail },
  now: () => Date.parse('2026-11-24T04:00:00Z'),
});
const count = 1203;
let app;

try {
  const thread = service.db.prepare('INSERT INTO mailbox_threads VALUES(?,?,?)');
  const message = service.db.prepare('INSERT INTO mailbox_thread_messages VALUES(?,?,?,?)');
  service.db.exec('BEGIN');
  for (let index = 0; index < count; index++) {
    const box = boxes[index % boxes.length];
    const accountKey = mailboxAccountKey(box);
    const id = String(index).padStart(4, '0');
    const threadId = 'thread-' + id;
    const receivedAt = new Date(Date.UTC(2026, 0, 1) + index * 60000).toISOString();
    const businessKind = index % 7 === 0 ? 'positive' : index % 7 === 1 ? 'notification' : 'other';
    const requestType =
      businessKind === 'positive' ? ['quote', 'catalog', 'meeting'][index % 3] : null;
    thread.run(
      threadId,
      accountKey,
      JSON.stringify({ participant: `buyer-${id}@example.test`, updatedAt: receivedAt }),
    );
    message.run(
      'in-' + id,
      accountKey,
      threadId,
      JSON.stringify({
        direction: 'inbound',
        source: 'imap',
        from: `buyer-${id}@example.test`,
        to: box.email,
        toAddresses: [box.email],
        subject: 'Re: Product ' + id,
        bodyText: 'x'.repeat(8192),
        occurredAt: receivedAt,
        receivedAt,
        messageId: `<in-${id}@example.test>`,
        classification: businessKind === 'notification' ? 'auto_reply' : 'normal',
        businessKind,
        requestType,
      }),
    );
    if (businessKind === 'positive' && index % 5 === 0) {
      message.run(
        'out-' + id,
        accountKey,
        threadId,
        JSON.stringify({
          direction: 'outbound',
          source: 'imap',
          from: box.email,
          to: `buyer-${id}@example.test`,
          toAddresses: [`buyer-${id}@example.test`],
          subject: 'Re: Product ' + id,
          bodyText: 'Handled',
          occurredAt: new Date(Date.parse(receivedAt) + 30000).toISOString(),
          receivedAt: new Date(Date.parse(receivedAt) + 30000).toISOString(),
          messageId: `<out-${id}@example.test>`,
          inReplyTo: `<in-${id}@example.test>`,
          classification: 'normal',
        }),
      );
    }
  }
  service.db.exec('COMMIT');

  app = createApp({
    env: {},
    outreachServiceFactory: () => ({
      conversations: service.conversations,
      mailboxes: service.mailboxes,
      close() {},
    }),
    fetchImpl: assert.fail,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const root = 'http://127.0.0.1:' + app.address().port + '/api/v1/';
  for (const [label, path, check] of [
    [
      '来信首页',
      'outreach/reply-history?kind=all',
      (r) => r.total === count && r.items[0].id === 'in-1202',
    ],
    [
      '组合筛选',
      'outreach/reply-history?kind=all&businessKind=positive&handling=unanswered',
      (r) => r.total === 137 && r.items.every((i) => i.businessKind === 'positive'),
    ],
    [
      '第40页',
      'outreach/reply-history?kind=all&page=40',
      (r) => r.total === count && r.items[0].id === 'in-0227',
    ],
    [
      '工作台',
      'overview',
      (r) =>
        r.positiveReplyTotal === 137 &&
        r.positiveReplies.length === 25 &&
        r.positiveReplies[0].id === 'in-0007',
    ],
    [
      '待办末页',
      'overview?positivePage=6',
      (r) =>
        r.positiveReplyPage === 6 &&
        r.positiveReplies.length === 12 &&
        r.positiveReplies.at(-1).id === 'in-1197',
    ],
    ['提醒角标', 'overview?summary=reminders', (r) => r.count === 137],
  ]) {
    const times = [];
    let bytes;
    for (let run = 0; run < 22; run++) {
      const start = performance.now();
      const response = await fetch(root + path);
      const raw = await response.text();
      times.push(performance.now() - start);
      assert.equal(response.status, 200);
      assert.ok(check(JSON.parse(raw)), label);
      bytes = Buffer.byteLength(raw);
    }
    const firstMs = times.shift();
    times.sort((a, b) => a - b);
    console.log(label, {
      firstMs: firstMs.toFixed(2),
      p50Ms: times[10].toFixed(2),
      maxMs: times.at(-1).toFixed(2),
      bytes,
    });
  }
  const sql = positiveReplyTaskSql(boxes.length);
  const plan = service.db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(...boxes.flatMap((box) => [mailboxAccountKey(box), box.email.toLowerCase()]), 25, 0);
  console.log('待办查询计划');
  for (const step of plan) console.log('-', step.detail);
} finally {
  if (app) await new Promise((resolve) => app.close(resolve));
  await service.close();
  rmSync(directory, { recursive: true, force: true });
}
