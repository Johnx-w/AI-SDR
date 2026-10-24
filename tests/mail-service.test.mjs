import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  MailService,
  MailServiceError,
  PILOT_MAILBOX,
  PILOT_TEST_RECIPIENT,
} from '../server/mail-service.mjs';

const TEST_ID = '<technical-test@shutterblindssolutions.com>';
const REPLY_ID = '<reply@honeybadgerblinds.com>';
const SENT_REPLY_ID = '<sent-reply@shutterblindssolutions.com>';
const MARKER = '[ShadeFlow-Test:12345678-1234-4123-8123-123456789abc]';

function fakeTransport() {
  const calls = {
    options: [],
    verifySmtp: 0,
    verifyImap: 0,
    capture: 0,
    technical: 0,
    replies: [],
    sync: [],
  };
  const batches = [];
  let sendTechnicalError = null;
  let smtpVerifyError = null;
  let imapVerifyError = null;
  let captureError = null;
  let replyHandler = null;
  const transport = {
    async verifySmtp() {
      calls.verifySmtp += 1;
      if (smtpVerifyError) throw smtpVerifyError;
      return { connected: true };
    },
    async verifyImap() {
      calls.verifyImap += 1;
      if (imapVerifyError) throw imapVerifyError;
      return { connected: true };
    },
    async captureInboxCursor() {
      calls.capture += 1;
      if (captureError) throw captureError;
      return { uidValidity: '5', nextUid: 100 };
    },
    async sendTechnicalTest({ to }) {
      calls.technical += 1;
      assert.equal(to, PILOT_TEST_RECIPIENT);
      if (sendTechnicalError) throw sendTechnicalError;
      return { accepted: true, to, messageId: TEST_ID, marker: MARKER };
    },
    async sendTestReply(input) {
      calls.replies.push(input);
      if (replyHandler) await replyHandler(input);
      return { accepted: true, to: input.to, messageId: SENT_REPLY_ID };
    },
    async syncTestInbox(input) {
      calls.sync.push(input);
      return batches.shift() ?? { cursor: input.cursor, messages: [], skipped: [], hasMore: false };
    },
  };
  return {
    calls,
    batches,
    factory(options) {
      calls.options.push(options);
      return transport;
    },
    failTechnical(error) {
      sendTechnicalError = error;
    },
    failSmtpVerify(error) {
      smtpVerifyError = error;
    },
    failImapVerify(error) {
      imapVerifyError = error;
    },
    failCapture(error) {
      captureError = error;
    },
    onReply(handler) {
      replyHandler = handler;
    },
  };
}

function newService(fake = fakeTransport(), overrides = {}) {
  const service = new MailService({
    env: {
      MAIL_DB_PATH: ':memory:',
      MAIL_ACCOUNT: PILOT_MAILBOX,
      MAIL_TEST_RECIPIENT: PILOT_TEST_RECIPIENT,
      MAIL_CLIENT_PASSWORD: 'fixture-only',
    },
    transportFactory: fake.factory,
    now: () => new Date('2026-10-23T00:00:00Z'),
    pollIntervalMs: 0,
    ...overrides,
  });
  return { service, fake };
}

function inbound(uid = 100, classification = { kind: 'reply' }) {
  return {
    uid,
    messageId: REPLY_ID,
    inReplyTo: TEST_ID,
    references: [TEST_ID],
    from: PILOT_TEST_RECIPIENT,
    to: PILOT_MAILBOX,
    subject: `Re: ${MARKER} 邮箱连接测试`,
    text: classification.kind === 'unsubscribe' ? '退订' : '收到测试信。',
    receivedAt: '2026-10-23T01:00:00.000Z',
    classification,
  };
}

test('without client password the status is readable but sending is disabled', async (t) => {
  const service = new MailService({
    env: { MAIL_DB_PATH: ':memory:' },
    transportFactory: () => {
      throw new Error('must not build transport');
    },
    pollIntervalMs: 0,
  });
  t.after(() => service.close());
  assert.equal(service.status().mode, 'test_only');
  assert.equal(service.status().mailbox.configured, false);
  assert.equal(service.status().mailbox.imapStatus, 'not_configured');
  assert.deepEqual(service.listConversations(), { items: [] });
  assert.equal((await service.start()).mailbox.configured, false);
  await assert.rejects(
    service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'test-key-001' }),
    (error) =>
      error instanceof MailServiceError &&
      error.code === 'MAIL_NOT_CONFIGURED' &&
      error.status === 503,
  );
});

test('env cannot override the fixed pilot account or test recipient', () => {
  for (const env of [
    { MAIL_ACCOUNT: 'other@example.org' },
    { MAIL_TEST_RECIPIENT: 'outside@example.org' },
  ]) {
    assert.throws(
      () => new MailService({ env: { MAIL_DB_PATH: ':memory:', ...env } }),
      (error) => error.code === 'MAIL_UNEXPECTED_IDENTITY' && error.status === 400,
    );
  }
});

test('start persists first IMAP baseline before any send and does not reset it', async (t) => {
  const { service, fake } = newService();
  t.after(() => service.close());
  await assert.rejects(
    service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'test-key-001' }),
    (error) => error.code === 'MAIL_NOT_INITIALIZED',
  );
  const status = await service.start();
  assert.equal(status.mailbox.imapStatus, 'connected');
  assert.equal(status.mailbox.smtpStatus, 'connected');
  assert.equal(fake.calls.capture, 1);
  assert.equal(service.requireCursor().nextUid, 100);
  await service.start();
  assert.equal(fake.calls.capture, 1);
  assert.equal(fake.calls.verifyImap, 1);
  assert.deepEqual(fake.calls.options[0], {
    account: PILOT_MAILBOX,
    clientPassword: 'fixture-only',
    allowedTestRecipients: [PILOT_TEST_RECIPIENT],
  });
});

test('technical test is exactly one confirmed, idempotent send to the test address', async (t) => {
  const { service, fake } = newService();
  t.after(() => service.close());
  await service.start();
  await assert.rejects(
    service.sendTechnicalTest({ idempotencyKey: 'test-key-001' }),
    (error) => error.code === 'MAIL_CONFIRMATION_REQUIRED' && error.status === 400,
  );
  const first = await service.sendTechnicalTest({
    confirmed: true,
    idempotencyKey: 'test-key-001',
  });
  assert.equal(first.accepted, true);
  assert.equal(first.to, PILOT_TEST_RECIPIENT);
  assert.equal(fake.calls.technical, 1);
  const repeated = await service.sendTechnicalTest({
    confirmed: true,
    idempotencyKey: 'test-key-001',
  });
  assert.deepEqual(repeated, first);
  assert.equal(fake.calls.technical, 1);
  await assert.rejects(
    service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'other-key-001' }),
    (error) => error.code === 'MAIL_TEST_ALREADY_ATTEMPTED',
  );
  const listed = service.listConversations();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].participant, PILOT_TEST_RECIPIENT);
  const detail = service.getConversation(first.conversationId);
  assert.equal(detail.messages.length, 1);
  assert.equal(detail.messages[0].direction, 'outbound');
  assert.equal(detail.messages[0].deliveryStatus, 'accepted');
  assert.equal(detail.draft, null);
});

test('new test reply imports once, produces review draft, and sends one threaded response', async (t) => {
  const { service, fake } = newService();
  t.after(() => service.close());
  await service.start();
  const { conversationId } = await service.sendTechnicalTest({
    confirmed: true,
    idempotencyKey: 'test-key-001',
  });
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 101 },
    messages: [inbound()],
    skipped: [],
    hasMore: false,
  });
  const syncResult = await service.sync();
  assert.equal(syncResult.imported, 1);
  assert.equal(service.requireCursor().nextUid, 101);
  assert.deepEqual(fake.calls.sync[0].knownMessageIds, [TEST_ID]);
  assert.deepEqual(fake.calls.sync[0].knownTestMarkers, [MARKER]);
  let detail = service.getConversation(conversationId);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[1].direction, 'inbound');
  assert.equal(detail.conversation.unread, true);
  const draft = service.saveDraft(conversationId, {
    bodyText: '人工确认收到，测试回信。',
    expectedRevision: 0,
  });
  assert.equal(draft.revision, 1);
  assert.equal(service.status().agent.pendingReviews, 1);
  assert.throws(
    () => service.saveDraft(conversationId, { bodyText: '冲突编辑', expectedRevision: 0 }),
    (error) => error.code === 'MAIL_DRAFT_CONFLICT',
  );
  await assert.rejects(
    service.sendReply(conversationId, { draftRevision: 1, idempotencyKey: 'reply-key-001' }),
    (error) => error.code === 'MAIL_CONFIRMATION_REQUIRED',
  );
  const sent = await service.sendReply(conversationId, {
    draftRevision: 1,
    confirmed: true,
    idempotencyKey: 'reply-key-001',
  });
  assert.equal(sent.messageId, SENT_REPLY_ID);
  assert.equal(fake.calls.replies.length, 1);
  assert.equal(fake.calls.replies[0].to, PILOT_TEST_RECIPIENT);
  assert.equal(fake.calls.replies[0].inReplyTo, REPLY_ID);
  assert.deepEqual(fake.calls.replies[0].references, [TEST_ID, REPLY_ID]);
  assert.match(fake.calls.replies[0].subject, /^Re:/);
  assert.deepEqual(
    await service.sendReply(conversationId, {
      draftRevision: 1,
      confirmed: true,
      idempotencyKey: 'reply-key-001',
    }),
    sent,
  );
  assert.equal(fake.calls.replies.length, 1);
  detail = service.getConversation(conversationId);
  assert.equal(detail.messages.length, 3);
  assert.equal(detail.draft.status, 'sent');
  assert.equal(service.status().agent.pendingReviews, 0);
});

test('a draft cannot be saved before an inbound test message exists', async (t) => {
  const { service } = newService();
  t.after(() => service.close());
  await service.start();
  const { conversationId } = await service.sendTechnicalTest({
    confirmed: true,
    idempotencyKey: 'test-key-001',
  });
  assert.throws(
    () => service.saveDraft(conversationId, { bodyText: '提前回信', expectedRevision: 0 }),
    (error) => error.code === 'MAIL_THREAD_NOT_READY',
  );
  assert.equal(service.getConversation(conversationId).draft, null);
});

test('new inbound Message-ID stales the old draft and a revised draft replies to the new message', async (t) => {
  const { service, fake } = newService();
  t.after(() => service.close());
  await service.start();
  const { conversationId } = await service.sendTechnicalTest({
    confirmed: true,
    idempotencyKey: 'test-key-001',
  });
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 101 },
    messages: [inbound()],
    skipped: [],
  });
  await service.sync();
  const firstDraft = service.saveDraft(conversationId, {
    bodyText: '第一封来信的草稿',
    expectedRevision: 0,
  });
  assert.equal(firstDraft.replyToMessageId, REPLY_ID);
  const secondId = '<second-reply@honeybadgerblinds.com>';
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 102 },
    messages: [
      {
        ...inbound(101),
        messageId: secondId,
        inReplyTo: REPLY_ID,
        references: [TEST_ID, REPLY_ID],
        text: '追加需求',
      },
    ],
    skipped: [],
  });
  await service.sync();
  assert.equal(service.getConversation(conversationId).draft.status, 'stale');
  assert.equal(service.status().agent.pendingReviews, 0);
  await assert.rejects(
    service.sendReply(conversationId, {
      draftRevision: 1,
      confirmed: true,
      idempotencyKey: 'reply-key-001',
    }),
    (error) => error.code === 'MAIL_DRAFT_STALE',
  );
  assert.equal(fake.calls.replies.length, 0);
  const secondDraft = service.saveDraft(conversationId, {
    bodyText: '按追加需求重新审核的回信',
    expectedRevision: 1,
  });
  assert.equal(secondDraft.revision, 2);
  assert.equal(secondDraft.replyToMessageId, secondId);
  await service.sendReply(conversationId, {
    draftRevision: 2,
    confirmed: true,
    idempotencyKey: 'reply-key-002',
  });
  assert.equal(fake.calls.replies.length, 1);
  assert.equal(fake.calls.replies[0].inReplyTo, secondId);
  assert.deepEqual(fake.calls.replies[0].references, [TEST_ID, REPLY_ID, secondId]);
});

test('reply preflight sync observes unsubscribe and consumes no SMTP send attempt', async (t) => {
  const { service, fake } = newService();
  t.after(() => service.close());
  await service.start();
  const { conversationId } = await service.sendTechnicalTest({
    confirmed: true,
    idempotencyKey: 'test-key-001',
  });
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 101 },
    messages: [inbound()],
    skipped: [],
  });
  await service.sync();
  service.saveDraft(conversationId, { bodyText: '准备回信', expectedRevision: 0 });
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 102 },
    messages: [
      {
        ...inbound(101, { kind: 'unsubscribe' }),
        messageId: '<unsubscribe@honeybadgerblinds.com>',
        inReplyTo: REPLY_ID,
      },
    ],
    skipped: [],
  });
  await assert.rejects(
    service.sendReply(conversationId, {
      draftRevision: 1,
      confirmed: true,
      idempotencyKey: 'reply-key-001',
    }),
    (error) => error.code === 'MAIL_CONVERSATION_PAUSED',
  );
  assert.equal(fake.calls.replies.length, 0);
  assert.equal(service.getConversation(conversationId).conversation.status, 'unsubscribed');
  assert.equal(service.getConversation(conversationId).draft.status, 'blocked');
  assert.equal(service.requireCursor().nextUid, 102);
});

test('sync waits for SMTP, then unsubscribe arriving during send remains sticky', async (t) => {
  const { service, fake } = newService();
  t.after(() => service.close());
  await service.start();
  const { conversationId } = await service.sendTechnicalTest({
    confirmed: true,
    idempotencyKey: 'test-key-001',
  });
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 101 },
    messages: [inbound()],
    skipped: [],
  });
  await service.sync();
  service.saveDraft(conversationId, { bodyText: '人工审核回信', expectedRevision: 0 });
  let releaseSend;
  let signalEntered;
  const sendHeld = new Promise((resolve) => {
    releaseSend = resolve;
  });
  const entered = new Promise((resolve) => {
    signalEntered = resolve;
  });
  fake.onReply(async () => {
    signalEntered();
    await sendHeld;
  });
  const sending = service.sendReply(conversationId, {
    draftRevision: 1,
    confirmed: true,
    idempotencyKey: 'reply-key-001',
  });
  await entered;
  assert.equal(fake.calls.sync.length, 2); // initial sync + send preflight
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 102 },
    messages: [
      {
        ...inbound(101, { kind: 'unsubscribe' }),
        messageId: '<late-unsubscribe@honeybadgerblinds.com>',
        inReplyTo: REPLY_ID,
      },
    ],
    skipped: [],
  });
  const queuedSync = service.sync();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fake.calls.sync.length, 2); // cannot run while SMTP is in flight
  releaseSend();
  const [sent] = await Promise.all([sending, queuedSync]);
  assert.equal(sent.accepted, true);
  assert.equal(service.getConversation(conversationId).conversation.status, 'unsubscribed');
  assert.equal(
    service.getConversation(conversationId).messages.at(-1).classification.kind,
    'unsubscribe',
  );
});

test('known SMTP or IMAP verification failure blocks first send without consuming the only attempt', async (t) => {
  const { service, fake } = newService();
  t.after(() => service.close());
  fake.failSmtpVerify(new Error('fixture-only SMTP diagnostic'));
  await assert.rejects(service.start(), (error) => error.code === 'MAIL_TRANSPORT_FAILED');
  assert.equal(service.status().mailbox.smtpStatus, 'error');
  assert.equal(service.requireCursor().nextUid, 100);
  await assert.rejects(
    service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'test-key-001' }),
    (error) => error.code === 'MAIL_CONNECTION_NOT_READY' && error.status === 503,
  );
  assert.equal(service.listConversations().items.length, 0);
  assert.equal(fake.calls.technical, 0);
  fake.failSmtpVerify(null);
  fake.failImapVerify(new Error('fixture-only IMAP diagnostic'));
  await assert.rejects(service.start(), (error) => error.code === 'MAIL_TRANSPORT_FAILED');
  await assert.rejects(
    service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'test-key-002' }),
    (error) => error.code === 'MAIL_CONNECTION_NOT_READY',
  );
  assert.equal(fake.calls.technical, 0);
  fake.failImapVerify(null);
  await service.start();
  const sent = await service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'test-key-001' });
  assert.equal(sent.accepted, true);
  assert.equal(fake.calls.technical, 1);
});

test('duplicate UID or Message-ID is not re-imported', async (t) => {
  const { service, fake } = newService();
  t.after(() => service.close());
  await service.start();
  await service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'test-key-001' });
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 101 },
    messages: [inbound()],
    skipped: [],
  });
  assert.equal((await service.sync()).imported, 1);
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 102 },
    messages: [inbound(101)],
    skipped: [],
  });
  assert.equal((await service.sync()).imported, 0);
  assert.equal(service.requireCursor().nextUid, 102);
});

test('explicit unsubscribe blocks drafts and further replies', async (t) => {
  const { service, fake } = newService();
  t.after(() => service.close());
  await service.start();
  const { conversationId } = await service.sendTechnicalTest({
    confirmed: true,
    idempotencyKey: 'test-key-001',
  });
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 101 },
    messages: [inbound(100, { kind: 'unsubscribe' })],
    skipped: [],
  });
  await service.sync();
  assert.equal(service.getConversation(conversationId).conversation.status, 'unsubscribed');
  await assert.rejects(
    service.sendReply(conversationId, {
      draftRevision: 1,
      confirmed: true,
      idempotencyKey: 'reply-key-001',
    }),
    (error) => error.code === 'MAIL_CONVERSATION_PAUSED',
  );
  assert.throws(
    () => service.saveDraft(conversationId, { bodyText: 'test', expectedRevision: 0 }),
    (error) => error.code === 'MAIL_CONVERSATION_PAUSED',
  );
  assert.equal(fake.calls.replies.length, 0);
  fake.batches.push({
    cursor: { uidValidity: '5', nextUid: 102 },
    messages: [{ ...inbound(101), messageId: '<later@honeybadgerblinds.com>' }],
    skipped: [],
  });
  await service.sync();
  assert.equal(service.getConversation(conversationId).conversation.status, 'unsubscribed');
});

test('invalid or regressed IMAP cursor fails closed without importing messages', async (t) => {
  const { service, fake } = newService();
  t.after(() => service.close());
  await service.start();
  await service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'test-key-001' });
  fake.batches.push({
    cursor: { uidValidity: 'other', nextUid: 101 },
    messages: [inbound()],
    skipped: [],
  });
  await assert.rejects(service.sync(), (error) => error.code === 'MAIL_SYNC_FAILED');
  assert.equal(service.requireCursor().nextUid, 100);
  assert.equal(service.listConversations().items[0].status, 'waiting_reply');
  assert.equal(service.status().mailbox.imapStatus, 'error');
});

test('uncertain send cannot be retried with old or new idempotency keys', async (t) => {
  const fake = fakeTransport();
  fake.failTechnical(new Error('fixture-only diagnostic: network lost after DATA'));
  const { service } = newService(fake);
  t.after(() => service.close());
  await service.start();
  await assert.rejects(
    service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'test-key-001' }),
    (error) =>
      error.code === 'MAIL_SEND_OUTCOME_UNKNOWN' && !String(error).includes('fixture-only'),
  );
  assert.equal(fake.calls.technical, 1);
  await assert.rejects(
    service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'test-key-001' }),
    (error) => error.code === 'MAIL_SEND_OUTCOME_UNKNOWN',
  );
  await assert.rejects(
    service.sendTechnicalTest({ confirmed: true, idempotencyKey: 'new-key-001' }),
    (error) => error.code === 'MAIL_TEST_ALREADY_ATTEMPTED',
  );
  assert.equal(fake.calls.technical, 1);
  assert.equal(service.listConversations().items[0].status, 'send_unknown');
});

test('restart preserves cursor and converts interrupted send to unknown, never auto-replays', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'shadeflow-mail-test-'));
  let second;
  t.after(() => {
    second?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const path = join(directory, 'pilot.sqlite');
  const fake = fakeTransport();
  const options = {
    env: { MAIL_DB_PATH: path, MAIL_CLIENT_PASSWORD: 'fixture-only' },
    transportFactory: fake.factory,
    now: () => new Date('2026-10-23T00:00:00Z'),
    pollIntervalMs: 0,
  };
  const first = new MailService(options);
  await first.start();
  first.transact(() => {
    const at = '2026-10-23T00:00:00Z';
    first.db
      .prepare(
        `INSERT INTO mail_conversations
      (id,subject,participant,marker,status,agent_status,unread,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'interrupted',
        '邮箱连接测试',
        PILOT_TEST_RECIPIENT,
        null,
        'sending_test',
        'not_running',
        0,
        at,
        at,
      );
    first.beginOperation({
      key: 'interrupted-key',
      kind: 'technical_test',
      payloadHash: 'fixture-hash',
      conversationId: 'interrupted',
    });
  });
  first.close();
  second = new MailService(options);
  await second.start();
  assert.equal(fake.calls.capture, 1);
  assert.equal(second.requireCursor().nextUid, 100);
  assert.equal(second.getConversation('interrupted').conversation.status, 'send_unknown');
  assert.equal(fake.calls.technical, 0);
});
