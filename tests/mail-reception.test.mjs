import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutreachService } from '../server/outreach-service.mjs';
const peer = 'buyer@dealer.test';
function harness(t, mode = 'auto') {
  const dir = mkdtempSync(join(tmpdir(), 'sdr-reception-')),
    path = join(dir, 'mail.sqlite');
  const h = {
    now: Date.parse('2026-11-01T00:00:00Z'),
    sends: [],
    events: [],
    ownership: 'auto',
    version: 1,
  };
  const box = {
    id: 'own',
    website: 'https://seller.test',
    email: 'sales@seller.test',
    configured: true,
    paused: false,
    smtpStatus: 'connected',
    replyMode: mode,
    signature: 'Sales office',
    owner: 'Jo',
    replyEnabledAt: '2026-10-31T00:00:00Z',
    intervalSeconds: 5,
    dailyLimit: 30,
  };
  const mailboxes = {
    get: () => box,
    list: () => [box],
    readMailbox: async () => ({
      folders: [{ path: 'INBOX', uidValidity: '1', nextUid: 10, messages: h.events.splice(0) }],
      hasMore: false,
    }),
    send: async (id, m, { beforeSend }) => {
      if (h.beforeSend) await h.beforeSend();
      beforeSend();
      h.sends.push(m);
      if (h.uncertain) throw Error('no acknowledgement');
      return { accepted: [m.to] };
    },
  };
  const options = {
    path,
    mailboxes,
    now: () => h.now,
    customers: () => [{ id: 'buyer', email: peer }],
    businessState: () => ({
      customerContexts: [{ customerId: 'buyer', fixedEmail: h.fixed ?? box.email }],
      conversations: [{ customerId: 'buyer', account: box.email, ownership: h.ownership }],
    }),
    setMailOwnership: async (_, state) => {
      h.ownership = state;
    },
    answerQuestion: () => ({
      automatic: true,
      body: 'Material: aluminium',
      reason: '技术参数',
      sources: [{ productId: 'p', version: h.version, ref: 'B2' }],
    }),
  };
  h.s = new OutreachService(options);
  h.restart = async () => {
    await h.s.close();
    h.s = new OutreachService(options);
  };
  let uid = 0;
  h.incoming = (extra = {}) => {
    uid++;
    const m = {
      uid,
      from: peer,
      to: box.email,
      toAddresses: [box.email],
      direction: 'inbound',
      messageId: `<m${uid}@dealer.test>`,
      subject: 'Specification',
      bodyText: 'What material is it made of?',
      occurredAt: new Date(h.now).toISOString(),
      ...extra,
    };
    h.events.push(m);
    return m;
  };
  h.sync = () => h.s.conversations.sync();
  h.thread = () => h.s.conversations.list().items[0];
  h.approve = (draft, key = 'operator-1') =>
    h.s.replies.reply(draft.conversationId, {
      replyToMessageId: draft.replyToMessageId,
      draftRevision: draft.revision,
      idempotencyKey: key,
    });
  t.after(async () => {
    await h.s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

test('待审列表在 SQLite 内筛选分页，断网仍能读取五千封中的跨页待办', (t) => {
  const h = harness(t);
  const insert = h.s.db.prepare('INSERT INTO mail_reception VALUES(?,?,?,?,?,?,?)');
  h.s.transaction(() => {
    for (let i = 0; i < 5000; i++)
      insert.run(
        'mail-' + i,
        'thread-' + i,
        'own',
        i % 10 ? 'done' : 'review',
        i,
        0,
        JSON.stringify({ subject: 'Subject ' + i }),
      );
  });
  h.s.mailboxes.readMailbox = () => {
    throw Error('离线');
  };
  const times = [];
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    const page = h.s.reception.list({ page: 2 });
    times.push(performance.now() - start);
    assert.equal(page.total, 500);
    assert.equal(page.items.length, 20);
    assert.equal(page.items[0].sourceId, 'mail-4790');
  }
  times.sort((a, b) => a - b);
  const plan = h.s.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT source_id,thread_id,state,received_at,info FROM mail_reception INDEXED BY mail_reception_review_order WHERE state IN ('review','attention','uncertain') ORDER BY received_at DESC,source_id LIMIT 20 OFFSET 20",
    )
    .all();
  assert.ok(plan.some((row) => row.detail.includes('mail_reception_review_order')));
  assert.ok(!plan.some((row) => row.detail.includes('TEMP B-TREE')));
  console.log(
    `待审查询 5000 封／500 待办，50 次 P50 ${times[25].toFixed(2)} ms，P95 ${times[47].toFixed(2)} ms；${plan.map((row) => row.detail).join(' / ')}`,
  );
});
test('新来信与游标落库后重启，两个执行者及重复同步只发送一次有依据的原线程回信', async (t) => {
  const h = harness(t);
  const mail = h.incoming();
  await h.sync();
  await h.restart();
  await Promise.all([h.s.reception.tick(), h.s.reception.tick()]);
  h.events.push(mail);
  await h.sync();
  await h.s.reception.tick();
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].inReplyTo, mail.messageId);
  const thread = h.thread();
  assert.equal(h.s.reception.detail(thread).state, 'done');
  assert.equal(h.s.replies.operations(thread.id)[0].provenance.sources[0].ref, 'B2');
  await h.restart();
  await h.s.reception.tick();
  assert.equal(h.sends.length, 1);
});
test('逐封审核、过期资料重做、重试批准以及不同幂等编号均不会重复发送', async (t) => {
  const h = harness(t, 'review');
  h.incoming();
  await h.sync();
  await h.s.reception.tick();
  assert.equal(h.sends.length, 0);
  const row = h.s.reception.list().items[0];
  assert.equal(row.owner, 'Jo');
  const draft = h.s.replies.draft(row.threadId);
  h.version++;
  assert.throws(() => h.approve(draft), /已更新/);
  await h.s.reception.prepare(row.sourceId, { regenerate: true });
  const next = h.s.replies.draft(row.threadId);
  await h.approve(next);
  await h.approve(next);
  assert.equal(h.sends.length, 1);
  assert.equal(h.s.reception.list().total, 0);
  assert.throws(() => h.approve(next, 'other-key'), /草稿/);
});
test('客户固定邮箱待核对时保留待办，核实归属后可重新起草', async (t) => {
  const h = harness(t);
  h.fixed = '';
  h.incoming();
  await h.sync();
  await h.s.reception.tick();
  const waiting = h.s.reception.list().items[0];
  assert.equal(waiting.state, 'attention');
  assert.match(waiting.reason, /固定邮箱/);
  h.fixed = 'sales@seller.test';
  await h.s.reception.prepare(waiting.sourceId, { regenerate: true });
  assert.equal(h.s.reception.list().items[0].state, 'review');
  assert.equal(h.sends.length, 0);
});
test('接管保留已编辑草稿与原依据，业务员仍可手动提交一次', async (t) => {
  const h = harness(t, 'review');
  h.incoming();
  await h.sync();
  await h.s.reception.tick();
  const id = h.thread().id;
  const original = h.s.replies.draft(id);
  const edited = h.s.replies.saveDraft(id, {
    expectedRevision: original.revision,
    bodyText: 'Material: aluminium. Sample available on request.',
  });
  await h.s.reception.ownership(id, 'takeover');
  assert.deepEqual(h.s.replies.draft(id).provenance, original.provenance);
  await h.s.reception.tick();
  assert.equal(h.sends.length, 0);
  await h.approve(edited);
  await h.approve(edited);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].text, edited.bodyText);
});
test('删除待审草稿从队列撤回，重启不会为原来信再生成', async (t) => {
  const h = harness(t, 'review');
  h.incoming();
  await h.sync();
  await h.s.reception.tick();
  const draft = h.s.replies.draft(h.thread().id);
  h.s.reception.discardDraft(draft.conversationId, { revision: draft.revision });
  await h.restart();
  await h.s.reception.tick();
  assert.equal(h.s.reception.list().total, 0);
  assert.equal(h.s.replies.draft(draft.conversationId), null);
  assert.equal(h.sends.length, 0);
});
test('提交前员工在邮箱手动回信，自动操作让位；服务商结果不明时跨重启不重发', async (t) => {
  const h = harness(t);
  const m = h.incoming();
  await h.sync();
  h.beforeSend = async () => {
    h.beforeSend = null;
    h.now += 1000;
    h.incoming({
      direction: 'outbound',
      from: 'sales@seller.test',
      to: peer,
      toAddresses: [peer],
      inReplyTo: m.messageId,
    });
    await h.sync();
  };
  await h.s.reception.tick();
  assert.equal(h.sends.length, 0);
  h.now += 86400000;
  h.incoming();
  await h.sync();
  h.uncertain = true;
  await h.s.reception.tick();
  assert.equal(h.sends.length, 1);
  await h.restart();
  await h.s.reception.tick();
  assert.equal(h.sends.length, 1);
  assert.equal(h.s.replies.operations(h.thread().id)[0].status, 'unknown');
});
test('历史导入、系统回执、退信及退订不生成回信，接管恢复仅对新来信生效', async (t) => {
  const h = harness(t, 'review');
  h.incoming({ occurredAt: '2026-10-01T00:00:00Z' });
  h.incoming({ subject: 'Out of office' });
  h.incoming({ bodyText: "Thanks for getting in touch. We'll be back with you within 48 hours." });
  h.incoming({ bodyText: '', bodyUnavailable: 'too_large' });
  h.incoming({ from: 'postmaster@dealer.test', subject: 'Undeliverable' });
  await h.sync();
  await h.s.reception.tick();
  assert.equal(h.s.reception.list().total, 0);
  assert.equal(h.sends.length, 0);
  h.now += 60000;
  const original = h.incoming();
  await h.sync();
  await h.s.reception.tick();
  const { threadId } = h.s.reception.list().items[0];
  await h.s.reception.ownership(threadId, 'takeover');
  assert.equal(h.s.replies.draft(threadId), null);
  assert.equal(h.s.reception.list().total, 0);
  await h.s.reception.ownership(threadId, 'resume');
  await h.s.reception.tick();
  assert.equal(h.s.reception.list().total, 0);
  h.now += 10000;
  h.incoming({ inReplyTo: original.messageId });
  await h.sync();
  await h.s.reception.tick();
  assert.equal(h.s.reception.list().total, 1);
  h.now += 10000;
  h.incoming({ bodyText: 'Please unsubscribe me.', inReplyTo: original.messageId });
  await h.sync();
  assert.equal(h.s.reception.list().total, 0);
  await assert.rejects(h.s.reception.ownership(threadId, 'resume'), /退订/);
});
