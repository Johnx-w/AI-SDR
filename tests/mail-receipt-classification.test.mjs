import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyInboundReply, incomingClassification } from '../server/communication-rounds.mjs';
import { MailConversations } from '../server/mail-conversations.mjs';
import { reclassifyMailCache } from '../scripts/reclassify-mail-cache.mjs';

const divider = '##- Please type your reply above this line -##';
const helpdesk = divider + '\nYour request (88412) has been received and is being reviewed.';
const acknowledgment = 'Thank you for your message. Our team will be in touch soon.';
const hours =
  'Your message is with our team and we will reply as soon as possible. Messages received outside our opening hours are handled the next day.';
const generic = "Thanks for getting in touch. We'll be back with you within 48 hours.";
const question = 'Can you send the specifications for the track?';
const base = {
  from: 'help@buyer.example',
  to: 'sales@seller.example',
  subject: 'Re: Product sample',
  inReplyTo: '<seed@seller.example>',
};
test('客服回执须有组合证据；通用时限与无正文须核实，引用和同主题不构成机器证据', () => {
  for (const [input, result] of [
    [{ bodyText: helpdesk }, 'auto_reply'],
    [
      { bodyText: divider + '\nYour request has been received. Ticket reference: S-8842' },
      'auto_reply',
    ],
    [
      {
        bodyText: acknowledgment,
        bodyHtml: '<p>' + acknowledgment + '</p><h2>Ticket reference</h2><p>QA-8842</p>',
      },
      'auto_reply',
    ],
    [{ bodyText: hours }, 'auto_reply'],
    [
      {
        bodyText:
          'Your message is with our team and we will reply to you personally as soon as we can. Requests received outside our opening hours may wait until we reopen.',
      },
      'auto_reply',
    ],
    [
      {
        bodyText:
          'Thanks so much for your message. Our team are on it and will be in touch soon to support you.',
        bodyHtml: '<h1>Your service ticket</h1>',
      },
      'auto_reply',
    ],
    [{ bodyText: generic }, 'unverified'],
    [{ bodyText: generic + '\nRegards,\nThe customer desk' }, 'unverified'],
    [
      {
        bodyText:
          generic.replace('48', '24–48').replace("We'll", 'We’ll') +
          '\n \nBest wishes,\nSales Desk',
        bodyHtml:
          '<p>Thank you</p><address>Customer Desk</address><div class="gmail_quote">Earlier question</div>',
      },
      'unverified',
    ],
    [
      {
        bodyText: generic + '\nSend a quote',
        bodyHtml: '<p>' + generic + '</p><p>Send a quote</p><blockquote>Older</blockquote>',
      },
      'normal',
    ],
    [{ bodyText: '', bodyUnavailable: 'too_large' }, 'unverified'],
    [{ bodyText: generic + ' Can you also send new samples?' }, 'normal'],
    [{ bodyText: question, subject: 'Re: [Request received]' }, 'normal'],
    [{ bodyText: question + '\n' + helpdesk }, 'normal'],
    [{ bodyText: question + '\nOn Monday a colleague wrote:\n' + hours }, 'normal'],
    [{ bodyHtml: '<p>' + question + '</p><blockquote>' + hours + '</blockquote>' }, 'normal'],
    [{ bodyHtml: '<p>' + question + '</p><div class="gmail_quote">' + hours + '</div>' }, 'normal'],
    [{ bodyText: '> ' + hours }, 'unverified'],
    [{ bodyText: 'The reference for your ticket is QA-8842. ' + question }, 'normal'],
    [{ bodyText: question, classification: 'auto_reply' }, 'auto_reply'],
  ])
    assert.equal(incomingClassification({ ...base, ...input }), result, JSON.stringify(input));
});

test('35 条审计口径的脱敏合成回放统一区分积极、拒绝、转介、通知、退信和待核实', () => {
  const positive = [
    'Please send your price list for the finished shutters.',
    'Could you share your latest product catalogue?',
    'We are interested and would be happy to arrange a meeting next week.',
  ];
  const refusal = [
    'We are not interested in adding a new supplier.',
    'We manufacture our curtains in house and do not buy finished curtains externally.',
    'No thank you, please remove us from future sales outreach.',
  ];
  const referral = ['Please submit supplier enquiries through our commercial contact form.'];
  const notifications = Array.from({ length: 22 }, (_, index) =>
    index === 0
      ? divider +
        '\nYour request (88412) has been received and is being reviewed.\n> Please send a quote and catalogue.'
      : index % 2
        ? `Automatic reply: our support team has received case #${88000 + index}.`
        : `We have received your request. Ticket number: QA-${88000 + index}. Our team is reviewing it.`,
  );
  const bounces = Array.from(
    { length: 5 },
    (_, index) => `Address not found. User ${index + 1} does not exist.`,
  );
  const samples = [
    ...positive.map((bodyText) => ({ bodyText, expected: 'positive' })),
    ...refusal.map((bodyText) => ({ bodyText, expected: 'refusal' })),
    ...referral.map((bodyText) => ({ bodyText, expected: 'referral' })),
    ...notifications.map((bodyText) => ({ bodyText, expected: 'notification' })),
    ...bounces.map((bodyText) => ({
      bodyText,
      from: 'postmaster@buyer.example',
      subject: 'Delivery failure',
      expected: 'bounce',
    })),
    { bodyText: '', expected: 'unverified' },
  ];
  const counts = {};
  for (const sample of samples) {
    const result = classifyInboundReply({ ...base, ...sample });
    assert.equal(result.kind, sample.expected, sample.bodyText);
    counts[result.kind] = (counts[result.kind] || 0) + 1;
  }
  assert.equal(samples.length, 35);
  assert.deepEqual(counts, {
    positive: 3,
    refusal: 3,
    referral: 1,
    notification: 22,
    bounce: 5,
    unverified: 1,
  });
  assert.deepEqual(
    positive.map((bodyText) => classifyInboundReply({ ...base, bodyText }).requestType),
    ['quote', 'catalog', 'meeting'],
  );
});

test('客服工单分隔线上方的真人索价优先于下方受理通知', () => {
  assert.deepEqual(
    classifyInboundReply({
      ...base,
      bodyText:
        'Please send your price list.\n' +
        divider +
        '\nYour request (88412) has been received and is being reviewed.',
    }),
    { kind: 'positive', requestType: 'quote' },
  );
});

test('克隆库重分类预演无写入，回填同步索引且重复执行无变更', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mail-receipts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'clone.sqlite'),
    db = new DatabaseSync(path);
  const box = { id: 'demo', email: base.to };
  try {
    const store = new MailConversations({ db, mailboxes: { list: () => [box] } });
    for (const [index, bodyText] of [question, helpdesk, generic, ''].entries()) {
      store.putMessage(box, {
        ...base,
        bodyText,
        direction: 'inbound',
        source: 'imap',
        deliveryStatus: 'received',
        occurredAt: '2026-01-01T12:00:00Z',
        messageId: '<demo-' + index + '@buyer.example>',
      });
    }
    db.exec("UPDATE mailbox_thread_messages SET data=json_set(data,'$.classification','normal')");
    const original = () =>
      db
        .prepare(
          "SELECT id, json_remove(data,'$.classification') AS data FROM mailbox_thread_messages ORDER BY id",
        )
        .all();
    const before = original();
    assert.equal(store.replyHistory({ kind: 'reply' }).total, 4);
    assert.deepEqual(reclassifyMailCache(path), {
      apply: false,
      considered: 4,
      changes: 3,
      transitions: { 'normal → auto_reply': 1, 'normal → unverified': 2 },
      businessTransitions: {},
    });
    assert.equal(store.replyHistory({ kind: 'reply' }).total, 4);
    assert.equal(reclassifyMailCache(path, true).changes, 3);
    assert.equal(store.replyHistory({ kind: 'reply' }).total, 1);
    assert.equal(store.replyHistory({ kind: 'unverified' }).total, 2);
    assert.equal(store.replyHistory({ kind: 'notification' }).total, 1);
    assert.equal(reclassifyMailCache(path, true).changes, 0);
    assert.deepEqual(original(), before);
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM sqlite_schema WHERE name IN ('outreach_followups','mail_reception','mail_reply_operations')",
        )
        .get().n,
      0,
    );
  } finally {
    db.close();
  }
});
test('客户本次原文决定态度与请求，忽略引文和分析摘要', () => {
  for (const [input, kind, request] of [
    [{ bodyText: 'Please do not send a catalog.' }, 'refusal', null],
    [{ bodyText: 'Yes, happy to meet next week.' }, 'positive', 'meeting'],
    [{ bodyText: 'I have already received your catalogue.' }, 'other', null],
    [
      {
        bodyText: 'Thank you.\nPlease send your price list.',
        bodyHtml: '<p>Thank you.</p><blockquote>Please send your price list.</blockquote>',
      },
      'other',
      null,
    ],
    [
      { bodyText: 'Please send a quote.', replyAnalysis: { demandSummary: 'not interested' } },
      'positive',
      'quote',
    ],
    [{ bodyHtml: '<p>Please send a quote.</p>' }, 'positive', 'quote'],
  ])
    assert.deepEqual(classifyInboundReply({ ...base, ...input }), { kind, requestType: request });
});
test('空正文补录后使用隔离库重跑保持索价与零变更', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rescan-reply-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'clone.sqlite'),
    db = new DatabaseSync(file),
    box = { id: 'demo', email: base.to };
  try {
    const store = new MailConversations({ db, mailboxes: { list: () => [box] } });
    const input = {
      ...base,
      direction: 'inbound',
      source: 'imap',
      occurredAt: '2026-01-01T12:00:00Z',
      messageId: '<updated@buyer.example>',
      bodyText: '',
    };
    store.putMessage(box, input);
    store.putMessage(box, { ...input, bodyText: 'Please send a quotation.', bodyFormatVersion: 2 });
    assert.equal(store.replyHistory({ kind: 'all' }).businessCounts.positive, 1);
  } finally {
    db.close();
  }
  assert.equal(reclassifyMailCache(file, true).changes, 0);
});
