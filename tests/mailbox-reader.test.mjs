import assert from 'node:assert/strict';
import test from 'node:test';
import { createMailboxReader, MailboxReadError } from '../server/mailbox-reader.mjs';
import imapParser from 'imapflow/lib/handler/imap-parser.js';
import { formatMessageResponse } from 'imapflow/lib/tools.js';
import fetchCommand from 'imapflow/lib/commands/fetch.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { MailConversations } from '../server/mail-conversations.mjs';

const account = 'Sales@example.com',
  password = 'synthetic-reader-secret';
const since = '2026-09-27T00:00:00.000Z';
const receivedAt = '2026-10-27T00:00:00.000Z';
function row(uid = 1, options = {}) {
  const body = options.body ?? 'Hello from the customer.';
  return {
    uid,
    flags: new Set(options.seen ? ['\\Seen'] : []),
    internalDate: new Date(options.internalDate || receivedAt),
    headers: Buffer.from(
      [
        `From: ${options.from || 'Buyer <buyer@customer.example>'}`,
        `To: ${options.to || account}`,
        ...(options.cc ? [`Cc: ${options.cc}`] : []),
        ...(options.replyTo ? [`Reply-To: ${options.replyTo}`] : []),
        `Subject: ${options.subject || 'Product enquiry'}`,
        `Message-ID: ${options.messageId || `<message-${uid}@customer.example>`}`,
        ...(options.inReplyTo ? [`In-Reply-To: ${options.inReplyTo}`] : []),
        ...(options.references ? [`References: ${options.references}`] : []),
        ...(options.headers || []),
        '',
        '',
      ].join('\r\n'),
    ),
    bodyStructure: options.structure || {
      part: '1',
      type: 'text/plain',
      parameters: { charset: 'utf-8' },
      encoding: '8bit',
      size: Buffer.byteLength(body),
    },
    body,
    parts: options.parts,
  };
}
function fixture({
  inbox = [row()],
  sent = [],
  sentFolder = true,
  validity = '91',
  failFolder,
  fetchError,
  connectError,
  found,
} = {}) {
  const calls = [],
    configurations = [];
  const rows = new Map([
    ['INBOX', inbox],
    ['Sent Items', sent],
  ]);
  let selected;
  const client = {
    async connect() {
      calls.push('connect');
      if (connectError) throw connectError;
    },
    async list() {
      return [
        { path: 'INBOX', specialUse: '\\Inbox' },
        ...(sentFolder ? [{ path: 'Sent Items', specialUse: '\\Sent' }] : []),
      ];
    },
    async getMailboxLock(path, options) {
      calls.push(['lock', path, options]);
      if (path === failFolder) throw new Error(password + ': provider folder unavailable');
      selected = path;
      const messages = rows.get(path) || [];
      this.mailbox = { uidValidity: BigInt(validity), uidNext: (messages.at(-1)?.uid || 0) + 1 };
      return {
        release() {
          calls.push(['release', path]);
        },
      };
    },
    async search(query, options) {
      calls.push(['search', selected, query, options]);
      return found || (rows.get(selected) || []).map((message) => message.uid);
    },
    async fetchOne(uid, query, options) {
      calls.push(['fetch', selected, uid, query, options]);
      if (fetchError) throw fetchError;
      const message = (rows.get(selected) || []).find((item) => item.uid === uid);
      if (!message) return false;
      if (query.bodyParts)
        return {
          uid,
          bodyParts: new Map(
            query.bodyParts.map(({ key }) => [
              key.toLowerCase(),
              Buffer.from(message.parts?.[key] ?? message.body),
            ]),
          ),
        };
      const { body, ...metadata } = message;
      return metadata;
    },
    async logout() {
      calls.push('logout');
    },
    close() {
      calls.push('close');
    },
  };
  return {
    calls,
    configurations,
    client,
    reader: createMailboxReader({
      account,
      clientPassword: password,
      imapFactory: (config) => {
        configurations.push(config);
        return client;
      },
    }),
  };
}

test('reads inbox and provider sent folder without flag changes or attachment downloads', async () => {
  const inbound = row(1, {
    cc: 'Office <office@customer.example>',
    inReplyTo: '<outreach@example.com>',
    references: '<outreach@example.com> <older@example.com>',
  });
  const sent = row(2, { from: account, to: 'buyer@customer.example', seen: true });
  const { reader, calls, configurations } = fixture({ inbox: [inbound], sent: [sent] });
  const result = await reader.read({ since });
  assert.deepEqual(result.folderCoverage, { inbox: true, sent: true });
  assert.equal(result.hasMore, false);
  assert.deepEqual(
    result.folders.map((folder) => [folder.path, folder.uidValidity, folder.nextUid]),
    [
      ['INBOX', '91', 2],
      ['Sent Items', '91', 3],
    ],
  );
  const message = result.folders[0].messages[0];
  assert.equal(message.from, 'buyer@customer.example');
  assert.equal(message.to, 'sales@example.com, office@customer.example');
  assert.equal(message.direction, 'inbound');
  assert.equal(message.bodyText, 'Hello from the customer.');
  assert.equal(message.inReplyTo, '<outreach@example.com>');
  assert.deepEqual(message.references, ['<outreach@example.com>', '<older@example.com>']);
  assert.equal(message.unread, true);
  assert.equal(message.occurredAt, receivedAt);
  assert.equal(result.folders[1].messages[0].direction, 'outbound');
  assert.equal(result.folders[1].messages[0].unread, false);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'lock').map((call) => call[2]),
    [{ readOnly: true }, { readOnly: true }],
  );
  assert.equal(calls.filter((call) => call[0] === 'release').length, 2);
  assert.equal(calls.at(-1), 'logout');
  assert.equal(configurations[0].host, 'imap.qiye.aliyun.com');
  assert.equal(configurations[0].port, 993);
  assert.equal(configurations[0].secure, true);
  assert.equal(configurations[0].auth.user, account);
  assert.equal(configurations[0].auth.pass, password);
  assert.equal(configurations[0].logger, false);
  assert.equal(configurations[0].tls.rejectUnauthorized, true);
  for (const call of calls.filter((call) => call[0] === 'fetch')) {
    assert.equal(call[3].source, undefined);
    assert.equal(call[4].uid, true);
  }
  assert.equal(JSON.stringify(result).includes(password), false);
});

test('automatic replies retain reliable headers as a classification without guessing from the subject', async () => {
  const inbox = [
    row(1, { headers: ['Auto-Submitted: auto-replied'] }),
    row(2, { headers: ['Auto-Submitted: auto-generated; owner-email="owner@example.com"'] }),
    row(3, { headers: ['Auto-Submitted: no'] }),
    row(4, { headers: ['X-Autoreply: yes'] }),
    row(5, { headers: ['X-Autorespond: TRUE'] }),
    row(6, { subject: 'Automatic reply: Thank you for contacting us' }),
    row(7, { headers: ['X-Autoreply: no', 'X-Autorespond: false'] }),
    row(8, { headers: ['Auto-Submitted: no', 'Auto-Submitted: auto-replied'] }),
  ];
  const { reader, calls } = fixture({ inbox, sentFolder: false });
  const result = await reader.read({ since });
  assert.deepEqual(
    result.folders[0].messages.map((message) => message.classification),
    [
      'auto_reply',
      'auto_reply',
      'normal',
      'auto_reply',
      'auto_reply',
      'normal',
      'normal',
      'auto_reply',
    ],
  );
  for (const call of calls.filter((call) => call[0] === 'fetch' && call[3].headers)) {
    for (const name of ['auto-submitted', 'x-autoreply', 'x-autorespond'])
      assert.ok(call[3].headers.includes(name), `IMAP must request ${name}`);
  }
});

test('initial sync is recent-only, UID sorted and bounded; pagination leaves a resumable cursor', async () => {
  const inbox = Array.from({ length: 52 }, (_, index) => row(index + 1));
  const { reader, calls } = fixture({
    inbox,
    sentFolder: false,
    found: inbox.map((item) => item.uid).reverse(),
  });
  const first = await reader.read({ since });
  assert.deepEqual(first.folderCoverage, { inbox: true, sent: false });
  assert.equal(first.folders[0].messages.length, 50);
  assert.equal(first.folders[0].messages[0].uid, 1);
  assert.equal(first.folders[0].nextUid, 51);
  assert.equal(first.hasMore, true);
  assert.deepEqual(calls.find((call) => call[0] === 'search')[2], { since: new Date(since) });
  const second = await reader.read({
    since,
    cursors: { INBOX: { uidValidity: '91', nextUid: 51 } },
  });
  assert.deepEqual(
    second.folders[0].messages.map((message) => message.uid),
    [51, 52],
  );
  assert.equal(second.folders[0].nextUid, 53);
  assert.equal(second.hasMore, false);
  assert.deepEqual(calls.filter((call) => call[0] === 'search').at(-1)[2], { uid: '51:*' });
});

test('UIDVALIDITY change rereads the recent window and reports reset instead of using the old UID', async () => {
  const { reader, calls } = fixture({ sentFolder: false });
  const result = await reader.read({
    since,
    cursors: { INBOX: { uidValidity: '90', nextUid: 5000 } },
  });
  assert.equal(result.folders[0].reset, true);
  assert.equal(result.folders[0].messages.length, 1);
  assert.deepEqual(calls.find((call) => call[0] === 'search')[2], { since: new Date(since) });
});

test('HTML is returned as plain text and only the text body part is requested', async () => {
  const structure = {
    type: 'multipart/mixed',
    childNodes: [
      {
        part: '1',
        type: 'text/html',
        size: 300,
        parameters: { charset: 'utf-8' },
        encoding: '8bit',
      },
      {
        part: '2',
        type: 'application/pdf',
        size: 7000000,
        disposition: 'attachment',
        dispositionParameters: { filename: 'drawing.pdf' },
      },
    ],
  };
  const { reader, calls } = fixture({
    inbox: [
      row(1, {
        body: '<p>Need <b>samples</b></p><img src="https://tracker.example/pixel">',
        structure,
      }),
    ],
    sentFolder: false,
  });
  const message = (await reader.read({ since })).folders[0].messages[0];
  assert.match(message.bodyText, /Need samples/u);
  assert.doesNotMatch(message.bodyText, /<p>|<img/u);
  assert.deepEqual(message.attachments, [
    { name: 'drawing.pdf', contentType: 'application/pdf', size: 7000000 },
  ]);
  assert.deepEqual(
    calls
      .filter((call) => call[0] === 'fetch' && call[3].bodyParts)
      .flatMap((call) => call[3].bodyParts.map((part) => part.key)),
    ['1'],
  );
});

test('oversized bodies remain visible as metadata and invalid senders cannot poison threads or stall the cursor', async () => {
  const inbox = [
    row(1, { structure: { part: '1', type: 'text/plain', size: 2 * 1024 * 1024 } }),
    row(2, { from: 'invalid-address' }),
    row(3, { internalDate: '2026-01-01T00:00:00Z' }),
    row(4),
  ];
  const { reader, calls } = fixture({ inbox, sentFolder: false });
  const folder = (await reader.read({ since })).folders[0];
  assert.deepEqual(
    folder.messages.map((message) => message.uid),
    [1, 4],
  );
  assert.equal(folder.messages[0].bodyUnavailable, 'too_large');
  assert.equal(folder.messages[0].bodyText, '');
  assert.equal(folder.skipped, 2);
  assert.equal(folder.nextUid, 5);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'fetch' && call[3].bodyParts).map((call) => call[2]),
    [4],
  );
});

test('a partial folder failure returns no cursors and releases all acquired locks and the connection', async () => {
  const { reader, calls } = fixture({ failFolder: 'Sent Items' });
  await assert.rejects(
    reader.read({ since }),
    (error) =>
      error instanceof MailboxReadError &&
      error.code === 'MAILBOX_READ_FAILED' &&
      !String(error).includes(password),
  );
  assert.ok(calls.some((call) => call[0] === 'release' && call[1] === 'INBOX'));
  assert.equal(calls.at(-1), 'logout');
});

test('fetch failures and authentication errors are sanitized and close the connection', async () => {
  const failing = fixture({ fetchError: new Error('provider echoed ' + password) });
  await assert.rejects(
    failing.reader.read({ since }),
    (error) => error.code === 'MAILBOX_READ_FAILED' && !String(error).includes(password),
  );
  assert.ok(failing.calls.some((call) => call[0] === 'release'));
  assert.equal(failing.calls.at(-1), 'logout');
  const authentication = fixture({
    connectError: Object.assign(new Error(password), { code: 'EAUTH' }),
  });
  await assert.rejects(
    authentication.reader.read({ since }),
    (error) => error.code === 'MAILBOX_READ_AUTH_FAILED' && !String(error).includes(password),
  );
  assert.equal(authentication.calls.at(-1), 'close');
});

test('an operation timeout closes the transport and rejects without provider details', async () => {
  let closed = false;
  const reader = createMailboxReader({
    account,
    clientPassword: password,
    timeoutMs: 10,
    imapFactory: () => ({
      connect: () => new Promise(() => {}),
      close: () => {
        closed = true;
      },
    }),
  });
  await assert.rejects(reader.read({ since }), { code: 'MAILBOX_READ_FAILED' });
  assert.equal(closed, true);
});

test('invalid cursors fail safely and message IDs and addresses remain normalized', async () => {
  const { reader, calls } = fixture({
    sentFolder: false,
    inbox: [row(1, { messageId: 'invalid', cc: 'bad-address' })],
  });
  await assert.rejects(
    reader.read({ since, cursors: { INBOX: { uidValidity: '91', nextUid: -1 } } }),
    { code: 'MAILBOX_READ_INVALID' },
  );
  assert.equal(calls.at(-1), 'logout');
  const message = (await reader.read({ since })).folders[0].messages[0];
  assert.equal(message.messageId, null);
  assert.equal(message.to, 'sales@example.com');
  assert.deepEqual(message.cc, []);
});

test('real ImapFlow single-part structures and lowercase TEXT sections are read for plain and HTML bodies', async () => {
  for (const [subtype, body, expected] of [
    ['PLAIN', 'Hello', 'Hello'],
    ['HTML', '<p>Hello</p>', 'Hello'],
  ]) {
    const parsedStructure = await formatMessageResponse(
      await imapParser(
        `* 1 FETCH (BODYSTRUCTURE ("TEXT" "${subtype}" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${Buffer.byteLength(body)} 1))`,
      ),
      { uidNext: 2, path: 'INBOX' },
    );
    assert.equal(parsedStructure.bodyStructure.part, undefined);
    const parsedBody = await formatMessageResponse(
      await imapParser(`* 1 FETCH (UID 1 BODY[TEXT]<0> {${Buffer.byteLength(body)}}\r\n${body})`),
      { uidNext: 2, path: 'INBOX' },
    );
    assert.ok(parsedBody.bodyParts.has('text'));
    const h = fixture({
      inbox: [row(1, { structure: parsedStructure.bodyStructure, body })],
      sentFolder: false,
    });
    const fetch = h.client.fetchOne.bind(h.client);
    h.client.fetchOne = async (id, query, options) =>
      query.bodyParts ? parsedBody : fetch(id, query, options);
    const message = (await h.reader.read({ since })).folders[0].messages[0];
    assert.equal(message.bodyText.trim(), expected);
    assert.deepEqual(
      h.calls.filter((call) => call[0] === 'fetch').map((call) => call[3].source),
      [undefined],
    );
  }
});

test('the installed ImapFlow fetch command emits bounded BODY.PEEK with TEXT and numeric part sections', async () => {
  const commands = [];
  const connection = {
    state: 3,
    states: { SELECTED: 3 },
    mailbox: { path: 'INBOX', uidNext: 2 },
    capabilities: new Set(),
    enabled: new Set(),
    exec: async (command, attributes) => {
      commands.push({ command, attributes });
      return { next() {} };
    },
  };
  await fetchCommand(
    connection,
    1,
    {
      bodyParts: [
        { key: 'TEXT', start: 0, maxLength: 1048577 },
        { key: '1.2', start: 0, maxLength: 1048577 },
      ],
    },
    { uid: true },
  );
  assert.equal(commands[0].command, 'UID FETCH');
  const atoms = commands[0].attributes[1];
  assert.deepEqual(
    atoms
      .filter((item) => item.value === 'BODY.PEEK')
      .map((item) => ({ section: item.section[0].value, partial: item.partial })),
    [
      { section: 'TEXT', partial: [0, 1048577] },
      { section: '1.2', partial: [0, 1048577] },
    ],
  );
  assert.equal(
    atoms.some((item) => /^(?:BODY|BINARY)$/u.test(item.value)),
    false,
  );
});

test('a timed-out fetch releases an acquired read-only lock before returning', async () => {
  const h = fixture({ sentFolder: false });
  h.client.fetchOne = () => new Promise(() => {});
  const reader = createMailboxReader({
    account,
    clientPassword: password,
    timeoutMs: 10,
    imapFactory: () => h.client,
  });
  await assert.rejects(reader.read({ since }), { code: 'MAILBOX_READ_FAILED' });
  assert.equal(h.calls.filter((call) => call[0] === 'release').length, 1);
  assert.equal(h.calls.at(-1), 'logout');
});

test('Bcc delivery and undisclosed recipients retain the real message without inventing address headers', async () => {
  const h = fixture({ inbox: [row(1, { to: 'undisclosed-recipients:;' })], sentFolder: false });
  const folder = (await h.reader.read({ since })).folders[0];
  assert.equal(folder.messages.length, 1);
  assert.equal(folder.messages[0].from, 'buyer@customer.example');
  assert.equal(folder.messages[0].to, '（收件人未披露）');
  assert.equal(folder.nextUid, 2);
  assert.equal(folder.skipped, 0);
});

test('the actual credential registry, reader and SQLite conversation store join and deduplicate a first-touch reply', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mailbox-reader-store-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = fixture({ inbox: [row(1, { inReplyTo: '<first@example.com>' })], sentFolder: false });
  const registry = new OutreachMailboxes({
    path: join(directory, 'mailboxes.json'),
    seedPath: null,
    protect: async () => ({
      credentialProtection: 'windows-dpapi-current-user',
      credential: 'encrypted-test-secret',
    }),
    unprotect: async () => password,
    mailboxReaderFactory: (config) =>
      createMailboxReader({ ...config, imapFactory: () => h.client }),
    transportFactory: () => {
      throw new Error('Read-only integration must never open SMTP');
    },
  });
  await registry.save({ id: 'one', email: account, paused: true, clientPassword: password });
  const db = new DatabaseSync(':memory:');
  const store = new MailConversations({
    db,
    mailboxes: registry,
    now: () => Date.parse(receivedAt),
    deliveries: () => [
      {
        id: 'outreach-one',
        mailboxId: 'one',
        from: account,
        to: 'buyer@customer.example',
        status: 'accepted',
        messageId: '<first@example.com>',
        subject: 'Company introduction',
        bodyText: 'Approved introduction.',
        sentAt: '2026-10-26T00:00:00Z',
        customerId: 'customer-one',
        companyName: 'Buyer Company',
      },
    ],
  });
  t.after(async () => {
    await store.close();
    db.close();
  });
  const original = store.list().items[0];
  assert.equal((await store.sync({ mailboxId: 'one' })).imported, 1);
  const list = store.list();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].id, original.id);
  assert.equal(list.items[0].customerId, 'customer-one');
  assert.equal(list.items[0].messageCount, 2);
  assert.equal(store.detail(original.id).messages.at(-1).bodyText, 'Hello from the customer.');
  assert.equal((await store.sync({ mailboxId: 'one' })).imported, 0);
  assert.equal(store.detail(original.id).messages.length, 2);
});

test('multipart alternatives preserve both decoded bodies, original header roles and source location', async () => {
  const plain = '=E6=82=A8=E5=A5=BD=20business=20contact';
  const html =
    '<html><body><table><tr><td>您好 <a href="https://business.example/catalog">catalogue</a></td></tr></table></body></html>';
  const encodedHtml = Buffer.from(html).toString('base64');
  const structure = {
    type: 'multipart/alternative',
    childNodes: [
      {
        part: '1',
        type: 'text/plain',
        parameters: { charset: 'UTF-8' },
        encoding: 'quoted-printable',
        size: Buffer.byteLength(plain),
      },
      {
        part: '2',
        type: 'text/html',
        parameters: { charset: 'UTF-8' },
        encoding: 'base64',
        size: Buffer.byteLength(encodedHtml),
      },
    ],
  };
  const h = fixture({
    inbox: [
      row(1, {
        structure,
        parts: { 1: plain, 2: encodedHtml },
        to: 'Sales <Sales@example.com>',
        cc: 'Office <office@customer.example>',
        replyTo: 'Replies <replies@customer.example>',
      }),
    ],
    sentFolder: false,
  });
  const message = (await h.reader.read({ since })).folders[0].messages[0];
  assert.equal(message.bodyText, '您好 business contact');
  assert.equal(message.bodyHtml, html);
  assert.equal(message.bodyFormatVersion, 2);
  assert.equal(message.fromName, 'Buyer');
  assert.deepEqual(message.toAddresses, ['sales@example.com']);
  assert.deepEqual(message.cc, ['office@customer.example']);
  assert.deepEqual(message.replyTo, ['replies@customer.example']);
  assert.deepEqual(message.sourceLocator, { folder: 'INBOX', uid: 1, uidValidity: '91' });
  assert.deepEqual(
    h.calls
      .filter((call) => call[0] === 'fetch' && call[3].bodyParts)
      .flatMap((call) => call[3].bodyParts.map((part) => part.key)),
    ['1', '2'],
  );
});

test('CID reads only referenced supported image parts, validates signatures and never fetches ordinary attachments', async () => {
  const png = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from('synthetic-image'),
  ]);
  const bodyHtml =
    '<p>Brand</p><img src="cid:logo@brand"><img src="cid:unsafe@brand"><img src="cid:fake@brand">';
  const structure = {
    type: 'multipart/related',
    childNodes: [
      {
        part: '1',
        type: 'text/html',
        parameters: { charset: 'utf-8' },
        encoding: '8bit',
        size: Buffer.byteLength(bodyHtml),
      },
      {
        part: '2',
        type: 'image/png',
        id: '<logo@brand>',
        disposition: 'inline',
        encoding: 'base64',
        size: png.toString('base64').length,
      },
      {
        part: '3',
        type: 'image/svg+xml',
        id: '<unsafe@brand>',
        disposition: 'inline',
        encoding: '8bit',
        size: 100,
      },
      {
        part: '4',
        type: 'application/pdf',
        disposition: 'attachment',
        dispositionParameters: { filename: 'catalogue.pdf' },
        size: 1000,
      },
      {
        part: '5',
        type: 'image/png',
        id: '<unreferenced@brand>',
        disposition: 'inline',
        encoding: 'base64',
        size: png.toString('base64').length,
      },
      {
        part: '6',
        type: 'image/png',
        id: '<fake@brand>',
        disposition: 'inline',
        encoding: '8bit',
        size: 19,
      },
    ],
  };
  const h = fixture({
    inbox: [
      row(1, {
        structure,
        parts: { 1: bodyHtml, 2: png.toString('base64'), 6: '<script>bad</script>' },
      }),
    ],
    sentFolder: false,
  });
  const message = (await h.reader.read({ since })).folders[0].messages[0];
  assert.equal(message.bodyHtml, bodyHtml);
  assert.deepEqual(message.inlineImages, [
    { cid: 'logo@brand', contentType: 'image/png', contentBase64: png.toString('base64') },
  ]);
  assert.deepEqual(message.attachments, [
    { name: 'catalogue.pdf', contentType: 'application/pdf', size: 1000 },
  ]);
  assert.deepEqual(
    h.calls
      .filter((call) => call[0] === 'fetch' && call[3].bodyParts)
      .flatMap((call) => call[3].bodyParts.map((part) => part.key)),
    ['1', '2', '6'],
  );
});

test('CID image limits use decoded bytes and cap total inline data at two megabytes', async () => {
  const png = Buffer.alloc(512 * 1024, 65);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(png);
  const encoded = png.toString('base64'),
    tooBig = Buffer.concat([png, Buffer.from('A')]).toString('base64');
  const html = Array.from({ length: 6 }, (_, index) => `<img src="cid:logo${index}@brand">`).join(
    '',
  );
  const children = Array.from({ length: 6 }, (_, index) => ({
    part: String(index + 2),
    type: 'image/png',
    id: `<logo${index}@brand>`,
    disposition: 'inline',
    encoding: 'base64',
    size: index === 0 ? tooBig.length : encoded.length,
  }));
  const structure = {
    type: 'multipart/related',
    childNodes: [
      { part: '1', type: 'text/html', size: Buffer.byteLength(html), encoding: '8bit' },
      ...children,
    ],
  };
  const h = fixture({
    sentFolder: false,
    inbox: [
      row(1, {
        structure,
        parts: { 1: html, 2: tooBig, 3: encoded, 4: encoded, 5: encoded, 6: encoded, 7: encoded },
      }),
    ],
  });
  const message = (await h.reader.read({ since })).folders[0].messages[0];
  assert.equal(message.inlineImages.length, 4);
  assert.equal(
    message.inlineImages.reduce(
      (sum, image) => sum + Buffer.from(image.contentBase64, 'base64').length,
      0,
    ),
    2 * 1024 * 1024,
  );
  assert.equal(
    h.calls.some(
      (call) => call[0] === 'fetch' && call[3].bodyParts?.some((part) => part.key === '7'),
    ),
    false,
  );
});
