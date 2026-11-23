import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { OutreachService } from '../server/outreach-service.mjs';
import { MailConversations } from '../server/mail-conversations.mjs';

test('本地收件箱分组、稍后回到进行中、线程合并与工作备注独立于邮件和发送', async (t) => {
  let now = Date.parse('2026-01-02T00:00:00Z');
  const mailbox = {
    id: 'work',
    email: 'sales@brand.example',
    configured: true,
    smtpStatus: 'connected',
  };
  const service = new OutreachService({
    now: () => now,
    mailboxes: { list: () => [mailbox], send: () => assert.fail('不应发送') },
  });
  const app = createApp({
    env: {},
    localMailInspection: {},
    outreachServiceFactory: () => service,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = 'http://127.0.0.1:' + app.address().port + '/api/v1/outreach';
  const request = (path, method = 'GET', data) =>
    fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  const read = async (path, method, data) => {
    const r = await request(path, method, data);
    assert.equal(r.status, 200);
    return r.json();
  };
  function incoming(id, extra = {}) {
    service.conversations.putMessage(mailbox, {
      messageId: '<' + id + '@buyer.example>',
      direction: 'inbound',
      source: 'imap',
      deliveryStatus: 'received',
      from: 'buyer@buyer.example',
      to: mailbox.email,
      subject: id,
      bodyText: 'Quote for samples',
      occurredAt: new Date(now).toISOString(),
      ...extra,
    });
  }
  incoming('question', { fromName: 'Jamie Lawson' });
  incoming('second');
  const thread = service.conversations.list({ q: 'question' }).items[0].id;
  const path = '/conversations/' + thread;
  assert.equal((await read('/conversations?q=lawson')).items[0].participantName, 'Jamie Lawson');
  service.db
    .prepare("UPDATE mailbox_threads SET data=json_remove(data,'$.participantName') WHERE id=?")
    .run(thread);
  service.db.exec('DELETE FROM mailbox_summary_migrations WHERE version=1');
  new MailConversations({ db: service.db, mailboxes: service.mailboxes });
  assert.equal((await read('/conversations?q=lawson')).items[0].id, thread);
  const count = async (folder) => (await read('/conversations?folder=' + folder)).total;
  assert.equal(await count('open'), 2);
  const note = { body: '业务员内部单独核实样品', clientId: 'client-note-123' };
  assert.equal((await read(path + '/notes', 'POST', note)).notes.length, 1);
  assert.equal((await read(path + '/notes', 'POST', note)).notes.length, 1);
  assert.equal((await request(path + '/notes', 'POST', { ...note, body: '其他备注' })).status, 409);
  const message = await read(path);
  assert.equal(message.workflow.notes[0].body, note.body);
  assert.equal(message.replyContext.canSend, false);
  assert.ok(!JSON.stringify(message.messages).includes(note.body));
  assert.equal((await read('/conversations?q=' + encodeURIComponent(note.body))).total, 0);
  const draft = (
    await read(path + '/draft', 'PUT', {
      replyToMessageId: message.messages[0].id,
      bodyHtml: '<p>本机草稿</p>',
      attachments: [],
      revision: 0,
    })
  ).draft;
  assert.equal(draft.bodyText, '本机草稿');
  assert.equal((await request(path + '/reply', 'POST', {})).status, 403);
  assert.equal(
    (await request('/campaigns/test/follow-ups', 'POST', { action: 'enable' })).status,
    403,
  );
  await read(path + '/draft', 'DELETE', { revision: draft.revision });
  await read(path + '/workflow', 'PATCH', {
    state: 'later',
    snoozeUntil: new Date(now + 60000).toISOString(),
  });
  assert.equal(await count('later'), 1);
  assert.equal(await count('open'), 1);
  now += 60000;
  assert.equal(await count('later'), 0);
  assert.equal((await read(path)).workflow.state, 'open');
  await read(path + '/workflow', 'PATCH', { state: 'done' });
  assert.equal(await count('done'), 1);
  incoming('automatic', { inReplyTo: '<question@buyer.example>', classification: 'auto_reply' });
  assert.equal(await count('done'), 1);
  now += 1000;
  incoming('reply', { inReplyTo: '<question@buyer.example>' });
  assert.equal(await count('done'), 0);
  const other = service.conversations.list({ q: 'second' }).items[0].id;
  await read('/conversations/' + other + '/notes', 'POST', {
    clientId: 'client-note-456',
    body: '合并前的备注',
  });
  incoming('join', { references: ['<question@buyer.example>', '<second@buyer.example>'] });
  assert.equal(await count('open'), 1);
  assert.equal((await read(path)).workflow.notes.length, 2);
  assert.equal((await request('/conversations?folder=invalid')).status, 400);
  assert.equal(
    (await request(path + '/workflow', 'PATCH', { state: 'later', snoozeUntil: 'bad' })).status,
    400,
  );
  assert.equal((await request('/conversations/missing/notes', 'POST', note)).status, 404);
});
