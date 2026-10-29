import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { simpleParser } from 'mailparser';
import { renderMailboxSignature } from '../src/domain/mail-signature.mjs';

const secret = 'synthetic-test-password';
const address = 'sales@example.com';
const ciphertext = Buffer.from(secret).toString('base64');
const smtp = { host: 'smtp.qiye.aliyun.com', port: 465, secure: true };
const settings = {
  id: 'test-mailbox',
  email: address,
  website: 'https://example.com',
  displayName: 'Example Sales',
  paused: false,
};
const mail = {
  to: 'buyer@example.org',
  subject: 'Connection test',
  text: 'Non-marketing connection test.',
  messageId: '<unique-operation@example.com>',
};

const signatureDesign = {
  closing: 'Best regards,',
  companyName: 'Example Company',
  address: 'Dongguan, China',
  website: 'https://example.com',
  logoWidth: 160,
  logo: {
    name: 'logo.png',
    contentType: 'image/png',
    contentBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  },
};

test('structured signatures persist per account and follow identity edits without replacing old plain signatures', async (t) => {
  const { registry, config } = fixture(t);
  await registry.save({ ...settings, signature: 'Existing plain signature' });
  assert.equal(
    (await registry.save({ id: settings.id, dailyLimit: 30 })).signature,
    'Existing plain signature',
  );
  await registry.save({ id: settings.id, signatureDesign });
  const renamed = await registry.save({ id: settings.id, displayName: 'Alice' });
  assert.match(renamed.signature, /^Best regards,\nAlice\n/);
  assert.deepEqual(renamed.signatureDesign.logo, signatureDesign.logo);
  const other = await registry.save({ email: 'second@example.org', signature: 'Other team' });
  assert.equal(other.signatureDesign, undefined);
  assert.equal(other.signature, 'Other team');
  assert.deepEqual(
    new OutreachMailboxes(config).get(settings.id).signatureDesign,
    renamed.signatureDesign,
  );
  assert.equal(new OutreachMailboxes(config).get(settings.id).signature, renamed.signature);
  const plain = await registry.save({
    id: settings.id,
    signatureDesign: null,
    signature: 'Plain again',
  });
  assert.equal(plain.signature, 'Plain again');
  assert.equal(plain.signatureDesign, undefined);
});

test('SMTP and the saved Sent copy contain the same inline logo with the approved size and MIME bytes', async (t) => {
  const imap = sentImap();
  const { registry, sent } = fixture(t, { imapFactory: imap.factory });
  const mailbox = await registry.save({ ...settings, signatureDesign, clientPassword: secret });
  await registry.verify(settings.id);
  const signature = renderMailboxSignature(mailbox);
  const message = {
    ...mail,
    text: 'Hello\n\n' + signature.text,
    html: '<p>Hello</p>' + signature.html,
  };
  await registry.send(settings.id, message);
  await registry.saveSent(settings.id, message);
  assert.equal(sent[0].attachments.length, 1);
  assert.equal(sent[0].attachments[0].contentDisposition, 'inline');
  assert.match(sent[0].html, /src="cid:/);
  const raw = imap.calls.find((call) => call[0] === 'append')[2];
  const parsed = await simpleParser(raw, { skipImageLinks: true });
  assert.equal(parsed.html, sent[0].html);
  assert.equal(parsed.attachments[0].cid, sent[0].attachments[0].cid);
  assert.deepEqual(
    parsed.attachments[0].content,
    Buffer.from(signatureDesign.logo.contentBase64, 'base64'),
  );
  assert.match(parsed.html, /width="160"/);
});

function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'outreach-mailboxes-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const sent = [];
  const transportOptions = [];
  const path = join(directory, 'registry.json');
  const config = {
    path,
    seedPath: null,
    protect: async (value) => ({
      credentialProtection: 'windows-dpapi-current-user',
      credential: Buffer.from(value).toString('base64'),
    }),
    unprotect: async (value) => Buffer.from(value, 'base64').toString('utf8'),
    transportFactory: (config) => {
      transportOptions.push(config);
      return {
        verify: async () => true,
        sendMail: async (message) => {
          sent.push(message);
          return { accepted: [message.to], rejected: [], response: secret };
        },
        close() {},
      };
    },
    ...options,
  };
  return {
    directory,
    path,
    config,
    registry: new OutreachMailboxes(config),
    sent,
    transportOptions,
  };
}

test('mailbox credentials remain encrypted and are absent from every public projection', async (t) => {
  const { registry, path, config } = fixture(t);
  const created = await registry.save({ ...settings, clientPassword: secret });
  assert.equal(created.credentialConfigured, true);
  assert.equal(created.configured, true);
  assert.equal(created.smtpStatus, 'not_checked');
  assert.equal(created.lastCheckedAt, null);
  assert.equal(created.lastError, null);
  assert.equal(created.verification.smtpVerified, false);
  assert.equal(created.configurationComplete, false);
  assert.equal(created.sendingEnabled, false);
  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(persisted.mailboxes[0].credential, ciphertext);
  assert.equal(readFileSync(path, 'utf8').includes(secret), false);
  const restarted = new OutreachMailboxes(config);
  for (const result of [
    created,
    restarted.get(settings.id),
    restarted.list(),
    await restarted.verify(settings.id),
  ]) {
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(ciphertext), false);
    assert.equal(serialized.includes('credentialProtection'), false);
  }
  const copy = restarted.get(settings.id);
  copy.verification.smtpVerified = false;
  assert.equal(restarted.get(settings.id).verification.smtpVerified, true);
});

test('shared-pool accounts can be saved or imported without website metadata and preserve existing metadata on edit', async (t) => {
  const { registry, path } = fixture(t);
  const created = await registry.save({
    email: 'sales@pool.example',
    clientPassword: secret,
    signature: 'Company sales team',
  });
  assert.equal(created.website, 'https://pool.example');
  assert.equal(created.configurationComplete, true);
  assert.equal(created.credentialConfigured, true);
  assert.equal(created.paused, true);
  assert.deepEqual(created.productIds, []);
  const imported = await registry.import([
    { email: 'second@pool.example', clientPassword: secret, signature: 'Company sales team' },
  ]);
  assert.equal(imported[0].website, 'https://pool.example');
  assert.equal(imported[0].configurationComplete, true);
  await registry.save({ id: created.id, website: 'https://legacy-company.example' });
  const updated = await registry.save({ id: created.id, signature: 'Updated company signature' });
  assert.equal(updated.website, 'https://legacy-company.example');
  assert.equal(updated.email, created.email);
  assert.equal(updated.signature, 'Updated company signature');
  assert.equal(readFileSync(path, 'utf8').includes(secret), false);
});

test('prepared DPAPI seed is imported once, preserving source and SMTP verification independently of send authorization', (t) => {
  const { directory, path, config } = fixture(t);
  const seedPath = join(directory, 'seed.json');
  const source = JSON.stringify({
    schemaVersion: 1,
    purpose: 'test',
    mailboxes: [
      {
        id: 'honeybadgerblinds',
        email: 'SL01@honeybadgerblinds.com',
        website: 'https://honeybadgerblinds.com',
        smtp,
        credentialProtection: 'windows-dpapi-current-user',
        credential: ciphertext,
        verification: {
          email: 'SL01@honeybadgerblinds.com',
          smtpVerified: true,
          checkedAt: '2026-10-26T06:00:00.000Z',
        },
        sendingEnabled: false,
      },
    ],
  });
  writeFileSync(seedPath, source);
  const registry = new OutreachMailboxes({ ...config, seedPath });
  const first = registry.list()[0];
  assert.equal(first.brandName, 'Honey Badger Blinds');
  assert.equal(first.signature, '');
  assert.deepEqual(first.productIds, []);
  assert.equal(first.paused, false);
  assert.equal(first.verification.smtpVerified, true);
  assert.equal(first.configured, true);
  assert.equal(first.smtpStatus, 'connected');
  assert.equal(first.lastCheckedAt, '2026-10-26T06:00:00.000Z');
  assert.equal(first.lastError, null);
  assert.equal(first.sendingEnabled, false);
  assert.equal(first.configurationComplete, false);
  assert.equal(readFileSync(seedPath, 'utf8'), source);
  assert.equal(existsSync(path), true);
  writeFileSync(seedPath, 'invalid later seed');
  assert.equal(new OutreachMailboxes({ ...config, seedPath }).list().length, 1);
});

test('batch import is atomic, enforces case-insensitive uniqueness, and validates transport/settings', async (t) => {
  const { registry, path } = fixture(t);
  await assert.rejects(
    registry.import([
      { ...settings, clientPassword: secret },
      { ...settings, id: 'second', email: 'SALES@EXAMPLE.COM', clientPassword: secret },
    ]),
    { code: 'MAILBOX_DUPLICATE' },
  );
  assert.equal(registry.list().length, 0);
  assert.equal(existsSync(path), false);
  for (const patch of [
    { dailyLimit: 501 },
    { intervalSeconds: 4 },
    { intervalSeconds: 86401 },
    { smtp: { ...smtp, host: 'attacker.example' } },
    { smtp: { ...smtp, secure: false } },
    { email: 'sales@example.com\r\nBcc: bad@example.org' },
    { verification: { smtpVerified: true } },
  ]) {
    await assert.rejects(registry.save({ ...settings, ...patch, clientPassword: secret }), {
      code: 'MAILBOX_INVALID',
    });
  }
  await assert.rejects(registry.import(Array.from({ length: 21 }, () => settings)), {
    code: 'MAILBOX_INVALID',
  });
  for (const intervalSeconds of [5, 29, 86400]) {
    const saved = await registry.save({ ...settings, intervalSeconds, clientPassword: secret });
    assert.equal(saved.intervalSeconds, intervalSeconds);
  }
});

test('editing credentials or account resets verification, while metadata edits retain it', async (t) => {
  const { registry } = fixture(t);
  await registry.save({ ...settings, clientPassword: secret });
  await registry.verify(settings.id);
  const edited = await registry.save({
    id: settings.id,
    signature: 'Example Sales',
    dailyLimit: 25,
  });
  assert.deepEqual(edited.productIds, []);
  assert.equal(edited.verification.smtpVerified, true);
  assert.equal(edited.configurationComplete, true);
  assert.equal(edited.sendingEnabled, false);
  const legacy = await registry.save({
    id: settings.id,
    productIds: ['legacy-product'],
    priority: 5,
  });
  assert.equal(legacy.configurationComplete, true);
  assert.deepEqual(legacy.productIds, ['legacy-product']);
  assert.equal(legacy.priority, 5);
  const changedPassword = await registry.save({
    id: settings.id,
    clientPassword: 'replacement-synthetic-password',
  });
  assert.equal(changedPassword.verification.smtpVerified, false);
  await registry.verify(settings.id);
  const changedAccount = await registry.save({ id: settings.id, email: 'new@example.com' });
  assert.equal(changedAccount.credentialConfigured, false);
  assert.equal(changedAccount.configured, false);
  assert.equal(changedAccount.smtpStatus, 'not_configured');
  assert.equal(changedAccount.lastCheckedAt, null);
  assert.equal(changedAccount.verification.smtpVerified, false);
});

test('send fixes From, Reply-To and SMTP envelope and returns only sanitized SMTP result', async (t) => {
  const { registry, sent, transportOptions } = fixture(t);
  await registry.save({ ...settings, clientPassword: secret });
  await registry.verify(settings.id);
  const result = await registry.send(settings.id, mail);
  assert.deepEqual(result, { accepted: [mail.to], rejected: [], messageId: mail.messageId });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].from, { name: 'Example Sales', address });
  assert.equal(sent[0].replyTo, address);
  assert.deepEqual(sent[0].envelope, { from: address, to: [mail.to] });
  assert.equal(sent[0].bcc, undefined);
  assert.equal(sent[0].attachments, undefined);
  assert.equal(sent[0].disableFileAccess, true);
  for (const config of transportOptions) {
    assert.equal(config.host, smtp.host);
    assert.equal(config.port, 465);
    assert.equal(config.secure, true);
    assert.equal(config.auth.user, address);
    assert.equal(config.auth.pass, secret);
    assert.equal(config.logger, false);
    assert.equal(config.debug, false);
    assert.equal(config.tls.rejectUnauthorized, true);
  }
});

test('manual MIME sends preserve HTML, threading and Buffer attachments while rejecting sender/recipient overrides', async (t) => {
  const { registry, sent } = fixture(t);
  await registry.save({ ...settings, clientPassword: secret });
  await registry.verify(settings.id);
  const content = Buffer.from('%PDF-1.7\nSynthetic document');
  const attachment = {
    id: 'file-one',
    name: '产品资料.pdf',
    contentType: 'application/pdf',
    size: content.length,
    contentBase64: content.toString('base64'),
  };
  const reply = {
    ...mail,
    html: '<p>产品 <strong>information</strong></p>',
    inReplyTo: '<parent@buyer.example>',
    references: ['<root@buyer.example>'],
    attachments: [attachment],
  };
  await registry.send(settings.id, reply);
  assert.equal(sent[0].html, reply.html);
  assert.equal(sent[0].inReplyTo, reply.inReplyTo);
  assert.deepEqual(sent[0].references, ['<root@buyer.example>', '<parent@buyer.example>']);
  assert.deepEqual(sent[0].attachments[0].content, content);
  assert.equal(sent[0].attachments[0].filename, attachment.name);
  assert.equal(sent[0].attachments[0].path, undefined);
  for (const patch of [
    { from: 'attacker@example.org' },
    { replyTo: 'attacker@example.org' },
    { envelope: { from: 'attacker@example.org' } },
    { cc: 'other@example.org' },
    { bcc: 'other@example.org' },
    { raw: 'untrusted raw message' },
    { inReplyTo: '<parent@buyer.example>\r\nBcc: bad@example.org' },
    { references: ['not-a-message-id'] },
    { attachments: [{ ...attachment, path: '.env' }] },
    { attachments: [{ ...attachment, href: 'https://remote.example/file' }] },
    { attachments: [{ ...attachment, contentBase64: 'https://remote.example/file' }] },
    { attachments: [{ ...attachment, name: 'file.pdf\r\nBcc: bad@example.org' }] },
    { attachments: [{ ...attachment, contentType: 'application/pdf\r\nX-Extra: value' }] },
    { attachments: [{ ...attachment, size: 12345 }] },
    { attachments: Array.from({ length: 11 }, () => attachment) },
  ])
    await assert.rejects(registry.send(settings.id, { ...reply, ...patch }), {
      code: 'MAILBOX_INVALID',
    });
  assert.equal(sent.length, 1);
});

test('attachment decoded totals are capped at ten megabytes before SMTP', async (t) => {
  const { registry, sent } = fixture(t);
  await registry.save({ ...settings, clientPassword: secret });
  await registry.verify(settings.id);
  const content = Buffer.alloc(6 * 1024 * 1024, 65);
  const attachment = {
    name: 'business.bin',
    contentType: 'application/octet-stream',
    size: content.length,
    contentBase64: content.toString('base64'),
  };
  await assert.rejects(
    registry.send(settings.id, { ...mail, attachments: [attachment, attachment] }),
    { code: 'MAILBOX_INVALID' },
  );
  assert.equal(sent.length, 0);
});

function sentImap({ existing = false, missingFolder = false, appendError = false } = {}) {
  const calls = [],
    configurations = [];
  let saved = existing;
  return {
    calls,
    configurations,
    factory: (config) => {
      configurations.push(config);
      return {
        connect: async () => calls.push('connect'),
        list: async () => (missingFolder ? [] : [{ path: 'Sent Items', specialUse: '\\Sent' }]),
        getMailboxLock: async (path, options) => {
          calls.push(['lock', path, options]);
          return { release: () => calls.push('release') };
        },
        search: async (query, options) => {
          calls.push(['search', query, options]);
          return saved ? [7] : [];
        },
        append: async (path, raw, flags, date) => {
          calls.push(['append', path, raw, flags, date]);
          saved = true;
          if (appendError) throw new Error(secret + ' APPEND response lost');
          return { uid: 7 };
        },
        logout: async () => calls.push('logout'),
        close: () => calls.push('close'),
      };
    },
  };
}

test('saving Sent builds the same fixed identity/thread/MIME after SMTP and appends a Seen copy only once', async (t) => {
  const imap = sentImap();
  const { registry, sent } = fixture(t, { imapFactory: imap.factory });
  await registry.save({ ...settings, clientPassword: secret });
  await registry.verify(settings.id);
  const content = Buffer.from('approved document');
  const message = {
    ...mail,
    html: '<p>Manual reply</p>',
    inReplyTo: '<parent@buyer.example>',
    references: ['<root@buyer.example>'],
    attachments: [
      {
        name: 'terms.txt',
        contentType: 'text/plain',
        size: content.length,
        contentBase64: content.toString('base64'),
      },
    ],
    sentAt: '2026-10-27T06:00:00Z',
  };
  assert.deepEqual((await registry.send(settings.id, message)).accepted, [mail.to]);
  await registry.save({ id: settings.id, paused: true });
  const first = await registry.saveSent(settings.id, message);
  assert.equal(first.saved, true);
  assert.equal(first.alreadyPresent, false);
  const appended = imap.calls.find((call) => call[0] === 'append');
  assert.equal(appended[1], 'Sent Items');
  assert.deepEqual(appended[3], ['\\Seen']);
  const parsed = await simpleParser(appended[2]);
  assert.equal(parsed.messageId, mail.messageId);
  assert.equal(parsed.from.value[0].address, address);
  assert.equal(parsed.replyTo.value[0].address, address);
  assert.equal(parsed.to.value[0].address, mail.to);
  assert.equal(parsed.subject, mail.subject);
  assert.equal(parsed.text.trim(), mail.text);
  assert.equal(parsed.html, message.html);
  assert.equal(parsed.inReplyTo, message.inReplyTo);
  assert.deepEqual(parsed.references, ['<root@buyer.example>', '<parent@buyer.example>']);
  assert.deepEqual(parsed.attachments[0].content, content);
  assert.deepEqual(imap.calls.find((call) => call[0] === 'lock')[2], { readOnly: true });
  assert.deepEqual(imap.calls.find((call) => call[0] === 'search')[1], {
    header: { 'message-id': mail.messageId },
  });
  const second = await registry.saveSent(settings.id, message);
  assert.equal(second.alreadyPresent, true);
  assert.equal(imap.calls.filter((call) => call[0] === 'append').length, 1);
  assert.equal(sent.length, 1);
  assert.equal(imap.configurations[0].host, 'imap.qiye.aliyun.com');
  assert.equal(imap.configurations[0].logger, false);
  assert.equal(imap.configurations[0].tls.rejectUnauthorized, true);
});

test('an unknown APPEND outcome is safe to retry by Message-ID and never repeats SMTP', async (t) => {
  const imap = sentImap({ appendError: true });
  const { registry, sent } = fixture(t, { imapFactory: imap.factory });
  await registry.save({ ...settings, clientPassword: secret });
  await registry.verify(settings.id);
  await registry.send(settings.id, mail);
  await assert.rejects(
    registry.saveSent(settings.id, mail),
    (error) => error.code === 'MAILBOX_SENT_SAVE_FAILED' && !String(error).includes(secret),
  );
  assert.equal(imap.calls.at(-1), 'logout');
  assert.ok(imap.calls.includes('release'));
  assert.equal((await registry.saveSent(settings.id, mail)).alreadyPresent, true);
  assert.equal(imap.calls.filter((call) => call[0] === 'append').length, 1);
  assert.equal(sent.length, 1);
});

test('an unavailable Sent folder fails without creating folders, appending, or sending', async (t) => {
  const imap = sentImap({ missingFolder: true });
  const { registry, sent } = fixture(t, { imapFactory: imap.factory });
  await registry.save({ ...settings, clientPassword: secret });
  await assert.rejects(registry.saveSent(settings.id, mail), { code: 'MAILBOX_SENT_SAVE_FAILED' });
  assert.equal(
    imap.calls.some((call) => call[0] === 'append'),
    false,
  );
  assert.equal(imap.calls.at(-1), 'logout');
  assert.equal(sent.length, 0);
});

test('manual send and Sent-copy reject a changed expected mailbox identity before any transport access', async (t) => {
  const imap = sentImap();
  const { registry, sent, transportOptions } = fixture(t, { imapFactory: imap.factory });
  await registry.save({ ...settings, clientPassword: secret });
  await registry.verify(settings.id);
  await assert.rejects(
    registry.send(settings.id, { ...mail, expectedAccount: 'different@brand.example' }),
    { code: 'MAILBOX_IDENTITY_CHANGED', status: 409 },
  );
  await assert.rejects(
    registry.saveSent(settings.id, { ...mail, expectedAccount: 'different@brand.example' }),
    { code: 'MAILBOX_IDENTITY_CHANGED', status: 409 },
  );
  assert.equal(sent.length, 0);
  assert.equal(transportOptions.length, 1);
  assert.equal(imap.calls.length, 0);
  assert.deepEqual(
    (await registry.send(settings.id, { ...mail, expectedAccount: address.toUpperCase() }))
      .accepted,
    [mail.to],
  );
  await registry.save({ id: settings.id, email: 'replacement@brand.example' });
  await assert.rejects(registry.send(settings.id, { ...mail, expectedAccount: address }), {
    code: 'MAILBOX_IDENTITY_CHANGED',
    status: 409,
  });
  await assert.rejects(registry.saveSent(settings.id, { ...mail, expectedAccount: address }), {
    code: 'MAILBOX_IDENTITY_CHANGED',
    status: 409,
  });
});

test('unverified, paused, malformed and credentialless sends never reach SMTP', async (t) => {
  const { registry, sent } = fixture(t);
  await registry.save(settings);
  await assert.rejects(registry.send(settings.id, mail), { code: 'MAILBOX_NOT_CONFIGURED' });
  await registry.save({ id: settings.id, clientPassword: secret });
  await assert.rejects(registry.send(settings.id, mail), { code: 'MAILBOX_NOT_VERIFIED' });
  await registry.verify(settings.id);
  await assert.rejects(
    registry.send(settings.id, { ...mail, to: 'buyer@example.org,other@example.org' }),
    { code: 'MAILBOX_INVALID' },
  );
  await assert.rejects(
    registry.send(settings.id, { ...mail, subject: 'hello\r\nBcc: other@example.org' }),
    { code: 'MAILBOX_INVALID' },
  );
  await registry.save({ id: settings.id, paused: true });
  await assert.rejects(registry.send(settings.id, mail), { code: 'MAILBOX_PAUSED' });
  assert.equal(sent.length, 0);
});

test('provider and credential failures are sanitized and failed verification revokes readiness', async (t) => {
  let throws = false;
  const { registry, path } = fixture(t, {
    transportFactory: () => ({
      verify: async () => {
        if (throws) throw new Error('auth failed: ' + secret);
        return true;
      },
      sendMail: async () => {
        throw new Error('smtp failed: ' + secret);
      },
    }),
  });
  await registry.save({ ...settings, clientPassword: secret });
  await registry.verify(settings.id);
  await assert.rejects(
    registry.send(settings.id, mail),
    (error) => error.code === 'MAILBOX_SEND_FAILED' && !String(error).includes(secret),
  );
  throws = true;
  await assert.rejects(
    registry.verify(settings.id),
    (error) => error.code === 'MAILBOX_VERIFY_FAILED' && !String(error).includes(secret),
  );
  assert.equal(registry.get(settings.id).verification.smtpVerified, false);
  assert.equal(registry.get(settings.id).smtpStatus, 'error');
  assert.ok(registry.get(settings.id).lastCheckedAt);
  assert.equal(registry.get(settings.id).lastError, '邮箱连接验证失败，请检查账号和客户端密码');
  assert.equal(readFileSync(path, 'utf8').includes(secret), false);
  registry.unprotect = async () => {
    throw new Error('decryption error: ' + secret);
  };
  await assert.rejects(
    registry.verify(settings.id),
    (error) => error.code === 'MAILBOX_CREDENTIAL_FAILED' && !String(error).includes(secret),
  );
});

test('native credential protection round trips synthetic credentials without writing plaintext', async (t) => {
  const { registry, path, directory, config, transportOptions } = fixture(t, {
    protect: undefined,
    unprotect: undefined,
  });
  await registry.save({ ...settings, clientPassword: secret });
  await registry.verify(settings.id);
  assert.equal(transportOptions[0].auth.pass, secret);
  assert.equal(readFileSync(path, 'utf8').includes(secret), false);
  const restarted = new OutreachMailboxes(config);
  await restarted.verify(settings.id);
  if (process.platform === 'win32') {
    assert.match(
      JSON.parse(readFileSync(path, 'utf8')).mailboxes[0].credential,
      /^01000000d08c9ddf/iu,
    );
  } else {
    assert.equal(statSync(join(directory, '.credential-key')).mode & 0o777, 0o600);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test('read-only mailbox access reuses protected credentials independently of sending pause and SMTP verification', async (t) => {
  const calls = [];
  const result = { folders: [], hasMore: false, folderCoverage: { inbox: true, sent: false } };
  const { registry, sent } = fixture(t, {
    mailboxReaderFactory: (config) => {
      calls.push(config);
      return {
        read: async (options) => {
          calls.push(options);
          return result;
        },
      };
    },
  });
  await registry.save({ ...settings, paused: true, clientPassword: secret });
  assert.equal(registry.get(settings.id).smtpStatus, 'not_checked');
  const options = { cursors: {}, since: '2026-09-27T00:00:00.000Z' };
  assert.deepEqual(await registry.readMailbox(settings.id, options), result);
  assert.deepEqual(calls, [{ account: address, clientPassword: secret }, options]);
  assert.equal(registry.get(settings.id).paused, true);
  assert.equal(registry.get(settings.id).smtpStatus, 'not_checked');
  assert.equal(sent.length, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('read-only access rejects missing credentials and hides reader/decryption provider errors', async (t) => {
  const { registry } = fixture(t, {
    mailboxReaderFactory: () => {
      throw new Error(secret);
    },
  });
  await registry.save(settings);
  await assert.rejects(registry.readMailbox(settings.id), { code: 'MAILBOX_NOT_CONFIGURED' });
  await registry.save({ id: settings.id, clientPassword: secret });
  await assert.rejects(
    registry.readMailbox(settings.id),
    (error) => error.code === 'MAILBOX_READ_FAILED' && !String(error).includes(secret),
  );
  registry.unprotect = async () => {
    throw new Error(secret);
  };
  await assert.rejects(
    registry.readMailbox(settings.id),
    (error) => error.code === 'MAILBOX_CREDENTIAL_FAILED' && !String(error).includes(secret),
  );
});
