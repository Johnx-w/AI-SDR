import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { OutreachService } from '../server/outreach-service.mjs';
import { readCustomerTimeline, timelineOriginal } from '../server/customer-timeline.mjs';
import { createApp } from '../server/app.mjs';

test('each customer timeline returns exactly the replies from its own customer', async (t) => {
  const box = { id: 'sales', email: 'sales@brand.example' };
  const customers = [
    { id: 'north', email: 'north@client.example' },
    { id: 'south', email: 'south@client.example' },
    { id: 'quiet', email: 'quiet@client.example' },
  ];
  const svc = new OutreachService({
    mailboxes: { list: () => [box] },
    customers: () => customers,
  });
  const app = createApp({ env: {}, outreachServiceFactory: () => svc });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));

  for (const from of ['north@client.example', 'south@client.example']) {
    svc.conversations.putMessage(box, {
      direction: 'inbound',
      source: 'imap',
      from,
      to: box.email,
      subject: 'Re: Samples',
      bodyText: 'Thanks for sending the samples.',
      messageId: '<samples-' + from + '>',
      occurredAt: '2026-11-24T10:00:00Z',
      deliveryStatus: 'received',
    });
  }

  svc.conversations.putMessage(box, {
    direction: 'outbound',
    source: 'imap',
    from: box.email,
    to: 'north@client.example',
    subject: 'Supplier enquiry',
    bodyText: 'Are you accepting new suppliers?',
    messageId: '<enquiry@brand.example>',
    occurredAt: '2026-11-24T10:20:00Z',
    deliveryStatus: 'sent',
  });
  svc.conversations.putMessage(box, {
    direction: 'inbound',
    source: 'imap',
    from: 'north@client.example',
    to: box.email,
    subject: 'Request received',
    bodyText: 'Automatic reply: we received your message.',
    messageId: '<receipt@client.example>',
    inReplyTo: '<enquiry@brand.example>',
    occurredAt: '2026-11-24T11:00:00Z',
    deliveryStatus: 'received',
  });

  for (const [customerId, expectedReplies] of [
    [
      'north',
      [
        ['north@client.example', 'notification'],
        ['north@client.example', 'received'],
      ],
    ],
    ['south', [['south@client.example', 'received']]],
    ['quiet', []],
  ]) {
    const url = new URL(
      '/api/v1/business/timeline/' + customerId,
      'http://127.0.0.1:' + app.address().port,
    );
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const { items } = await response.json();
    const replies = items.filter((event) => event.kind === 'received');
    assert.deepEqual(
      replies.map((event) => [event.note, event.state]),
      expectedReplies,
      customerId,
    );
    for (const reply of replies) {
      const original = svc.conversations
        .detail(reply.thread)
        .messages.find((m) => m.id === reply.id);
      assert.equal(original?.subject, reply.title);
    }
    if (customerId === 'north') {
      const sent = items.find((event) => event.kind === 'mail');
      assert.equal(replies[0].thread, sent?.thread);
    }
  }
});

test('customer timeline reads actual sent messages, pending and historical work with scoped paging and originals', async (t) => {
  const store = new CustomerBusiness({ scope: 'test' });
  const box = { id: 'one', email: 'sales@brand.example' };
  const svc = new OutreachService({
    mailboxes: { list: () => [box] },
    customers: () => [{ id: 'buyer', email: 'buyer@client.example' }],
  });
  const app = createApp({ env: {}, outreachServiceFactory: () => svc });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    store.close();
    await new Promise((resolve) => app.close(resolve));
  });
  svc.putCampaign({ id: 'plan', mode: 'production', scope: 'local' });
  const first = {
    id: 'first',
    campaignId: 'plan',
    customerId: 'buyer',
    mode: 'production',
    mailboxId: 'one',
    from: box.email,
    to: 'buyer@client.example',
    sentAt: '2026-11-20T10:00:00Z',
    subject: 'Samples',
    bodyText: 'Sample specifications',
    messageId: '<first@brand.example>',
    status: 'accepted',
  };
  svc.putDelivery(first);
  const read = (id = 'buyer', page = 1) => readCustomerTimeline(store, svc, id, page);
  assert.equal(read().items[0].source, 'delivery');
  assert.equal(read().items[0].state, 'sent');
  assert.equal(timelineOriginal(store, svc, 'buyer', 'delivery', 'first').bodyText, first.bodyText);
  assert.throws(() => timelineOriginal(store, svc, 'other', 'delivery', 'first'), { status: 404 });
  svc.conversations.importDeliveries();
  store.put('messages', {
    id: 'mirror',
    customerId: 'buyer',
    direction: 'outbound',
    channel: 'email',
    deliveryStatus: 'accepted',
    occurredAt: first.sentAt,
    account: box.email,
    externalId: first.messageId,
    subject: 'Samples',
  });
  svc.followUps.put({
    id: 'next',
    customerId: 'buyer',
    campaignId: 'plan',
    firstId: 'first',
    step: 2,
    status: 'unknown',
    dueAt: '2026-11-24T08:00:00Z',
    reason: '等待核实',
  });
  store.put('tasks', {
    id: 'task_next',
    customerId: 'buyer',
    origin: 'automatic-followup',
    status: 'pending',
    title: 'mirror',
  });
  store.put('tasks', {
    id: 'old',
    customerId: 'buyer',
    origin: 'manual',
    status: 'completed',
    title: '核对报价',
    dueAt: '2026-11-23T08:00:00Z',
  });
  svc.conversations.putMessage(box, {
    direction: 'inbound',
    source: 'imap',
    from: first.to,
    to: first.from,
    subject: 'Price request',
    bodyText: 'Please send a quote.',
    messageId: '<request@client.example>',
    occurredAt: '2026-11-24T10:00:00Z',
    deliveryStatus: 'received',
  });
  const data = read();
  assert.equal(data.sentCount, 1);
  assert.deepEqual(
    data.items.map((r) => r.kind),
    ['received', 'reply', 'auto', 'manual', 'mail'],
  );
  assert.ok(data.items.at(-1).thread);
  assert.equal(data.items[2].state, 'unknown');
  assert.equal(data.items[1].state, 'quote');
  const http = await fetch(
    'http://127.0.0.1:' + app.address().port + '/api/v1/business/timeline/buyer',
  );
  assert.equal(http.status, 200);
  assert.ok((await http.json()).items.some((r) => r.kind === 'reply'));
  svc.conversations.putMessage(box, {
    direction: 'outbound',
    source: 'imap',
    from: box.email,
    to: first.to,
    subject: 'Quotation',
    bodyText: 'Here it is',
    messageId: '<answer@brand.example>',
    inReplyTo: '<request@client.example>',
    occurredAt: '2026-11-24T11:00:00Z',
    deliveryStatus: 'sent',
  });
  assert.ok(!read().items.some((r) => r.kind === 'reply'));
  const history = read().items.filter((r) => r.kind === 'received');
  assert.equal(history.length, 1);
  assert.equal(history[0].title, 'Price request');
  assert.ok(
    svc.conversations
      .detail(history[0].thread)
      .messages.some((m) => m.id === history[0].id && m.bodyText === 'Please send a quote.'),
  );
  for (let i = 0; i < 30; i++)
    svc.putDelivery({
      ...first,
      id: 'skip' + i,
      customerId: 'skipped',
      status: 'skipped',
      reason: '无有效的商务邮箱',
      skippedAt: first.sentAt,
    });
  const skip = read('skipped');
  assert.equal(skip.sentCount, 0);
  assert.equal(skip.firstCount, 30);
  assert.equal(skip.items[0].note, '无有效的商务邮箱');
  const second = read('skipped', 2);
  assert.equal(new Set([...skip.items, ...second.items].map((r) => r.id)).size, 30);
  assert.equal(read('unrelated').total, 0);
});
