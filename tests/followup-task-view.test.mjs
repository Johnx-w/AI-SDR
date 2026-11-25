import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { OutreachService } from '../server/outreach-service.mjs';

test('追信任务按业务来源分页，详情核对客户、原会话和邮件', async (t) => {
  const box = { id: 'sales', email: 'sales@brand.example' };
  const people = ['north', 'south', 'quiet'].map((id) => ({ id, email: id + '@buyer.example' }));
  const outbound = () => {
    throw Error('读取不应调用外部服务');
  };
  const now = Date.parse('2026-11-25T08:00:00Z');
  const svc = new OutreachService({
    customers: () => people,
    mailboxes: { list: () => [box], send: outbound },
    fetchImpl: outbound,
    now: () => now,
  });
  const app = createApp({ env: {}, outreachServiceFactory: () => svc, fetchImpl: outbound });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = 'http://127.0.0.1:' + app.address().port + '/api/v1/business/followups';
  async function read(path = '') {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    return { value: await response.json(), size: Number(response.headers.get('content-length')) };
  }
  const plan = { id: 'plan', name: '澳洲开发', mode: 'production', scope: svc.getScope() };
  svc.putCampaign(plan);
  svc.putCampaign({ ...plan, id: 'other-plan', scope: 'other' });
  function first(id, c, planId = plan.id) {
    const item = {
      id,
      campaignId: planId,
      customerId: c.id,
      companyName: c.id.toUpperCase(),
      mode: 'production',
      mailboxId: box.id,
      from: box.email,
      to: c.email,
      sentAt: '2026-11-20T08:00:00.000Z',
      status: 'accepted',
      subject: 'First ' + c.id,
      bodyText: 'Original ' + c.id,
      messageId: '<' + id + '@brand.example>',
    };
    svc.putDelivery(item);
    return item;
  }
  const north = first('first-north', people[0]),
    south = first('first-south', people[1]);
  const quiet = first('first-quiet', people[2]);
  first('first-west', { id: 'west', email: 'west@buyer.example' });
  const returned = first('first-bounced', { id: 'bounced', email: 'bounce@buyer.example' });
  svc.db
    .prepare('INSERT INTO outreach_delivery_bounces(delivery_id,received_at) VALUES(?,?)')
    .run(returned.id, quiet.sentAt);
  const blocked = first('first-blocked', { id: 'blocked', email: 'blocked@buyer.example' });
  svc.db.prepare('INSERT INTO outreach_suppression VALUES(?,?)').run('email:' + blocked.to, '退订');
  const answered = first('first-answered', { id: 'answered', email: 'answered@buyer.example' });
  const baseTask = {
    step: 1,
    dueAt: '2026-11-25T09:00:00.000Z',
    status: 'pending',
    mailboxId: box.id,
    from: box.email,
  };
  function task(id, letter, patch = {}) {
    svc.followUps.put({
      ...baseTask,
      id,
      firstId: letter.id,
      campaignId: letter.campaignId,
      customerId: letter.customerId,
      to: letter.to,
      ...patch,
    });
  }
  task('north-sent', north, {
    status: 'accepted',
    subject: 'North follow-up',
    bodyText: 'North original reply',
    sentAt: '2026-11-23T08:01:00.000Z',
    dueAt: '2026-11-23T08:00:00.000Z',
  });
  task('south-stopped', south, {
    status: 'cancelled',
    reason: '收到客户来信，结束本轮追信',
    day: 4,
    policyRevision: 2,
  });
  task('south-review', south, {
    status: 'unknown',
    reason: '发送时服务中断，需核对原邮箱，不自动重发',
  });
  task('south-not-reply', south, { status: 'cancelled', reason: '原邮件已确认退信' });
  task('foreign', first('foreign-first', people[1], 'other-plan'));
  svc.conversations.importDeliveries();
  for (const letter of [north, south, answered]) {
    svc.conversations.putMessage(box, {
      direction: 'inbound',
      source: 'imap',
      classification: 'normal',
      from: letter.to,
      to: letter.from,
      subject: 'Reply from ' + letter.customerId,
      bodyText: 'Body ' + letter.customerId,
      messageId: '<r-' + letter.id + '@buyer.example>',
      inReplyTo: letter.messageId,
      occurredAt: '2026-11-24T08:00:00.000Z',
      deliveryStatus: 'received',
    });
  }
  task('north-next', north, { step: 2 });
  const list = await read();
  assert.deepEqual(list.value.counts, { all: 7, upcoming: 1, review: 3, responded: 1 });
  assert.equal(
    list.value.items.some((row) => Object.hasOwn(row, 'bodyText')),
    false,
  );
  assert.deepEqual(
    (await read('?queue=upcoming&bucket=today&asOf=2026-11-25T08:00:00Z')).value.items.map(
      (t) => t.id,
    ),
    ['north-next'],
  );
  assert.deepEqual(
    (await read('?customerId=north&q=NORTH')).value.items.map((t) => t.id),
    ['north-next', 'north-sent'],
  );
  for (const id of ['quiet', 'west']) {
    const scoped = (await read('?queue=review&customerId=' + id)).value;
    assert.deepEqual(
      scoped.items.map((r) => [r.customerId, r.status, r.dueAt]),
      [[id, 'candidate', null]],
    );
    const detail = (await read('/' + scoped.items[0].id)).value;
    assert.deepEqual(
      detail.messages.map((m) => [m.kind, m.bodyText]),
      [['first', 'Original ' + id]],
    );
    assert.ok(detail.thread);
  }
  for (const id of ['answered', 'blocked', 'bounced', 'missing']) {
    assert.equal((await read('?customerId=' + id)).value.total, 0);
    assert.equal((await fetch(base + '/candidate-first-' + id)).status, 404);
  }
  assert.equal((await read('?queue=upcoming&customerId=quiet')).value.total, 0);
  assert.equal(svc.db.prepare('SELECT count(*) AS n FROM outreach_followups').get().n, 6);
  const sent = (await read('/north-sent')).value,
    stopped = (await read('/south-stopped')).value;
  assert.deepEqual(
    sent.messages.map((m) => m.bodyText),
    ['Original north', 'North original reply'],
  );
  assert.deepEqual(
    stopped.messages.map((m) => m.bodyText),
    ['Original south', 'Body south'],
  );
  assert.equal(stopped.policyRevision, 2);
  assert.ok(sent.thread && stopped.thread && sent.thread !== stopped.thread);
  assert.deepEqual(
    svc.conversations.detail(stopped.thread).messages.map((m) => m.subject),
    ['First south', 'Reply from south'],
  );
  assert.equal((await fetch(base + '/foreign')).status, 404);
  for (let i = 0; i < 1203; i++) task('bulk-' + i, north, { bodyText: 'x'.repeat(8192) });
  const times = [];
  const firstPage = await read('?customerId=north&queue=upcoming');
  assert.equal(firstPage.value.items.length, 25);
  assert.ok(firstPage.size < 16000);
  for (let i = 0; i < 15; i++) {
    const at = performance.now(),
      page = await read('?customerId=north&queue=upcoming&page=49');
    times.push(performance.now() - at);
    assert.equal(page.value.total, 1204);
    assert.equal(page.value.items.length, 4);
    assert.ok(page.size < 5000);
    assert.equal(
      page.value.items.some((row) => row.id === 'south-stopped'),
      false,
    );
  }
  const later = await read('?customerId=quiet');
  svc.conversations.putMessage(box, {
    direction: 'inbound',
    source: 'imap',
    classification: 'auto_reply',
    from: quiet.to,
    to: quiet.from,
    subject: 'Automatic reply',
    bodyText: 'Out of office',
    messageId: '<auto@buyer.example>',
    inReplyTo: quiet.messageId,
    occurredAt: '2026-11-24T09:00:00Z',
    deliveryStatus: 'received',
  });
  assert.equal((await read('?customerId=quiet')).value.total, later.value.total);
  svc.conversations.putMessage(box, {
    direction: 'outbound',
    source: 'imap',
    from: quiet.from,
    to: quiet.to,
    subject: 'Re: First quiet',
    bodyText: 'Personal follow-up',
    messageId: '<manual@brand.example>',
    inReplyTo: quiet.messageId,
    occurredAt: '2026-11-24T10:00:00Z',
    deliveryStatus: 'sent',
  });
  assert.equal((await read('?customerId=quiet')).value.total, 0);
  for (let i = 0; i < 661; i++) {
    const id = 'buyer-' + i;
    first('letter-' + id, { id, email: id + '@buyer.example' });
  }
  const reviewTimes = [];
  for (let i = 0; i < 7; i++) {
    const at = performance.now();
    const result = await read('?queue=review&page=27');
    reviewTimes.push(performance.now() - at);
    assert.equal(result.value.total, 663);
    assert.equal(result.value.items.length, 13);
  }
  reviewTimes.sort((a, b) => a - b);
  t.diagnostic(
    '661 封额外首封，待核实末页中位 ' +
      reviewTimes[3].toFixed(1) +
      ' ms，最慢 ' +
      reviewTimes.at(-1).toFixed(1) +
      ' ms',
  );
  times.sort((a, b) => a - b);
  t.diagnostic(
    '1,208 条追信，含 1,203 条 8 KiB 正文；末页 HTTP 中位 ' +
      times[7].toFixed(1) +
      ' ms，最慢 ' +
      times.at(-1).toFixed(1) +
      ' ms',
  );
});
