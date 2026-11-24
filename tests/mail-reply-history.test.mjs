import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncReadonlyMail } from '../scripts/sync-mail-readonly.mjs';
import { MailConversations } from '../server/mail-conversations.mjs';
import { initializeReplyHistory } from '../server/mail-reply-history.mjs';
import { handleOutreach } from '../server/outreach-api.mjs';

const at = '2026-03-01T09:00:00.000Z';
const box = { id: 'one', email: 'sales@company.example', configured: true };
const other = { id: 'two', email: 'partner@company.example', configured: true };
const user = 'buyer@customer.example';
const incoming = (id, patch = {}) => ({
  uid: id,
  from: user,
  to: box.email,
  toAddresses: [box.email],
  messageId: '<m' + id + '@customer.example>',
  subject: 'Re: Product',
  bodyText: 'product question',
  bodyFormatVersion: 2,
  occurredAt: at,
  receivedAt: at,
  direction: 'inbound',
  source: 'imap',
  deliveryStatus: 'received',
  ...patch,
});
const outgoing = (id, patch) =>
  incoming(id, {
    direction: 'outbound',
    from: box.email,
    to: user,
    toAddresses: [user],
    source: 'manual',
    deliveryStatus: 'accepted',
    occurredAt: '2026-03-02T09:00:00.000Z',
    receivedAt: '2026-03-02T09:00:00.000Z',
    ...patch,
  });
const batch = (messages, uid = 100, hasMore = false) => ({
  folders: [{ path: 'INBOX', uidValidity: '12', nextUid: uid, messages }],
  hasMore,
});
const dbPath = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdr-readonly-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'inbox.sqlite');
};
const endpoints = (
  read = () => {
    throw Error('unexpected IMAP');
  },
) => ({ list: () => [box, other], readMailbox: read, send: assert.fail, verify: assert.fail });
function historyApi(store, query = '') {
  return handleOutreach({
    request: { method: 'GET' },
    url: new URL('/api/v1/outreach/reply-history?' + query, 'http://local'),
    service: { conversations: store },
  });
}

test('历史回填失败时原子回滚，修复原件后可补全旧索引与同步触发器', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new MailConversations({ db, mailboxes: endpoints() });
  store.putMessage(box, incoming(1));
  db.exec(`DROP TRIGGER mailbox_reply_insert;
    DROP INDEX mailbox_reply_scope;
    UPDATE mailbox_reply_headers SET subject='stale';
    INSERT INTO mailbox_thread_messages VALUES('extra','account','thread','{}');
    CREATE TEMP TRIGGER fail_test_backfill BEFORE INSERT ON mailbox_reply_headers WHEN new.id='extra'
    BEGIN SELECT RAISE(ABORT,'simulated backfill failure'); END;`);
  const indexExists = () =>
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name='mailbox_reply_scope'").get();
  const subjects = () =>
    db
      .prepare('SELECT subject FROM mailbox_reply_headers ORDER BY id')
      .all()
      .map((row) => row.subject);
  assert.throws(() => initializeReplyHistory(db), /simulated backfill failure/u);
  assert.equal(db.isTransaction, false);
  assert.equal(indexExists(), undefined);
  assert.deepEqual(subjects(), ['stale']);
  db.exec('DROP TRIGGER fail_test_backfill');
  db.prepare('UPDATE mailbox_thread_messages SET data=? WHERE id=?').run(
    JSON.stringify(incoming(2)),
    'extra',
  );
  initializeReplyHistory(db);
  initializeReplyHistory(db);
  assert.ok(indexExists());
  assert.deepEqual(subjects(), ['Re: Product', 'Re: Product']);
  store.putMessage(box, incoming(3, { subject: 'After retry' }));
  assert.ok(subjects().includes('After retry'));
});

test('历史回信没有本地首封也可筛选；不以主题补造父件或 CRM，分页不返回原文', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new MailConversations({
    db,
    mailboxes: endpoints(),
    customers: () => [{ id: 'known', name: 'Dealer', email: 'known@cust.example' }],
  });
  for (let i = 1; i <= 33; i++)
    store.putMessage(box, incoming(i, { references: ['<external@unknown.example>'] }));
  store.putMessage(box, incoming(80, { from: 'known@cust.example' }));
  store.putMessage(
    box,
    incoming(81, {
      from: 'postmaster@test.example',
      subject: 'Mail delivery failed',
      inReplyTo: '<external@unknown.example>',
    }),
  );
  store.putMessage(
    box,
    incoming(82, { classification: 'auto_reply', inReplyTo: '<external@unknown.example>' }),
  );
  store.putMessage(
    box,
    incoming(83, { from: other.email, subject: 'Re: [AI-SDR internal QA token] internal' }),
  );
  store.putMessage(box, incoming(84, { from: other.email }));
  store.putMessage(box, incoming(85, { subject: 'unsubscribe' }));
  store.putMessage(box, incoming(86, { subject: 'Complaint', bodyText: 'This is spam' }));
  const first = await historyApi(store),
    second = await historyApi(store, 'page=2');
  assert.equal(first.total, 33);
  assert.equal(first.items.length, 25);
  assert.equal(second.items.length, 8);
  assert.equal(new Set(first.items.concat(second.items).map((m) => m.id)).size, 33);
  const item = first.items[0];
  assert.equal(item.hasLocalParent, false);
  assert.equal(item.companyName, null);
  assert.equal(item.handling, 'unanswered');
  assert.equal('bodyText' in item, false);
  for (const kind of [
    'inquiry',
    'bounce',
    'notification',
    'internal',
    'test',
    'unsubscribe',
    'complaint',
  ])
    assert.equal((await historyApi(store, 'kind=' + kind)).total, 1, kind);
  assert.equal((await historyApi(store, 'kind=inquiry')).items[0].customerId, 'known');
  assert.equal((await historyApi(store, 'mailboxId=two')).total, 0);
  await assert.rejects(historyApi(store, 'kind=fake'), { status: 400 });
});

test('回信历史按共享业务分类返回稳定计数、请求类型并支持筛选', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new MailConversations({ db, mailboxes: endpoints() });
  const fixtures = [
    [101, 'Please send your price list.', 'positive', 'quote'],
    [102, 'Could you share the latest catalogue?', 'positive', 'catalog'],
    [103, 'We are not interested in a new supplier.', 'refusal', null],
    [
      104,
      'Please submit supplier enquiries through our commercial contact form.',
      'referral',
      null,
    ],
    [105, 'Automatic reply: our support team received case #88412.', 'notification', null],
    [106, '', 'unverified', null],
  ];
  for (const [id, bodyText] of fixtures)
    store.putMessage(box, incoming(id, { bodyText, inReplyTo: '<seed@company.example>' }));
  const all = await historyApi(store, 'kind=all');
  assert.deepEqual(all.businessCounts, {
    positive: 2,
    refusal: 1,
    referral: 1,
    notification: 1,
    bounce: 0,
    unverified: 1,
    other: 0,
  });
  for (const [id, , businessKind, requestType] of fixtures) {
    const item = all.items.find(
      (row) =>
        row.id.includes('email_') &&
        row.subject === 'Re: Product' &&
        row.businessKind === businessKind &&
        row.requestType === requestType,
    );
    assert.ok(item, String(id));
  }
  const positive = await historyApi(store, 'kind=all&businessKind=positive');
  assert.equal(positive.total, 2);
  assert.deepEqual(
    new Set(positive.items.map((item) => item.requestType)),
    new Set(['quote', 'catalog']),
  );
  await assert.rejects(historyApi(store, 'businessKind=unknown'), { status: 400 });
});

test('有回复仅列含外部客户回信证据的会话，分页总数及所有筛选与跟进历史一致', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new MailConversations({
    db,
    mailboxes: endpoints(),
    customers: () => [{ id: 'buyer', name: 'A buyer', email: user }],
  });
  const list = (query) =>
    handleOutreach({
      request: { method: 'GET' },
      url: new URL('/api/v1/outreach/conversations?' + query, 'http://local'),
      service: { conversations: store },
    });
  const put = (n, patch = {}, mailbox = box) =>
    store.putMessage(
      mailbox,
      incoming(n, {
        inReplyTo: '<absent-' + n + '@company.example>',
        ...patch,
      }),
    );
  for (let n = 1; n <= 13; n++) put(n);
  put(14, {
    inReplyTo: undefined,
    references: ['<headers-only@company.example>'],
    unread: true,
    subject: 'Special request',
  });
  put(15, { inReplyTo: '<m14@customer.example>', bodyText: 'Another question about samples' });
  put(16, { inReplyTo: '<m14@customer.example>', classification: 'auto_reply' });
  put(17, { to: other.email, toAddresses: [other.email] }, other);
  put(18, { inReplyTo: undefined, subject: 'Re: Subject alone is not evidence' });
  for (const [i, classification] of [
    'auto_reply',
    'unverified',
    'hard_bounce',
    'unsubscribe',
    'complaint',
  ].entries())
    put(20 + i, { classification });
  put(30, { from: other.email });
  put(31, { from: other.email, subject: 'Re: [AI-SDR internal QA test]' });
  put(32, { source: 'manual' });
  store.putMessage(box, outgoing(33, {}));
  const sameInbox = await list('hasReply=1&mailboxId=one&pageSize=10');
  const last = await list('hasReply=1&mailboxId=one&pageSize=10&page=2');
  const replyRows = await historyApi(store, 'kind=reply&mailboxId=one');
  assert.equal(replyRows.total, 15);
  assert.equal(sameInbox.total, 14);
  assert.equal(sameInbox.items.length, 10);
  assert.equal(sameInbox.hasMore, true);
  assert.equal(last.total, 14);
  assert.equal(last.items.length, 4);
  assert.equal(last.hasMore, false);
  const ids = [...sameInbox.items, ...last.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 14);
  assert.deepEqual(new Set(ids), new Set(replyRows.items.map((item) => item.threadId)));
  assert.equal((await list('hasReply=1')).total, 15);
  assert.equal((await list('hasReply=1&mailboxId=two')).total, 1);
  assert.ok((await list('inboundOnly=1&mailboxId=one')).total > 14);
  const filtered = 'hasReply=1&inboundOnly=1&unread=1&mailboxId=one&q=samples&customerId=buyer';
  const selected = await list(filtered + '&folder=open');
  assert.equal(selected.total, 1);
  const id = selected.items[0].id;
  assert.ok(replyRows.items.some((m) => m.threadId === id && !m.hasLocalParent));
  db.prepare("INSERT INTO mail_thread_workflow VALUES(?,'done',NULL,?)").run(id, at);
  assert.equal((await list(filtered + '&folder=open')).total, 0);
  assert.equal((await list(filtered + '&folder=done')).items[0].id, id);
  assert.equal((await list('hasReply=1&customerId=unknown')).total, 0);
  put(1, { classification: 'auto_reply' });
  assert.equal((await list('hasReply=1&mailboxId=one')).total, 13);
  assert.equal((await historyApi(store, 'kind=reply&mailboxId=one')).total, 14);
});

test('后续回信须同一个发件邮箱、收件对方及最近父件，并区分人工、自动和未知发件方式', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new MailConversations({ db, mailboxes: endpoints() });
  const parent = '<first@company.example>';
  const msg = incoming(1, { inReplyTo: parent });
  store.putMessage(box, msg);
  store.putMessage(
    box,
    outgoing(2, {
      messageId: parent,
      receivedAt: '2026-02-20T01:00:00Z',
      occurredAt: '2026-02-20T01:00:00Z',
    }),
  );
  store.putMessage(
    box,
    outgoing(3, { references: [msg.messageId, '<different@customer.example>'] }),
  );
  store.putMessage(
    box,
    outgoing(4, {
      inReplyTo: msg.messageId,
      to: 'somebody@customer.example',
      toAddresses: ['somebody@customer.example'],
    }),
  );
  store.putMessage(other, outgoing(5, { inReplyTo: msg.messageId, from: other.email }));
  let row = (await historyApi(store)).items[0];
  assert.equal(row.hasLocalParent, true);
  assert.equal(row.handling, 'unanswered');
  assert.equal((await historyApi(store, 'handling=unanswered')).total, 1);
  assert.equal((await historyApi(store, 'handling=answered')).total, 0);
  store.putMessage(box, outgoing(6, { inReplyTo: msg.messageId }));
  row = (await historyApi(store)).items[0];
  assert.equal(row.handling, 'manual');
  assert.equal((await historyApi(store, 'handling=answered')).total, 1);
  assert.equal((await historyApi(store, 'handling=unanswered')).total, 0);
  store.putMessage(
    box,
    outgoing(6, { inReplyTo: msg.messageId, source: 'imap', deliveryStatus: 'sent' }),
  );
  assert.equal((await historyApi(store)).items[0].handling, 'manual');
  for (const [i, source, expected] of [
    [7, 'imap', 'sent'],
    [9, 'automatic', 'automatic'],
  ]) {
    const m = incoming(i, { references: [parent] });
    store.putMessage(box, m);
    store.putMessage(box, outgoing(i + 1, { source, inReplyTo: m.messageId }));
    assert.equal(
      (await historyApi(store)).items.find(
        (r) => r.id === store.messages(row.threadId).find((x) => x.messageId === m.messageId).id,
      ).handling,
      expected,
    );
  }
});

test('只读 CLI 在隔离数据库恢复游标、回扫补头及原线程，不创建收发或 CRM 工作项', async (t) => {
  const path = dbPath(t),
    opts = { path, mailbox: 'one', maxPages: 1 };
  const first = incoming(1),
    parent = outgoing(3, {
      messageId: '<prior@company.example>',
      occurredAt: '2026-02-20T00:00:00Z',
      receivedAt: '2026-02-20T00:00:00Z',
    });
  const call = (read, flags = {}) =>
    syncReadonlyMail({ ...opts, mailboxes: endpoints(read), ...flags });
  let r = await call(
    (id, { cursors }) => {
      assert.equal(id, 'one');
      assert.deepEqual(cursors, {});
      return batch([first, parent], 4, true);
    },
    { since: '2026-02-01' },
  );
  assert.equal(r[0].imported, 2);
  assert.equal(r[0].hasMore, true);
  await call((id, { cursors }) => {
    assert.equal(cursors.INBOX.nextUid, 4);
    return batch([], 4);
  });
  r = await call(
    (id, { cursors, since }) => {
      assert.deepEqual(cursors, {});
      assert.equal(since, '2026-02-01T00:00:00.000Z');
      return batch([{ ...first, inReplyTo: parent.messageId }], 4);
    },
    { since: '2026-02-01', rescan: true },
  );
  assert.equal(r[0].imported, 0);
  r = await call((id, { cursors }) => {
    assert.equal(cursors.INBOX.nextUid, 4);
    return batch([first], 4);
  });
  assert.equal(r[0].imported, 0);
  const db = new DatabaseSync(path);
  try {
    const store = new MailConversations({ db, mailboxes: endpoints() });
    const item = (await historyApi(store)).items[0];
    assert.equal(item.hasLocalParent, true);
    assert.equal(store.detail(item.threadId).messages.length, 2);
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('outreach_campaigns','outreach_deliveries','mail_reception','outreach_followups','mail_reply_operations')",
        )
        .get().n,
      0,
    );
    assert.equal(db.prepare('SELECT count(*) n FROM mailbox_thread_messages').get().n, 2);
  } finally {
    db.close();
  }
});

test('两个本地读取器并发，迟到的旧页不会回退游标或入库一条已过时消息', async (t) => {
  const path = dbPath(t);
  let release, started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const slow = syncReadonlyMail({
    path,
    mailboxes: endpoints(async () => {
      started();
      await new Promise((r) => {
        release = r;
      });
      return batch([incoming(1)], 2);
    }),
    mailbox: 'one',
  });
  await ready;
  const fast = await syncReadonlyMail({
    path,
    mailboxes: endpoints(() => batch([incoming(3)], 4)),
    mailbox: 'one',
  });
  release();
  const stale = await slow;
  assert.equal(fast[0].imported, 1);
  assert.equal(stale[0].imported, 0);
  await syncReadonlyMail({
    path,
    mailboxes: endpoints((id, options) => {
      assert.equal(options.cursors.INBOX.nextUid, 4);
      return batch([], 4);
    }),
    mailbox: 'one',
  });
});

test('1,203 封含正文邮件的回信首屏、筛选、深页均使用小表；读取不访问 IMAP', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const store = new MailConversations({ db, mailboxes: endpoints() });
  const add = db.prepare('INSERT INTO mailbox_thread_messages VALUES(?,?,?,?)');
  store.putMessage(box, incoming(1, { references: ['<seed@brand.example>'] }));
  const key = db.prepare('SELECT account_key FROM mailbox_thread_messages').get().account_key;
  const body = 'a'.repeat(16384);
  db.exec('BEGIN');
  for (let i = 2; i <= 1203; i++) {
    const m = incoming(i, {
      source: 'imap',
      bodyText: body,
      classification: i % 9 === 0 ? 'auto_reply' : 'normal',
      inReplyTo: '<seed' + i + '@example.test>',
    });
    add.run('msg' + i, key, 'thread' + i, JSON.stringify(m));
  }
  db.exec('COMMIT');
  for (const query of ['kind=all', 'kind=notification&mailboxId=one', 'kind=reply&page=30']) {
    const intervals = [];
    let responseSize = 0;
    for (let i = 0; i < 6; i++) {
      const start = performance.now(),
        r = await historyApi(store, query);
      intervals.push(performance.now() - start);
      const body = JSON.stringify(r);
      responseSize = Buffer.byteLength(body);
      assert.equal(r.items.length, 25);
      assert.ok(!body.includes('aaaaaa'));
    }
    const cold = intervals[0];
    intervals.sort((a, b) => a - b);
    t.diagnostic(
      query +
        ' cold=' +
        cold.toFixed(2) +
        'ms median=' +
        intervals[3].toFixed(2) +
        'ms max=' +
        intervals.at(-1).toFixed(2) +
        'ms bytes=' +
        responseSize,
    );
  }
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM mailbox_reply_headers WHERE account_key=? AND source='imap' AND direction='inbound' ORDER BY stamp DESC,id DESC LIMIT 25",
    )
    .all(key);
  assert.match(plan.map((r) => r.detail).join(' '), /mailbox_reply_scope/);
});
