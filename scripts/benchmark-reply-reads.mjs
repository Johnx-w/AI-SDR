import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutreachService } from '../server/outreach-service.mjs';
import { mailboxAccountKey, positiveReplyTaskSql } from '../server/mail-conversations.mjs';

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

  for (const [label, filters, expected] of [
    ['来信首页', { mailboxId: 'all', kind: 'all', page: '1' }, count],
    [
      '积极且未回复筛选',
      { mailboxId: 'all', kind: 'all', businessKind: 'positive', handling: 'unanswered' },
      137,
    ],
    ['来信后续页', { mailboxId: 'all', kind: 'all', page: '40' }, count],
  ]) {
    const times = [];
    let bytes = 0;
    for (let run = 0; run < 22; run++) {
      const start = performance.now();
      const result = service.conversations.replyHistory(filters);
      times.push(performance.now() - start);
      bytes = Buffer.byteLength(JSON.stringify(result));
      assert.equal(result.total, expected);
    }
    const firstMs = times.shift();
    times.sort((left, right) => left - right);
    console.log(label, {
      firstMs: Number(firstMs.toFixed(2)),
      p50Ms: Number(times[10].toFixed(2)),
      maxMs: Number(times.at(-1).toFixed(2)),
      bytes,
    });
  }

  const taskTimes = [];
  let taskBytes = 0;
  for (let run = 0; run < 22; run++) {
    const start = performance.now();
    const tasks = service.conversations.positiveReplyTasks();
    taskTimes.push(performance.now() - start);
    taskBytes = Buffer.byteLength(JSON.stringify(tasks));
    assert.equal(tasks.length, 137);
  }
  const taskFirst = taskTimes.shift();
  taskTimes.sort((left, right) => left - right);
  console.log('工作台积极回复待办', {
    firstMs: Number(taskFirst.toFixed(2)),
    p50Ms: Number(taskTimes[10].toFixed(2)),
    maxMs: Number(taskTimes.at(-1).toFixed(2)),
    bytes: taskBytes,
  });

  const sql = positiveReplyTaskSql(boxes.length);
  const plan = service.db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(...boxes.flatMap((box) => [mailboxAccountKey(box), box.email.toLowerCase()]));
  console.log('待办查询计划');
  for (const step of plan) console.log('-', step.detail);
} finally {
  await service.close();
  rmSync(directory, { recursive: true, force: true });
}
