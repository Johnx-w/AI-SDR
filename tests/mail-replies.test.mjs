import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { MailReplies } from '../server/mail-replies.mjs';
import { MailConversations } from '../server/mail-conversations.mjs';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { simpleParser } from 'mailparser';
import {
  htmlToText,
  normalizeAttachments,
  normalizeReplyContent,
  sanitizeReplyHtml,
} from '../server/mail-content.mjs';

const at = '2026-10-27T04:00:00.000Z';
const attachment = (name = '报价单.pdf', content = 'quotation') => ({
  id: 'attachment-one',
  name,
  contentType: 'application/pdf',
  size: 999999,
  contentBase64: Buffer.from(content).toString('base64'),
});

function harness(t, options = {}) {
  const db = new DatabaseSync(options.path || ':memory:');
  const boxes = [
    {
      id: 'sales',
      email: 'sales@brand.example',
      signature: 'Kind regards,\nSales team',
      configured: true,
      smtpStatus: 'connected',
      paused: false,
      dailyLimit: 0,
    },
  ];
  const sends = [],
    archives = [],
    records = [];
  let sendHandler, archiveHandler, recordHandler;
  const mailboxes = {
    list: () => structuredClone(boxes),
    async send(id, message) {
      const mailbox = boxes.find((item) => item.id === id);
      if (mailbox.paused) throw Object.assign(new Error('paused'), { code: 'MAILBOX_PAUSED' });
      if (mailbox.email !== message.expectedAccount)
        throw Object.assign(new Error('identity changed'), { code: 'MAILBOX_IDENTITY_CHANGED' });
      sends.push({ id, message: structuredClone(message) });
      return sendHandler ? sendHandler(id, message) : { accepted: [message.to], rejected: [] };
    },
    async saveSent(id, message) {
      archives.push({ id, message: structuredClone(message) });
      if (archiveHandler) return archiveHandler(id, message);
      return { saved: true };
    },
  };
  const conversations = new MailConversations({ db, mailboxes, now: () => Date.parse(at) });
  const recordCommunication = async (detail) => {
    records.push(structuredClone(detail));
    if (recordHandler) return recordHandler(detail);
  };
  let replies = new MailReplies({
    db,
    mailboxes,
    conversations,
    recordCommunication,
    now: () => Date.parse(at),
  });
  t.after(async () => {
    await replies.close();
    await conversations.close();
    db.close();
  });
  return {
    db,
    boxes,
    mailboxes,
    conversations,
    sends,
    archives,
    records,
    get replies() {
      return replies;
    },
    async reopen() {
      await replies.close();
      replies = new MailReplies({
        db,
        mailboxes,
        conversations,
        recordCommunication,
        now: () => Date.parse(at),
      });
    },
    onSend(handler) {
      sendHandler = handler;
    },
    onArchive(handler) {
      archiveHandler = handler;
    },
    onRecord(handler) {
      recordHandler = handler;
    },
    add(overrides = {}) {
      const input = {
        messageId: '<inbound@buyer.example>',
        direction: 'inbound',
        from: 'buyer@buyer.example',
        to: boxes[0].email,
        toAddresses: [boxes[0].email],
        subject: 'Product enquiry',
        bodyText: 'Please send a quotation.',
        occurredAt: at,
        deliveryStatus: 'received',
        source: 'imap',
        ...overrides,
      };
      conversations.putMessage(boxes[0], input);
      const thread = conversations
        .list()
        .items.find((item) =>
          conversations
            .detail(item.id)
            .messages.some((message) => message.messageId === input.messageId),
        );
      const source = conversations
        .detail(thread.id)
        .messages.find((message) => message.messageId === input.messageId);
      return { id: thread.id, source: source.id };
    },
  };
}

const save = (h, thread, extra = {}) =>
  h.replies.saveDraft(thread.id, {
    replyToMessageId: thread.source,
    bodyHtml: '<p>Hello <strong>Buyer</strong>,</p><p>Please see our quotation.</p>',
    attachments: [],
    ...extra,
  });
const send = (h, thread, draft, key = 'manual-reply-0001', extra = {}) =>
  h.replies.reply(thread.id, {
    replyToMessageId: thread.source,
    draftRevision: draft.revision,
    idempotencyKey: key,
    bodyHtml: draft.bodyHtml,
    bodyText: draft.bodyText,
    attachments: draft.attachments,
    ...extra,
  });

test('rich replies retain basic formatting, derive meaningful plain text and remove executable HTML', () => {
  const html =
    '<p style="text-align:center;color:#123;position:fixed;background-image:url(https://tracking.example)">Hello &amp; 欢迎<br><strong>Buyer</strong></p><script>secret()</script><iframe src="https://tracking.example"></iframe><a href="javascript:alert(1)" onclick="secret()">Link</a><img src="https://tracking.example/pixel">';
  const cleaned = sanitizeReplyHtml(html);
  assert.match(cleaned, /text-align:center/);
  assert.match(cleaned, /<strong>Buyer<\/strong>/);
  assert.doesNotMatch(cleaned, /script|iframe|javascript:|onclick|tracking\.example|position:/);
  assert.equal(htmlToText('<p>One &amp; Two</p><p>第二段<br>Done</p>'), 'One & Two\n第二段\nDone');
  const content = normalizeReplyContent({
    bodyHtml: '<p>Actual body</p>',
    bodyText: 'untrusted alternate text',
  });
  assert.equal(content.bodyText, 'Actual body');
  assert.throws(() => normalizeReplyContent({ bodyHtml: '<p><br>&nbsp;\u200b</p>' }), {
    status: 400,
  });
  assert.deepEqual(normalizeReplyContent({ bodyText: 'Plain <original> text' }), {
    bodyHtml: '',
    bodyText: 'Plain <original> text',
  });
});

test('manual reply signature HTML survives draft saving and sending exactly once', async (t) => {
  const h = harness(t);
  const thread = h.add();
  h.boxes[0].displayName = 'Alice';
  h.boxes[0].signatureDesign = {
    closing: 'Best regards,',
    companyName: 'Example Company',
    address: 'China',
    website: 'https://example.com',
    logoWidth: 160,
    logo: {
      name: 'logo.png',
      contentType: 'image/png',
      contentBase64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
    },
  };
  const context = h.replies.detailExtras(thread.id).replyContext;
  assert.match(context.signatureHtml, /<strong>Alice<\/strong>/);
  const draft = save(h, thread, { bodyHtml: '<p>Hello Buyer</p>' + context.signatureHtml });
  assert.match(draft.bodyHtml, /data:image\/png;base64,/);
  await send(h, thread, draft);
  assert.equal((h.sends[0].message.html.match(/<img /g) || []).length, 1);
  assert.match(h.sends[0].message.text, /Best regards,\nAlice/);
  assert.equal(h.archives[0].message.html, h.sends[0].message.html);
});

test('attachments use decoded bytes and canonical filenames, discard URL/path options and enforce aggregate limits', () => {
  const normalized = normalizeAttachments([
    {
      ...attachment(),
      name: undefined,
      filename: '../../folder/报价单.pdf',
      path: 'C:/private/secret',
      href: 'https://tracking.example',
    },
  ]);
  assert.equal(normalized[0].name, '报价单.pdf');
  assert.equal(normalized[0].filename, undefined);
  assert.equal(normalized[0].size, Buffer.byteLength('quotation'));
  assert.equal(normalized[0].path, undefined);
  assert.equal(normalized[0].href, undefined);
  assert.equal(
    normalizeAttachments([{ ...attachment(), contentType: 'application/vnd.business+custom' }])[0]
      .contentType,
    'application/vnd.business+custom',
  );
  assert.throws(() => normalizeAttachments(Array.from({ length: 11 }, () => attachment())), {
    status: 400,
  });
  assert.throws(() => normalizeAttachments([{ ...attachment(), contentBase64: 'not-base64!' }]), {
    status: 400,
  });
  const maximum = {
    ...attachment(),
    contentBase64: Buffer.alloc(10 * 1024 * 1024).toString('base64'),
  };
  assert.equal(normalizeAttachments([maximum])[0].size, 10 * 1024 * 1024);
  assert.throws(() => normalizeAttachments([maximum, attachment('one.txt', 'x')]), { status: 400 });
});

test('drafts bind the selected actual message, prefer Reply-To, preserve revisions and reject stale updates', async (t) => {
  const h = harness(t);
  const thread = h.add({ replyTo: ['purchasing@buyer.example'] });
  const extra = h.replies.detailExtras(thread.id);
  assert.equal(extra.draft, null);
  assert.equal(extra.replyContext.to, 'purchasing@buyer.example');
  assert.equal(extra.replyContext.signature, h.boxes[0].signature);
  const first = save(h, thread, { attachments: [attachment()] });
  assert.equal(first.revision, 1);
  assert.equal(h.replies.draft(thread.id).attachments[0].contentBase64, attachment().contentBase64);
  const second = save(h, thread, {
    revision: first.revision,
    bodyText: 'Plain replacement',
    bodyHtml: '',
  });
  assert.equal(second.revision, 2);
  assert.throws(() => save(h, thread, { revision: first.revision }), { status: 409 });
  assert.throws(
    () =>
      save(h, thread, { revision: second.revision, replyToMessageId: 'another-thread-message' }),
    { status: 409 },
  );
  await h.reopen();
  assert.equal(h.replies.draft(thread.id).revision, 2);
  h.replies.deleteDraft(thread.id, { revision: 2 });
  assert.equal(h.replies.draft(thread.id), null);
  const third = save(h, thread);
  assert.equal(third.revision, 3);
  assert.throws(() => save(h, thread, { expectedRevision: 2 }), { status: 409 });
  assert.equal(h.sends.length, 0);
});

test('outbound replies require one external recipient and cannot switch the original sending account', (t) => {
  const h = harness(t);
  const multiple = h.add({
    direction: 'outbound',
    from: h.boxes[0].email,
    to: 'one@buyer.example,two@buyer.example',
    toAddresses: ['one@buyer.example', 'two@buyer.example'],
    deliveryStatus: 'sent',
  });
  assert.equal(h.replies.detailExtras(multiple.id).replyContext.canReply, false);
  assert.throws(() => save(h, multiple), { status: 409 });
  const single = h.add({
    messageId: '<outbound@brand.example>',
    direction: 'outbound',
    from: h.boxes[0].email,
    to: 'buyer@buyer.example',
    toAddresses: [h.boxes[0].email, 'buyer@buyer.example'],
    deliveryStatus: 'sent',
  });
  assert.equal(h.replies.detailExtras(single.id).replyContext.to, 'buyer@buyer.example');
  const self = h.add({
    messageId: '<self@brand.example>',
    from: h.boxes[0].email,
    replyTo: [h.boxes[0].email],
  });
  assert.throws(() => save(h, self), { status: 409 });
  assert.equal(h.sends.length, 0);
});

test('accepted replies immediately join the same thread, use the saved content and archive once without campaign limits', async (t) => {
  const h = harness(t);
  const thread = h.add({
    replyTo: ['purchasing@buyer.example'],
    references: ['<earlier@buyer.example>'],
  });
  const draft = save(h, thread, { attachments: [attachment()] });
  const result = await send(h, thread, draft, 'manual-reply-success', {
    to: 'unapproved@elsewhere.example',
    from: 'other@brand.example',
  });
  assert.equal(result.reply.status, 'accepted');
  assert.equal(result.reply.archiveStatus, 'saved');
  assert.equal(result.reply.recordStatus, 'recorded');
  assert.equal(result.messages.length, 2);
  assert.equal(result.conversation.id, thread.id);
  const recordedReply = result.messages.find(
    (message) => message.messageId === result.reply.messageId,
  );
  assert.equal(recordedReply.source, 'manual');
  assert.equal(recordedReply.deliveryStatus, 'accepted');
  assert.equal(recordedReply.bodyHtml, draft.bodyHtml);
  assert.equal(h.sends[0].message.to, 'purchasing@buyer.example');
  assert.equal(h.sends[0].message.expectedAccount, h.boxes[0].email);
  assert.equal(h.sends[0].message.inReplyTo, '<inbound@buyer.example>');
  assert.deepEqual(h.sends[0].message.references, [
    '<earlier@buyer.example>',
    '<inbound@buyer.example>',
  ]);
  assert.equal(h.sends[0].message.attachments[0].size, Buffer.byteLength('quotation'));
  assert.equal(h.replies.draft(thread.id), null);
  assert.equal(h.records[0].messages.length, 2);
  assert.equal(h.archives.length, 1);
  const replay = await send(h, thread, draft, 'manual-reply-success');
  assert.equal(replay.reply.id, result.reply.id);
  assert.equal(h.sends.length, 1);
  assert.equal(h.archives.length, 1);
  assert.equal(h.records.length, 1);
  assert.equal(
    JSON.stringify(h.replies.detailExtras(thread.id).replies).includes(attachment().contentBase64),
    false,
  );
  assert.throws(
    () => send(h, thread, draft, 'manual-reply-success', { bodyHtml: '<p>A different reply</p>' }),
    { status: 409 },
  );
});

test('a different source, stale revision or changed unsaved payload cannot reach SMTP', (t) => {
  const h = harness(t);
  const thread = h.add();
  const second = h.add({ messageId: '<unrelated@buyer.example>', from: 'other@buyer.example' });
  const draft = save(h, thread);
  assert.throws(
    () => send(h, thread, draft, 'wrong-source-0001', { replyToMessageId: second.source }),
    { status: 409 },
  );
  assert.throws(
    () => send(h, thread, draft, 'stale-revision-01', { draftRevision: draft.revision + 1 }),
    { status: 409 },
  );
  assert.throws(
    () => send(h, thread, draft, 'changed-content-01', { bodyHtml: '<p>Unsaved content</p>' }),
    { status: 409 },
  );
  assert.throws(
    () => send(h, thread, draft, 'changed-attachment', { attachments: [attachment()] }),
    { status: 409 },
  );
  assert.equal(h.sends.length, 0);
});

test('concurrent same-key sends share one operation and completion preserves a newer saved draft', async (t) => {
  const h = harness(t);
  const thread = h.add();
  const draft = save(h, thread);
  let release;
  h.onSend(
    (id, message) =>
      new Promise((resolve) => {
        release = () => resolve({ accepted: [message.to], rejected: [] });
      }),
  );
  const first = send(h, thread, draft, 'concurrent-send-01');
  const replay = send(h, thread, draft, 'concurrent-send-01');
  assert.equal(first, replay);
  assert.throws(() => send(h, thread, draft, 'duplicate-send-02'), { status: 409 });
  const newer = save(h, thread, {
    revision: draft.revision,
    bodyHtml: '<p>Another unsent draft</p>',
  });
  let closed = false;
  const closing = h.replies.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  assert.equal((await first).reply.status, 'accepted');
  await closing;
  await h.reopen();
  assert.equal(h.replies.draft(thread.id).revision, newer.revision);
  assert.equal(h.sends.length, 1);
});

test('archive and business-record failures retain accepted evidence and never resend on replay', async (t) => {
  const h = harness(t);
  const thread = h.add();
  const draft = save(h, thread);
  h.onArchive(() => {
    throw new Error('provider echoes confidential credential');
  });
  h.onRecord(() => {
    throw new Error('external write response lost');
  });
  const result = await send(h, thread, draft, 'archive-failure-01');
  assert.equal(result.reply.status, 'accepted');
  assert.equal(result.reply.archiveStatus, 'error');
  assert.equal(result.reply.recordStatus, 'error');
  assert.match(result.reply.recordError, /登记失败/);
  assert.equal(result.messages.length, 2);
  assert.equal(h.replies.draft(thread.id), null);
  assert.doesNotMatch(
    JSON.stringify(result),
    /confidential credential|external write response lost/,
  );
  await send(h, thread, draft, 'archive-failure-01');
  assert.equal(h.sends.length, 1);
  assert.equal(h.archives.length, 1);
  assert.equal(h.records.length, 1);
});

test('uncertain SMTP outcomes remain unknown and block a changed key from resending the same message', async (t) => {
  const h = harness(t);
  const thread = h.add();
  const draft = save(h, thread);
  h.onSend(() => {
    throw new Error('SMTP accepted before connection lost with credential secret');
  });
  const unknown = await send(h, thread, draft, 'smtp-unknown-0001');
  assert.equal(unknown.reply.status, 'unknown');
  assert.equal(unknown.messages.length, 1);
  assert.equal(h.replies.draft(thread.id).revision, draft.revision);
  assert.doesNotMatch(JSON.stringify(unknown), /credential secret/);
  await send(h, thread, draft, 'smtp-unknown-0001');
  assert.throws(() => send(h, thread, draft, 'smtp-unknown-0002'), { status: 409 });
  const nextRevision = save(h, thread, { revision: draft.revision, bodyHtml: draft.bodyHtml });
  assert.throws(() => send(h, thread, nextRevision, 'smtp-unknown-0003'), { status: 409 });
  assert.equal(h.sends.length, 1);
  assert.equal(h.archives.length, 0);
});

test('the mailbox pause still prevents manual SMTP and a later explicit retry uses a new key', async (t) => {
  const h = harness(t);
  const thread = h.add();
  const draft = save(h, thread);
  h.boxes[0].paused = true;
  const failed = await send(h, thread, draft, 'paused-mailbox-01');
  assert.equal(failed.reply.status, 'failed');
  assert.equal(h.sends.length, 0);
  h.boxes[0].paused = false;
  const result = await send(h, thread, draft, 'unpaused-mail-002');
  assert.equal(result.reply.status, 'accepted');
  assert.equal(h.sends.length, 1);
});

test('malformed inputs and missing or stale delete revisions are rejected without changing the draft', (t) => {
  const h = harness(t);
  const thread = h.add();
  const draft = save(h, thread);
  for (const value of [null, [], 'invalid']) {
    assert.throws(() => h.replies.saveDraft(thread.id, value), { status: 400 });
    assert.throws(() => h.replies.reply(thread.id, value), { status: 400 });
    assert.throws(() => h.replies.deleteDraft(thread.id, value), { status: 400 });
  }
  assert.throws(() => h.replies.deleteDraft(thread.id), { status: 400 });
  assert.throws(() => h.replies.deleteDraft(thread.id, { revision: draft.revision + 1 }), {
    status: 409,
  });
  assert.equal(h.replies.draft(thread.id).revision, draft.revision);
  h.boxes[0].paused = true;
  const context = h.replies.detailExtras(thread.id).replyContext;
  assert.equal(context.canReply, true);
  assert.equal(context.canSend, false);
  assert.match(context.reason, /暂停/);
});

test('autosaving identical content during SMTP does not permit a second accepted send under a new key', async (t) => {
  const h = harness(t);
  const thread = h.add();
  const draft = save(h, thread);
  let release;
  h.onSend(
    (id, message) =>
      new Promise((resolve) => {
        release = () => resolve({ accepted: [message.to], rejected: [] });
      }),
  );
  const sending = send(h, thread, draft, 'autosave-first-send');
  const autosaved = save(h, thread, { revision: draft.revision, bodyHtml: draft.bodyHtml });
  release();
  assert.equal((await sending).reply.status, 'accepted');
  assert.equal(h.replies.draft(thread.id).revision, autosaved.revision);
  assert.throws(() => send(h, thread, autosaved, 'autosave-second-send'), { status: 409 });
  assert.equal(h.sends.length, 1);
});

test('accepted SMTP survives a draft cleanup write failure and still prevents a new-key resend', async (t) => {
  const h = harness(t);
  const thread = h.add();
  const draft = save(h, thread);
  h.db.exec(`CREATE TRIGGER fail_reply_draft_cleanup BEFORE UPDATE OF data ON mail_reply_drafts
    WHEN NEW.data IS NULL BEGIN SELECT RAISE(FAIL, 'Simulated local draft write failure'); END;`);
  const result = await send(h, thread, draft, 'draft-cleanup-fail');
  assert.equal(result.reply.status, 'accepted');
  assert.match(result.reply.draftError, /草稿清理失败/);
  assert.equal(result.messages.length, 2);
  assert.equal(h.replies.draft(thread.id).revision, draft.revision);
  assert.throws(() => send(h, thread, draft, 'draft-cleanup-retry'), { status: 409 });
  assert.equal(h.sends.length, 1);
});

test('the same response text can answer a newly received message in the same conversation', async (t) => {
  const h = harness(t);
  const first = h.add();
  const draft = save(h, first);
  await send(h, first, draft, 'first-source-reply');
  const later = h.add({
    messageId: '<new-question@buyer.example>',
    inReplyTo: '<inbound@buyer.example>',
    bodyText: 'Please confirm again.',
  });
  assert.equal(later.id, first.id);
  const next = save(h, later, { bodyHtml: draft.bodyHtml });
  assert.equal((await send(h, later, next, 'second-source-reply')).reply.status, 'accepted');
  assert.equal(h.sends.length, 2);
});

test('a saved outbound first touch without normalized To metadata still has a single reply target', async (t) => {
  const h = harness(t);
  const thread = h.add({
    direction: 'outbound',
    from: h.boxes[0].email,
    to: 'buyer@buyer.example',
    toAddresses: [],
    deliveryStatus: 'accepted',
    source: 'outreach',
  });
  assert.equal(h.replies.detailExtras(thread.id).replyContext.to, 'buyer@buyer.example');
  const draft = save(h, thread);
  assert.equal((await send(h, thread, draft, 'legacy-first-touch')).reply.status, 'accepted');
});

test('a post-SMTP ledger write failure still exposes the actual acknowledgement and guards replay', async (t) => {
  const h = harness(t);
  const thread = h.add();
  const draft = save(h, thread);
  h.db.exec(`CREATE TRIGGER fail_accepted_reply_state BEFORE UPDATE ON mail_reply_operations
    WHEN NEW.status = 'accepted' BEGIN SELECT RAISE(FAIL, 'Simulated local result write failure'); END;`);
  const result = await send(h, thread, draft, 'accepted-ledger-fail');
  assert.equal(result.reply.status, 'accepted');
  assert.match(result.reply.persistenceError, /本地发送记录保存失败/);
  assert.equal(result.messages.length, 2);
  assert.equal(h.replies.detailExtras(thread.id).replies[0].status, 'accepted');
  const replay = await send(h, thread, draft, 'accepted-ledger-fail');
  assert.equal(replay.reply.status, 'accepted');
  assert.equal(h.sends.length, 1);
  assert.equal(h.archives.length, 1);
});

test('a detail read failure after SMTP acceptance never turns the acknowledged send into an API failure', async (t) => {
  const h = harness(t);
  const thread = h.add();
  const draft = save(h, thread);
  const originalDetail = h.conversations.detail.bind(h.conversations);
  h.onSend((id, message) => {
    h.conversations.detail = () => {
      throw new Error('Simulated local read failure');
    };
    return { accepted: [message.to], rejected: [] };
  });
  const result = await send(h, thread, draft, 'accepted-read-fail');
  assert.equal(result.reply.status, 'accepted');
  assert.match(result.reply.recordError, /本地会话记录待核对/);
  assert.equal(result.conversation, undefined);
  h.conversations.detail = originalDetail;
  assert.equal((await send(h, thread, draft, 'accepted-read-fail')).reply.status, 'accepted');
  assert.equal(h.sends.length, 1);
});

test('real mailbox adapter accepts normalized attachments and long references and archives the same rich MIME', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mail-replies-adapter-'));
  const sent = [],
    appended = [];
  const mailboxes = new OutreachMailboxes({
    path: join(directory, 'mailboxes.json'),
    seedPath: null,
    protect: async (value) => ({
      credentialProtection: 'windows-dpapi-current-user',
      credential: Buffer.from(value).toString('base64'),
    }),
    unprotect: async (value) => Buffer.from(value, 'base64').toString('utf8'),
    transportFactory: () => ({
      verify: async () => true,
      sendMail: async (message) => {
        sent.push(message);
        return { accepted: [message.to], rejected: [] };
      },
      close() {},
    }),
    imapFactory: () => ({
      connect: async () => {},
      list: async () => [{ path: 'Sent', specialUse: '\\Sent' }],
      getMailboxLock: async () => ({ release() {} }),
      search: async () => [],
      append: async (folder, raw) => {
        appended.push({ folder, raw });
        return { uid: 1 };
      },
      logout: async () => {},
      close() {},
    }),
  });
  const db = new DatabaseSync(':memory:');
  const conversations = new MailConversations({ db, mailboxes });
  const replies = new MailReplies({ db, mailboxes, conversations, now: () => Date.parse(at) });
  t.after(async () => {
    await replies.close();
    await conversations.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await mailboxes.save({
    id: 'sales',
    email: 'sales@brand.example',
    displayName: 'Sales Team',
    signature: 'Sales Team',
    paused: false,
    clientPassword: 'synthetic-test-password',
  });
  await mailboxes.verify('sales');
  await mailboxes.save({ id: 'sales', paused: false });
  const mailbox = mailboxes.get('sales');
  conversations.putMessage(mailbox, {
    messageId: '<adapter-source@buyer.example>',
    direction: 'inbound',
    from: 'buyer@buyer.example',
    to: mailbox.email,
    subject: 'Long running conversation',
    bodyText: 'Please provide a quotation.',
    source: 'imap',
    deliveryStatus: 'received',
    occurredAt: at,
    references: Array.from({ length: 99 }, (_, index) => `<previous-${index}@buyer.example>`),
  });
  const thread = conversations.list().items[0];
  const source = conversations.detail(thread.id).messages[0];
  const draft = replies.saveDraft(thread.id, {
    replyToMessageId: source.id,
    bodyHtml: '<p>Hello <strong>Buyer</strong>,</p><p>报价请见附件。</p>',
    attachments: [{ ...attachment(), filename: '报价单.pdf' }],
  });
  const result = await replies.reply(thread.id, {
    replyToMessageId: source.id,
    draftRevision: draft.revision,
    idempotencyKey: 'real-adapter-reply',
  });
  assert.equal(result.reply.status, 'accepted');
  assert.equal(result.reply.archiveStatus, 'saved');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].references.length, 50);
  assert.equal(sent[0].references.at(-1), '<adapter-source@buyer.example>');
  assert.equal(sent[0].from.address, mailbox.email);
  assert.equal(sent[0].attachments[0].filename, '报价单.pdf');
  assert.ok(Buffer.isBuffer(sent[0].attachments[0].content));
  assert.equal(sent[0].attachments[0].content.toString(), 'quotation');
  assert.equal(appended.length, 1);
  const parsed = await simpleParser(appended[0].raw);
  assert.equal(parsed.messageId, result.reply.messageId);
  assert.match(parsed.html, /<strong>Buyer<\/strong>/);
  assert.equal(parsed.attachments[0].filename, '报价单.pdf');
  assert.equal(parsed.attachments[0].content.toString(), 'quotation');
});

test('a process restart changes interrupted sending to unknown and replay never opens SMTP', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'mail-reply-recovery-'));
  const file = join(folder, 'reply.sqlite');
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { DatabaseSync } from 'node:sqlite';
    import { MailConversations } from './server/mail-conversations.mjs';
    import { MailReplies } from './server/mail-replies.mjs';
    const db = new DatabaseSync(process.argv[1]);
    const mailbox = {id:'sales',email:'sales@brand.example'};
    const mailboxes = {list:()=>[mailbox],send(){process.stdout.write('sending persisted');process.exit(0)}};
    const conversations = new MailConversations({db,mailboxes});
    conversations.putMessage(mailbox,{messageId:'<crash@buyer.example>',direction:'inbound',from:'buyer@buyer.example',to:mailbox.email,subject:'Question',bodyText:'A question',occurredAt:'${at}',deliveryStatus:'received',source:'imap'});
    const thread=conversations.list().items[0];
    const source=conversations.detail(thread.id).messages[0];
    const replies=new MailReplies({db,mailboxes,conversations});
    const draft=replies.saveDraft(thread.id,{replyToMessageId:source.id,bodyText:'Saved reply'});
    replies.reply(thread.id,{replyToMessageId:source.id,draftRevision:draft.revision,idempotencyKey:'process-crash-0001'});
  `,
      file,
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /sending persisted/);
  const h = harness(t, { path: file });
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const thread = h.conversations.list().items[0];
  const draft = h.replies.draft(thread.id);
  const replay = await h.replies.reply(thread.id, {
    replyToMessageId: draft.replyToMessageId,
    draftRevision: draft.revision,
    idempotencyKey: 'process-crash-0001',
  });
  assert.equal(replay.reply.status, 'unknown');
  assert.equal(h.sends.length, 0);
  assert.throws(
    () =>
      h.replies.reply(thread.id, {
        replyToMessageId: draft.replyToMessageId,
        draftRevision: draft.revision,
        idempotencyKey: 'process-crash-0002',
      }),
    { status: 409 },
  );
});
