import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { createMailboxReader } from '../server/mailbox-reader.mjs';
import { OutreachService } from '../server/outreach-service.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';
import { mailDraftModel } from '../server/mail-draft-model.mjs';
import { honeybadgerFixture } from './verify-mail-knowledge.mjs';

export const internalAccounts = [
  'SL01@honeybadgerblinds.com',
  'sl01@shuangshengshutter.com',
  'SL01@shutterblindssolutions.com',
];
const allowed = new Set(internalAccounts.map((a) => a.toLowerCase()));

// No production store, acquisition source or queue is opened. The transport enforces the envelope.
export async function runInternal(
  passwords,
  log = console.log,
  { purchasingIntroduction = false } = {},
) {
  const model = mailDraftModel(process.env, fetch);
  assert.ok(model, '真实内部环测需要配置回信模型');
  const token = randomUUID(),
    marker = '[AI-SDR internal QA ' + token + ']';
  const root = resolve('.codex-tmp');
  mkdirSync(root, { recursive: true });
  const folder = mkdtempSync(join(root, 'internal-'));
  const vault = new Map(),
    floor = new Map(),
    accepted = [],
    received = new Set(),
    ids = [];
  const { knowledge, box } = await honeybadgerFixture();
  const boxes = new OutreachMailboxes({
    path: join(folder, 'mailboxes.json'),
    seedPath: null,
    protect: async (pass) => {
      const id = randomUUID();
      vault.set(id, pass);
      return { credential: id, credentialProtection: 'aes-256-gcm-local-key' };
    },
    unprotect: async (handle) => vault.get(handle),
    transportFactory: (options) => {
      const transport = nodemailer.createTransport(options);
      return {
        verify: () => transport.verify(),
        close: () => transport.close(),
        sendMail: async (mail) => {
          assert.ok(
            allowed.has(options.auth.user.toLowerCase()) &&
              allowed.has(String(mail.to).toLowerCase()) &&
              mail.subject.includes(marker),
          );
          const result = await transport.sendMail(mail);
          if (result.accepted.some((a) => a.toLowerCase() === mail.to.toLowerCase()))
            accepted.push({ from: options.auth.user, to: mail.to, id: mail.messageId });
          return result;
        },
      };
    },
    mailboxReaderFactory: (opts) =>
      createMailboxReader({
        ...opts,
        imapFactory: (options) => {
          const client = new ImapFlow(options),
            search = client.search.bind(client);
          // Alibaba may return an empty result for SEARCH HEADER SUBJECT even for an exact match.
          // Bound the scan to UIDs allocated after the connection check and inspect envelopes first.
          client.search = async (query, flags) => {
            const key = opts.account + ':' + client.mailbox.path;
            if (!floor.has(key)) floor.set(key, Number(client.mailbox.uidNext));
            const start = Math.max(floor.get(key), Number(query.uid?.split(':')[0] || 1));
            if (start >= Number(client.mailbox.uidNext)) return [];
            const found = await search({ uid: start + ':*' }, flags),
              matches = [];
            for (const uid of found.filter((n) => n >= start)) {
              const meta = await client.fetchOne(uid, { envelope: true }, { uid: true });
              const env = meta?.envelope;
              if (
                env?.subject?.includes(marker) &&
                allowed.has(env.from?.[0]?.address?.toLowerCase()) &&
                allowed.has(env.to?.[0]?.address?.toLowerCase())
              )
                matches.push(uid);
            }
            return matches;
          };
          return client;
        },
      }),
  });
  let service;
  try {
    for (const [i, email] of internalAccounts.entries()) {
      const pass = passwords[email.toLowerCase()];
      assert.equal(typeof pass, 'string', '缺少内部客户端凭据');
      const b = await boxes.save({
        email,
        clientPassword: pass,
        displayName: 'Internal QA',
        signature: 'Internal QA',
        owner: 'Internal QA',
        paused: false,
        intervalSeconds: 5,
        replyMode: i === 0 ? 'auto' : 'manual',
        autoBusinessReplies: i === 0 && purchasingIntroduction,
        draftPersona: purchasingIntroduction
          ? 'You are the project sales representative. Write a formal introduction the customer can forward to purchasing.'
          : '',
        knowledgeProductIds: i === 0 && !purchasingIntroduction ? box.knowledgeProductIds : [],
      });
      ids.push(b.id);
    }
    const checks = await Promise.all(
      internalAccounts.map(async (email, i) => {
        const check = { email, smtp: false, imap: false };
        try {
          await boxes.verify(ids[i]);
          check.smtp = true;
        } catch (error) {
          check.smtpError = error.code;
        }
        try {
          const batch = await boxes.readMailbox(ids[i]);
          check.imap = batch.folderCoverage.inbox;
        } catch (error) {
          check.imapError = error.diagnostic?.code || error.code;
        }
        return check;
      }),
    );
    log(JSON.stringify({ runId: token, checks }));
    assert.ok(
      checks.every((c) => c.smtp && c.imap),
      '三账号连接不完整，未开始投递',
    );
    service = new OutreachService({
      mailboxes: boxes,
      getDraftModel: () => model,
      products: () => knowledge.list(),
      customers: () => [{ id: 'qa-peer', name: 'Internal QA', email: internalAccounts[2] }],
      businessState: () => ({
        customerContexts: [{ customerId: 'qa-peer', fixedEmail: internalAccounts[0] }],
      }),
      answerQuestion: (...args) => answerMailQuestion(knowledge, ...args),
    });
    for (let i = 0; i < 3; i++) {
      const to = internalAccounts[(i + 1) % 3],
        from = internalAccounts[i];
      const result = await boxes.send(ids[i], {
        to,
        expectedAccount: from,
        messageId: '<' + token + '-' + i + '@' + from.split('@')[1] + '>',
        subject:
          marker +
          ' ' +
          (i === 2
            ? purchasingIntroduction
              ? 'Purchasing introduction'
              : 'Product question'
            : 'Ring check'),
        text:
          i === 2
            ? purchasingIntroduction
              ? 'Our purchasing team handles supplier enquiries. Please send an introduction I can forward internally with a practical next step. Kind regards, Jordan.'
              : 'What material is A211 made of?'
            : 'Company-internal mail delivery test. No action required.',
      });
      assert.ok(result.accepted.includes(to));
      log(JSON.stringify({ smtpAccepted: from, to }));
    }
    // Each match must be an actual IMAP inbound message at the intended destination.
    for (let n = 0; n < 16; n++) {
      const sync = await service.conversations.sync();
      if (sync.mailboxes.some((m) => m.error))
        log(
          JSON.stringify({
            syncErrors: sync.mailboxes
              .filter((m) => m.error)
              .map((m) => ({ email: m.email, code: m.lastError?.code })),
          }),
        );
      for (const delivery of accepted) {
        const box = boxes.list().find((b) => b.email.toLowerCase() === delivery.to.toLowerCase());
        const item = service.db
          .prepare(
            `SELECT m.data FROM mailbox_thread_messages m JOIN mailbox_threads t ON t.id=m.thread_id WHERE json_extract(t.data,'$.mailboxId')=? AND json_extract(m.data,'$.messageId')=?
       AND json_extract(m.data,'$.direction')='inbound'`,
          )
          .get(box.id, delivery.id);
        if (item) {
          const mail = JSON.parse(item.data);
          assert.equal(mail.from, delivery.from.toLowerCase());
          if (delivery.id === accepted[3]?.id) {
            assert.equal(mail.inReplyTo, accepted[2].id);
            if (purchasingIntroduction) {
              assert.match(mail.bodyText, /purchas|procur|suppli|forward/i);
              assert.ok(
                mail.bodyText.split(/\r?\n\s*\r?\n/u).filter((p) => p.trim().length >= 20).length >=
                  2,
              );
            } else assert.match(mail.bodyText, /100\s*%\s*polyester/i);
            assert.equal(mail.classification, 'auto_reply');
          }
          if (!received.has(delivery.id))
            log(JSON.stringify({ imapReceived: box.email, subject: mail.subject }));
          received.add(delivery.id);
        }
      }
      await service.reception.tick();
      if (accepted.length === 4 && received.size === 4) break;
      await delay(3000);
    }
    if (accepted.length !== 4 || received.size !== 4)
      log(
        JSON.stringify({
          smtpAccepted: accepted.length,
          imapReceived: received.size,
          work: service.db
            .prepare("SELECT state,json_extract(info,'$.reason') AS reason FROM mail_reception")
            .all(),
        }),
      );
    assert.equal(accepted.length, 4, '应有三封内部探测和一封原线程自动回信');
    assert.equal(received.size, 4, '尚未由收件箱核实全部测试邮件');
    const op = JSON.parse(
      service.db.prepare("SELECT data FROM mail_reply_operations WHERE status='accepted'").get()
        .data,
    );
    assert.equal(op.origin, 'automatic');
    assert.equal(op.provenance.model, model.name);
    assert.equal(op.payload.inReplyTo, accepted[2].id);
    if (purchasingIntroduction) assert.deepEqual(op.provenance.sources, []);
    else assert.ok(op.provenance.sources.some((s) => s.ref === 'B2'));
    assert.equal(service.campaigns().length, 0);
    log(
      JSON.stringify({
        smtpAccepted: 4,
        imapReceived: 4,
        automaticReply: true,
        threadMatched: true,
        source: purchasingIntroduction ? '采购转介来信，无产品资料引用' : '产品规格!B2',
        productionCampaigns: 0,
        runId: token,
      }),
    );
  } finally {
    await service?.close();
    knowledge.close();
    vault.clear();
    rmSync(folder, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv.includes('--live-internal'))
    throw new Error('真实内部投递需要 --live-internal');
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 20000) throw Error();
    }
    const passwords = JSON.parse(input);
    input = '';
    assert.deepEqual(Object.keys(passwords).sort(), [...allowed].sort());
    await runInternal(passwords, console.log, {
      purchasingIntroduction: process.argv.includes('--purchasing-introduction'),
    });
  } catch {
    console.error('真实内部验收未完成，请核对标准输入、三个账号的连接及本轮收件记录。');
    process.exitCode = 1;
  }
}
