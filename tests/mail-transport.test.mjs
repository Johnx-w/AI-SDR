import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALIBABA_MAIL_ENDPOINTS,
  MailTransportError,
  classifyIncomingMail,
  createAlibabaMailTransport,
} from '../server/mail-transport.mjs';

const account = 'pilot@example.com';
const testRecipient = 'colleague@example.net';
const id = '12345678-1234-4123-8123-123456789abc';
const marker = `[ShadeFlow-Test:${id}]`;
const sentMessageId = `<shadeflow.${id}@example.com>`;

function fakeSmtp() {
  const calls = [];
  const options = [];
  const factory = (settings) => {
    options.push(settings);
    return {
      async verify() {
        return true;
      },
      async sendMail(message) {
        calls.push(message);
        return { accepted: [message.to], rejected: [] };
      },
      close() {},
    };
  };
  return { calls, options, factory };
}

function transportWithSmtp(smtp = fakeSmtp()) {
  const transport = createAlibabaMailTransport({
    account,
    clientPassword: 'fixture-only',
    allowedTestRecipients: [testRecipient],
    smtpFactory: smtp.factory,
    createId: () => id,
  });
  return { transport, ...smtp };
}

test('Alibaba endpoints use official hosts and implicit TLS ports', () => {
  assert.deepEqual(ALIBABA_MAIL_ENDPOINTS.imap, {
    host: 'imap.qiye.aliyun.com',
    port: 993,
    secure: true,
  });
  assert.deepEqual(ALIBABA_MAIL_ENDPOINTS.smtp, {
    host: 'smtp.qiye.aliyun.com',
    port: 465,
    secure: true,
  });
});

test('technical test mail fixes sender, envelope, recipient and non-marketing content', async () => {
  const { transport, calls, options } = transportWithSmtp();
  assert.deepEqual(await transport.verifySmtp(), { connected: true });
  const sent = await transport.sendTechnicalTest({ to: testRecipient });
  assert.deepEqual(sent, {
    messageId: sentMessageId,
    to: testRecipient,
    accepted: true,
    marker,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].from, account);
  assert.equal(calls[0].replyTo, account);
  assert.deepEqual(calls[0].envelope, { from: account, to: [testRecipient] });
  assert.match(calls[0].subject, /邮箱连接测试/);
  assert.match(calls[0].text, /不是产品推广/);
  assert.equal(calls[0].cc, undefined);
  assert.equal(calls[0].bcc, undefined);
  assert.equal(options[0].auth.user, account);
  assert.equal(options[0].secure, true);
  assert.equal(options[0].port, 465);
  assert.equal(options[0].logger, false);
});

test('test reply keeps exact thread headers and ignores caller-supplied sender', async () => {
  const { transport, calls } = transportWithSmtp();
  const sent = await transport.sendTestReply({
    to: testRecipient,
    subject: `Re: ${marker} 邮箱连接测试`,
    text: '收到，这是人工审核后的测试回信。',
    inReplyTo: '<incoming@example.net>',
    references: [sentMessageId],
    from: 'attacker@outside.example',
    replyTo: 'attacker@outside.example',
    envelope: { from: 'attacker@outside.example', to: ['outside@example.org'] },
  });
  assert.equal(sent.accepted, true);
  assert.equal(calls[0].from, account);
  assert.equal(calls[0].replyTo, account);
  assert.deepEqual(calls[0].envelope, { from: account, to: [testRecipient] });
  assert.equal(calls[0].inReplyTo, '<incoming@example.net>');
  assert.deepEqual(calls[0].references, [sentMessageId, '<incoming@example.net>']);
});

test('non-allowlisted recipient and malformed thread ID fail before SMTP transport creation', async () => {
  const smtp = fakeSmtp();
  const { transport } = transportWithSmtp(smtp);
  await assert.rejects(
    transport.sendTechnicalTest({ to: 'stranger@example.org' }),
    (error) => error instanceof MailTransportError && error.code === 'MAIL_RECIPIENT_NOT_ALLOWED',
  );
  await assert.rejects(
    transport.sendTestReply({
      to: testRecipient,
      subject: 'Re: test',
      text: 'hello',
      inReplyTo: 'not-an-id',
    }),
    (error) => error.code === 'MAIL_INVALID_MESSAGE_ID',
  );
  await assert.rejects(
    transport.sendTestReply({
      to: testRecipient,
      subject: 'Re: test\r\nBcc: stranger@example.org',
      text: 'hello',
      inReplyTo: '<incoming@example.net>',
    }),
    (error) => error.code === 'MAIL_INVALID_SUBJECT',
  );
  assert.equal(smtp.options.length, 0);
});

test('authenticated account casing is preserved for SMTP identity', async () => {
  const smtp = fakeSmtp();
  const transport = createAlibabaMailTransport({
    account: 'Pilot@example.com',
    clientPassword: 'fixture-only',
    allowedTestRecipients: [testRecipient],
    smtpFactory: smtp.factory,
    createId: () => id,
  });
  await transport.sendTechnicalTest({ to: testRecipient });
  assert.equal(smtp.options[0].auth.user, 'Pilot@example.com');
  assert.equal(smtp.calls[0].from, 'Pilot@example.com');
  assert.equal(smtp.calls[0].replyTo, 'Pilot@example.com');
  assert.equal(smtp.calls[0].envelope.from, 'Pilot@example.com');
});

test('provider errors do not propagate credential text', async () => {
  const transport = createAlibabaMailTransport({
    account,
    clientPassword: 'fixture-only',
    allowedTestRecipients: [testRecipient],
    smtpFactory: () => ({
      async verify() {
        throw Object.assign(new Error('fixture-only echoed'), { code: 'EAUTH' });
      },
      close() {},
    }),
  });
  await assert.rejects(transport.verifySmtp(), (error) => {
    assert.equal(error.code, 'MAIL_AUTH_FAILED');
    assert.doesNotMatch(String(error), /fixture-only/);
    return true;
  });
});

function mime({
  from = testRecipient,
  subject = `Re: ${marker} 邮箱连接测试`,
  messageId = '<reply@example.net>',
  inReplyTo = sentMessageId,
  references = sentMessageId,
  text = '收到',
} = {}) {
  return Buffer.from(
    [
      `From: ${from}`,
      `To: ${account}`,
      `Subject: ${subject}`,
      `Message-ID: ${messageId}`,
      `In-Reply-To: ${inReplyTo}`,
      `References: ${references}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ].join('\r\n'),
  );
}

function fakeImap({ uidValidity = 77n, uidNext = 5, found = [1, 2, 3, 4], rows = new Map() } = {}) {
  const options = [];
  const calls = [];
  const factory = (settings) => {
    options.push(settings);
    return {
      mailbox: { uidValidity, uidNext },
      async connect() {
        calls.push('connect');
      },
      async getMailboxLock(path, lockOptions) {
        calls.push(['lock', path, lockOptions]);
        return {
          release() {
            calls.push('release');
          },
        };
      },
      async search(query, searchOptions) {
        calls.push(['search', query, searchOptions]);
        return found;
      },
      async fetchOne(uid, query, fetchOptions) {
        calls.push(['fetchOne', uid, query, fetchOptions]);
        const row = rows.get(uid);
        if (!row) return false;
        if (query.source) return { uid, source: row.source };
        return {
          uid,
          envelope: {
            from: [{ address: row.from }],
            to: [{ address: account }],
            subject: row.subject,
          },
          size: row.source.length,
          headers: row.source.subarray(0, row.source.indexOf('\r\n\r\n') + 4),
          internalDate: new Date('2026-10-23T00:00:00Z'),
        };
      },
      async logout() {
        calls.push('logout');
      },
    };
  };
  return { factory, calls, options };
}

test('IMAP captures a baseline then reads only new exact-address test thread messages', async () => {
  const reply = mime();
  const outsider = mime({ from: 'outside@example.org' });
  const unrelated = mime({
    subject: 'Unrelated',
    inReplyTo: '<other@example.net>',
    references: '<other@example.net>',
  });
  const imap = fakeImap({
    rows: new Map([
      [2, { from: testRecipient, subject: `Re: ${marker} 邮箱连接测试`, source: reply }],
      [3, { from: 'outside@example.org', subject: `Re: ${marker}`, source: outsider }],
      [4, { from: testRecipient, subject: 'Unrelated', source: unrelated }],
    ]),
  });
  const transport = createAlibabaMailTransport({
    account,
    clientPassword: 'fixture-only',
    allowedTestRecipients: [testRecipient],
    imapFactory: imap.factory,
  });
  assert.deepEqual(await transport.verifyImap(), { connected: true });
  const captured = await transport.captureInboxCursor();
  assert.deepEqual(captured, { uidValidity: '77', nextUid: 5 });
  const synced = await transport.syncTestInbox({
    cursor: { uidValidity: '77', nextUid: 2 },
    knownMessageIds: [sentMessageId],
    knownTestMarkers: [marker],
  });
  assert.equal(synced.messages.length, 1);
  assert.equal(synced.messages[0].uid, 2);
  assert.equal(synced.messages[0].from, testRecipient);
  assert.equal(synced.messages[0].inReplyTo, sentMessageId);
  assert.equal(synced.messages[0].classification.kind, 'reply');
  assert.deepEqual(synced.skipped, [
    { uid: 3, reason: 'outside_test_addresses' },
    { uid: 4, reason: 'outside_test_thread' },
  ]);
  assert.deepEqual(synced.cursor, { uidValidity: '77', nextUid: 5 });
  assert.equal(synced.hasMore, false);
  assert.deepEqual(
    imap.calls.find((call) => Array.isArray(call) && call[0] === 'search'),
    ['search', { uid: '2:*' }, { uid: true }],
  );
  assert.ok(
    imap.calls
      .filter((call) => Array.isArray(call) && call[0] === 'lock')
      .every((call) => call[2].readOnly === true),
  );
  assert.equal(imap.options[0].secure, true);
  assert.equal(imap.options[0].port, 993);
  assert.equal(imap.options[0].logger, false);
});

test('IMAP UID validity changes fail closed without reading historical mail', async () => {
  const imap = fakeImap({ uidValidity: 88n });
  const transport = createAlibabaMailTransport({
    account,
    clientPassword: 'fixture-only',
    allowedTestRecipients: [testRecipient],
    imapFactory: imap.factory,
  });
  await assert.rejects(
    transport.syncTestInbox({
      cursor: { uidValidity: '77', nextUid: 2 },
      knownMessageIds: [sentMessageId],
    }),
    (error) => error.code === 'MAIL_UID_VALIDITY_CHANGED',
  );
  assert.equal(
    imap.calls.some((call) => Array.isArray(call) && call[0] === 'search'),
    false,
  );
});

test('classification recognizes simulated hard bounce and explicit unsubscribe', () => {
  const bounce = classifyIncomingMail({
    subject: 'Delivery Status Notification (Failure)',
    from: { value: [{ address: 'mailer-daemon@example.net' }] },
    text: 'Status: 5.1.1\nFinal-Recipient: rfc822; colleague@example.net',
    attachments: [
      { contentType: 'message/delivery-status', content: Buffer.from('Status: 5.1.1') },
    ],
  });
  assert.deepEqual(bounce, { kind: 'bounce', permanence: 'hard' });
  assert.deepEqual(
    classifyIncomingMail({ text: '退订', from: { value: [{ address: testRecipient }] } }),
    { kind: 'unsubscribe' },
  );
  assert.deepEqual(
    classifyIncomingMail({
      text: '关于退订流程的问题',
      from: { value: [{ address: testRecipient }] },
    }),
    { kind: 'reply' },
  );
});
