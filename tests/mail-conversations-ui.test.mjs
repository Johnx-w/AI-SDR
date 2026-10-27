import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createModuleLoader } from './helpers/modules.mjs';

const requests = [];
const loadModule = createModuleLoader((specifier) =>
  specifier === '../outreachApi'
    ? {
        outreachApi: async (path, init = {}) => {
          requests.push({ path, init });
          return {};
        },
      }
    : undefined,
);
const { mailConversationsApi } = loadModule(
  new URL('../src/services/mailConversations.ts', import.meta.url),
);
const { MailConversations, MailConversationTimeline, MailSyncSummary } = loadModule(
  new URL('../src/components/MailConversations.tsx', import.meta.url),
);
const {
  mailFramePolicy,
  inlineImageSource,
  safeMailLink,
  validateMailAttachments,
  replyRecipient,
} = loadModule(new URL('../src/services/mailHtml.ts', import.meta.url));
const { MailMessageBody } = loadModule(
  new URL('../src/components/MailMessageBody.tsx', import.meta.url),
);
const { MailReplyResult } = loadModule(
  new URL('../src/components/MailReplyComposer.tsx', import.meta.url),
);
const render = (component, props) =>
  renderToStaticMarkup(
    React.createElement(MemoryRouter, null, React.createElement(component, props)),
  );
const conversation = {
  id: 'thread-1',
  mailboxId: 'mailbox-1',
  account: 'sales@our.example',
  participant: 'buyer@customer.example',
  subject: 'Product enquiry',
  companyName: 'Buyer Ltd',
  customerId: 'customer/a b',
  unread: true,
  updatedAt: '2026-10-27T01:00:00Z',
  messageCount: 2,
  preview: 'Could you provide samples?',
};

test('mail lookup encodes account and search filters while writes are limited to explicit sync and local read marking', async () => {
  requests.length = 0;
  const controller = new AbortController();
  await mailConversationsApi.list(
    { mailboxId: 'account/a b', q: '  samples & quotes  ', unread: true },
    controller.signal,
  );
  const url = new URL(requests[0].path, 'https://example.test');
  assert.equal(url.pathname, '/conversations');
  assert.equal(url.searchParams.get('mailboxId'), 'account/a b');
  assert.equal(url.searchParams.get('q'), 'samples & quotes');
  assert.equal(url.searchParams.get('unread'), '1');
  assert.equal(requests[0].init.signal, controller.signal);
  assert.equal(requests[0].init.method, undefined);
  await mailConversationsApi.detail('thread/a b', controller.signal);
  assert.equal(requests[1].path, '/conversations/thread%2Fa%20b');
  await mailConversationsApi.sync('mailbox-1');
  assert.equal(requests[2].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[2].init.body), { mailboxId: 'mailbox-1' });
  await mailConversationsApi.markRead('thread/a b');
  assert.equal(requests[3].path, '/conversations/thread%2Fa%20b/read');
  assert.deepEqual(JSON.parse(requests[3].init.body), { unread: false });
});

test('mail timeline preserves original participants and plain text while distinguishing accepted from received', () => {
  const html = render(MailConversationTimeline, {
    conversation,
    messages: [
      {
        id: 'incoming',
        direction: 'inbound',
        from: 'buyer@customer.example',
        to: 'sales@our.example',
        subject: 'Product enquiry',
        bodyText: '<script>alert("mail")</script>\nCould you provide samples?',
        occurredAt: '2026-10-27T01:00:00Z',
        deliveryStatus: 'received',
        source: 'imap',
      },
      {
        id: 'outgoing',
        direction: 'outbound',
        from: 'sales@our.example',
        to: 'buyer@customer.example',
        subject: 'Re: Product enquiry',
        bodyText: 'Please confirm the size.',
        occurredAt: '2026-10-27T02:00:00Z',
        deliveryStatus: 'accepted',
        source: 'outreach',
      },
    ],
  });
  assert.match(html, /已收到/);
  assert.match(html, /服务商已接受/);
  assert.match(html, /提交结果不代表对方已收到/);
  assert.match(html, /来自邮箱同步/);
  assert.match(html, /来自系统发送记录/);
  assert.match(html, /buyer@customer\.example/);
  assert.match(html, /href="\/business\?customerId=customer%2Fa%20b"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<textarea|审核并发送|回复邮件/);
});

test('mail sync failures remain visible per account and describe incomplete folder coverage', () => {
  const html = render(MailSyncSummary, {
    statuses: [
      {
        mailboxId: 'one',
        email: 'one@our.example',
        lastSyncAt: null,
        error: 'IMAP 暂时无法连接',
        hasMore: false,
      },
      {
        mailboxId: 'two',
        email: 'two@our.example',
        lastSyncAt: '2026-10-27T01:00:00Z',
        error: null,
        folders: ['INBOX', 'Sent'],
        hasMore: true,
      },
    ],
  });
  assert.match(html, /<details[^>]*open=""/);
  assert.match(html, /1 个邮箱同步异常/);
  assert.match(html, /one@our\.example/);
  assert.match(html, /IMAP 暂时无法连接/);
  assert.match(html, /已同步文件夹：INBOX、Sent/);
  assert.match(html, /还有邮件待同步/);
  assert.match(html, /最近同步 10\/27 09:00/);
});

test('mail conversation entry shows the requested account, local-cache scope and read-only empty loading layout', () => {
  requests.length = 0;
  const html = render(MailConversations, {
    mailboxes: [
      { id: 'mailbox-1', email: 'sales@our.example', configured: true },
      { id: 'mailbox-2', email: 'support@our.example', configured: true },
    ],
    mailboxId: 'mailbox-2',
    onMailboxChange() {},
  });
  assert.match(html, /<option value="mailbox-2" selected="">support@our\.example<\/option>/);
  assert.match(html, /点击“同步邮件”才会连接邮箱读取/);
  assert.match(html, /仅看未读/);
  assert.match(html, /正在读取邮件会话/);
  assert.match(html, /选择一段邮件会话/);
  assert.doesNotMatch(html, /<textarea|审核并发送|回复邮件/);
  assert.equal(requests.length, 0);
});

test('message display offers original layout and plain text without placing unsanitized HTML in the host page', () => {
  const html = render(MailMessageBody, {
    message: {
      id: 'html',
      subject: 'Original layout',
      source: 'imap',
      bodyHtml:
        '<table><tr><td><img src="https://track.example/pixel" onerror="alert(1)"><script>alert(2)</script></td></tr></table>',
      bodyText: 'Plain text alternative',
    },
  });
  assert.match(html, /原邮件/);
  assert.match(html, /纯文本/);
  assert.match(html, /Plain text alternative/);
  assert.doesNotMatch(html, /<script|onerror=|src="https:\/\/track\.example/);
  assert.match(mailFramePolicy(false), /script-src 'none'/);
  assert.match(mailFramePolicy(false), /img-src data:;/);
  assert.doesNotMatch(mailFramePolicy(false), /https:/);
  assert.match(mailFramePolicy(true), /img-src data: https: http:/);
});

test('CID image resolution permits raster data only and links reject script or document data navigation', () => {
  const images = [
    { cid: '<logo@brand>', contentType: 'image/png', contentBase64: 'aGVsbG8=' },
    { cid: 'unsafe', contentType: 'image/svg+xml', contentBase64: 'aGVsbG8=' },
  ];
  assert.equal(inlineImageSource('cid:logo%40brand', images), 'data:image/png;base64,aGVsbG8=');
  assert.equal(inlineImageSource('cid:unsafe', images), '');
  assert.equal(inlineImageSource('cid:missing', images), '');
  assert.equal(safeMailLink('javascript:alert(1)'), '');
  assert.equal(safeMailLink('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(
    safeMailLink('https://supplier.example/products'),
    'https://supplier.example/products',
  );
});

test('reply attachment limits and selected message recipient avoid accidental reply-all expansion', () => {
  assert.equal(validateMailAttachments([{ size: 10 * 1024 * 1024 }]), '');
  assert.match(validateMailAttachments([{ size: 10 * 1024 * 1024 }, { size: 1 }]), /10 MB/);
  assert.match(validateMailAttachments(Array.from({ length: 11 }, () => ({ size: 1 }))), /10 个/);
  const context = {
    replyToMessageId: 'latest',
    to: 'latest@buyer.example',
    from: 'sales@our.example',
  };
  assert.equal(
    replyRecipient(
      {
        id: 'older',
        from: 'from@buyer.example',
        replyTo: ['support@buyer.example'],
        cc: ['cc@buyer.example'],
      },
      context,
    ),
    'support@buyer.example',
  );
  assert.equal(
    replyRecipient({ id: 'latest', from: 'from@buyer.example' }, context),
    'latest@buyer.example',
  );
});

test('draft operations remain separate from explicit reply sending and preserve exact revision and idempotency key', async () => {
  requests.length = 0;
  const content = {
    replyToMessageId: 'message-1',
    bodyHtml: '<p><b>Hello</b></p>',
    bodyText: 'Hello',
    attachments: [],
  };
  await mailConversationsApi.draft('thread/a');
  await mailConversationsApi.saveDraft('thread/a', { ...content, revision: 3 });
  await mailConversationsApi.deleteDraft('thread/a', 4);
  assert.equal(requests[0].path, '/conversations/thread%2Fa/draft');
  assert.equal(requests[0].init.method, undefined);
  assert.equal(requests[1].init.method, 'PUT');
  assert.equal(requests[2].init.method, 'DELETE');
  assert.deepEqual(JSON.parse(requests[2].init.body), { revision: 4 });
  assert.doesNotMatch(requests.map((request) => request.path).join(' '), /\/reply\b/);
  await mailConversationsApi.reply('thread/a', {
    ...content,
    draftRevision: 4,
    idempotencyKey: 'exact-operation-key',
  });
  assert.equal(requests[3].path, '/conversations/thread%2Fa/reply');
  assert.equal(requests[3].init.method, 'POST');
  assert.equal(JSON.parse(requests[3].init.body).draftRevision, 4);
  assert.equal(JSON.parse(requests[3].init.body).idempotencyKey, 'exact-operation-key');
});

test('reply result separates SMTP acceptance, archive failure and unknown outcome without claiming recipient delivery', () => {
  const accepted = render(MailReplyResult, {
    reply: {
      id: 'sent',
      status: 'accepted',
      archiveStatus: 'error',
      recordError: '客户业务暂不可写入',
    },
  });
  assert.match(accepted, /服务商已接受回复/);
  assert.match(accepted, /不代表对方已经收到或阅读/);
  assert.match(accepted, /不会因此重新发送/);
  assert.match(accepted, /客户沟通记录待同步/);
  const unknown = render(MailReplyResult, { reply: { id: 'unknown', status: 'unknown' } });
  assert.match(unknown, /回复结果待核实/);
  assert.match(unknown, /系统不会自动重发/);
});
