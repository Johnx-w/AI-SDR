import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { incomingClassification } from '../server/communication-rounds.mjs';
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
