import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMailDraft } from '../server/mail-assisted-draft.mjs';
import { mailDraftModel } from '../server/mail-draft-model.mjs';
import { OutreachService } from '../server/outreach-service.mjs';
import { MaterialLibrary } from '../server/materials.mjs';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';
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
      sources: [
        { productId: 'p', version: h.version, ref: 'B2', field: 'Material', value: 'aluminium' },
      ],
    }),
    getDraftModel: () => h.model,
  };
  h.model = {
    name: 'fixture-chat',
    generate: async (messages) =>
      JSON.stringify(
        messages[0].content.includes('Verify')
          ? { supported: true }
          : { coverage: 'answered', body: 'The material is aluminium.', sourceIndexes: [0] },
      ),
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
  assert.match(h.sends[0].text, /The material is aluminium\./);
  const thread = h.thread();
  assert.equal(h.s.reception.detail(thread).state, 'done');
  assert.equal(h.s.replies.operations(thread.id)[0].provenance.sources[0].ref, 'B2');
  assert.equal(h.s.replies.operations(thread.id)[0].provenance.model, 'fixture-chat');
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

test('自动接待的模型或引用异常进入待处理，复核不通过保留草稿，修复后可重新生成', async (t) => {
  for (const [scenario, state] of [
    ['offline', 'attention'],
    ['unavailable', 'attention'],
    ['badSource', 'attention'],
    ['unsupported', 'review'],
  ]) {
    const h = harness(t);
    const model = h.model;
    h.model =
      scenario === 'unavailable'
        ? null
        : {
            name: model.name,
            generate: async (messages) => {
              if (scenario === 'offline') throw Error('transport failed');
              if (scenario === 'badSource')
                return JSON.stringify({ coverage: 'answered', body: 'Hello', sourceIndexes: [5] });
              if (messages[0].content.includes('Verify')) return '{"supported":false}';
              return model.generate(messages);
            },
          };
    h.incoming();
    await h.sync();
    await h.s.reception.tick();
    const [row] = h.s.reception.list().items;
    assert.equal(row.state, state);
    assert.equal(h.sends.length, 0);
    h.model = model;
    await h.s.reception.prepare(row.sourceId, { regenerate: true });
    assert.equal(h.s.reception.row(row.sourceId).state, 'review');
    assert.match(h.s.replies.draft(row.threadId).bodyText, /The material is aluminium/);
    assert.equal(h.sends.length, 0);
  }
});

test('后台模型等待时撤回资料、人工接管、编辑草稿或切换模型均阻止过期答复', async (t) => {
  for (const change of ['material', 'takeover', 'draft', 'model']) {
    const h = harness(t);
    h.incoming();
    await h.sync();
    const id = h.thread().id,
      source = h.s.conversations.detail(id).messages[0].id;
    const writer = h.model;
    const gate = Promise.withResolvers(),
      started = Promise.withResolvers();
    h.model = {
      ...writer,
      generate: async (messages) => {
        started.resolve();
        await gate.promise;
        return writer.generate(messages);
      },
    };
    const work = h.s.reception.tick();
    await started.promise;
    if (change === 'material') h.version++;
    if (change === 'takeover') await h.s.reception.ownership(id, 'takeover');
    if (change === 'draft')
      h.s.replies.saveDraft(id, {
        replyToMessageId: source,
        expectedRevision: 0,
        bodyText: 'My draft',
      });
    if (change === 'model') h.model = { ...writer, name: 'another-model' };
    gate.resolve();
    await work;
    assert.equal(h.s.replies.draft(id)?.bodyText, change === 'draft' ? 'My draft' : undefined);
    assert.equal(
      h.s.reception.row(source).state,
      change === 'takeover' ? 'cancelled' : 'attention',
    );
    assert.equal(h.sends.length, 0);
  }
});

test('来信中自行提供的规格数值不能当作已审核产品资料自动确认', async (t) => {
  const h = harness(t);
  h.incoming({ bodyText: 'Is the thickness 5 mm?' });
  h.model.generate = async (messages) => {
    assert.ok(!messages[0].content.includes('Verify'));
    return JSON.stringify({
      coverage: 'answered',
      body: 'The thickness is 5 mm.',
      sourceIndexes: [0],
    });
  };
  await h.sync();
  await h.s.reception.tick();
  assert.equal(h.s.reception.list().items[0].state, 'review');
  assert.match(h.s.replies.draft(h.thread().id).bodyText, /with my manager/);
  assert.doesNotMatch(h.s.replies.draft(h.thread().id).bodyText, /5 mm/);
  assert.equal(h.sends.length, 0);
});

test('后台接待使用当前聊天补全连接完成起草与事实复核', async (t) => {
  const h = harness(t);
  const calls = [];
  const live = process.env.MAIL_MODEL_LIVE_SMOKE === '1';
  const config = live
    ? process.env
    : {
        RESEARCH_MODEL_PROVIDER: 'openai_compatible',
        RESEARCH_MODEL_BASE_URL: 'https://model.example.test/v1',
        RESEARCH_MODEL_MODEL: 'sample-chat',
        RESEARCH_MODEL_API_KEY: 'fixture',
      };
  h.model = mailDraftModel(
    config,
    live
      ? fetch
      : async (url, init) => {
          assert.equal(url, 'https://model.example.test/v1/chat/completions');
          const payload = JSON.parse(init.body);
          assert.equal('thinking' in payload, false);
          calls.push(payload.messages);
          return Response.json({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content:
                    calls.length === 1
                      ? '{"coverage":"answered","body":"The material is aluminium.","sourceIndexes":[0]}'
                      : '{"supported":true}',
                },
              },
            ],
          });
        },
  );
  h.incoming({ bodyText: 'What material is the A211 track made of?' });
  h.s.answerQuestion = () => ({
    automatic: true,
    reason: '已审核参数',
    sources: [{ field: 'A211 material', value: 'aluminium', ref: 'B2' }],
  });
  await h.sync();
  await h.s.reception.tick();
  assert.equal(h.sends.length, 1, h.s.reception.list().items[0]?.reason);
  assert.match(h.sends[0].text, /alumin[i]?um/i);
  assert.equal(h.s.replies.operations(h.thread().id)[0].provenance.model, h.model.name);
  if (!live) assert.equal(calls.length, 2);
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

test('手动或历史来信按当前邮箱匹配资料起草，保存来源及签名，发信须另行审核', async (t) => {
  const h = harness(t, 'manual'),
    box = h.s.mailboxes.get('own');
  box.paused = true;
  box.knowledgeProductIds = ['selected'];
  h.s.draftPhotos = () => [
    { name: 'ZX-01.jpg', contentType: 'image/jpeg', contentBase64: '/9j/2Q==' },
  ];
  h.s.answerQuestion = (sender, question) => {
    assert.equal(sender.email, box.email);
    assert.deepEqual(sender.knowledgeProductIds, ['selected']);
    assert.match(question, /material/);
    return {
      sources: [
        {
          productId: 'selected',
          documentId: 'sheet',
          version: h.version,
          field: 'Material',
          ref: 'C8',
          value: 'aluminium',
        },
      ],
    };
  };
  h.incoming();
  await h.sync();
  const id = h.thread().id,
    sourceId = h.s.conversations.detail(id).messages[0].id;
  assert.equal(h.s.reception.row(sourceId), undefined);
  const model = {
    name: 'deepseek-flash',
    generate: async (messages) => {
      const data = JSON.parse(messages[1].content);
      assert.deepEqual(data.evidence, [{ field: 'Material', value: 'aluminium' }]);
      return JSON.stringify({
        coverage: 'answered',
        body: 'The material is aluminium.',
        sourceIndexes: [0],
      });
    },
  };
  await assert.rejects(
    generateMailDraft(
      h.s,
      id,
      { sourceId, expectedRevision: 0 },
      {
        name: model.name,
        generate: async () =>
          JSON.stringify({
            coverage: 'answered',
            body: 'The material is titanium.',
            sourceIndexes: [0],
          }),
      },
    ),
    { status: 502 },
  );
  const { draft } = await generateMailDraft(h.s, id, { sourceId, expectedRevision: 0 }, model);
  assert.equal(draft.provenance.model, 'deepseek-flash');
  assert.equal(h.s.replies.draft(id).attachments[0].name, 'ZX-01.jpg');
  assert.equal(draft.provenance.automatic, false);
  assert.equal(draft.provenance.sources[0].ref, 'C8');
  assert.match(draft.bodyText, /aluminium.*Sales office/s);
  assert.equal(h.s.replies.operations(id).length, 0);
  assert.equal(h.sends.length, 0);
  await assert.rejects(
    generateMailDraft(h.s, id, { sourceId, expectedRevision: draft.revision }, model),
    { status: 409 },
  );
  box.paused = false;
  h.version++;
  await assert.rejects(async () => h.approve(draft), { status: 409 });
  assert.equal(h.sends.length, 0);
  h.version--;
  await h.approve(draft);
  assert.equal(h.sends.length, 1);
});

test('输入原信发生变化或生成期间有人工编辑，保留现稿且不投递', async (t) => {
  const h = harness(t);
  h.incoming();
  await h.sync();
  const id = h.thread().id,
    sourceId = h.s.conversations.detail(id).messages[0].id;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const model = { name: 'deepseek-flash', generate: () => pending };
  const promised = generateMailDraft(h.s, id, { sourceId, expectedRevision: 0 }, model);
  assert.equal(h.s.reception.row(sourceId).state, 'attention');
  await h.s.reception.tick();
  h.s.replies.saveDraft(id, {
    replyToMessageId: sourceId,
    expectedRevision: 0,
    bodyText: 'My manual draft',
  });
  release(JSON.stringify({ coverage: 'unanswered', body: '', sourceIndexes: [] }));
  await assert.rejects(promised, { status: 409 });
  assert.equal(h.s.replies.draft(id).bodyText, 'My manual draft');
  assert.equal(h.sends.length, 0);
  h.s.replies.deleteDraft(id, { revision: h.s.replies.draft(id).revision });
  const changed = {
    name: model.name,
    generate: async () => {
      h.now += 5000;
      h.incoming({ inReplyTo: '<m1@dealer.test>' });
      await h.sync();
      return JSON.stringify({ coverage: 'unanswered', body: '', sourceIndexes: [] });
    },
  };
  await assert.rejects(generateMailDraft(h.s, id, { sourceId, expectedRevision: 0 }, changed), {
    status: 409,
  });
  assert.equal(h.s.replies.draft(id), null);
});

test('常规业务自动回复在原线程推进采购转介，重启及重复同步只提交一次', async (t) => {
  const h = harness(t);
  const box = h.s.mailboxes.get('own');
  box.draftPersona = 'Write formal business correspondence on behalf of the project sales team.';
  box.autoBusinessReplies = true;
  box.businessReplySince = box.replyEnabledAt;
  h.s.answerQuestion = () => ({ automatic: false, sources: [] });
  const live = process.env.MAIL_MODEL_LIVE_SMOKE === '1';
  if (live) h.model = mailDraftModel(process.env, fetch);
  else
    h.model.generate = async (messages) => {
      if (messages[0].content.includes('Verify')) {
        assert.match(messages[0].content, /routineBusinessEmail/);
        return '{"routineBusinessEmail":true,"sellerClaims":[]}';
      }
      assert.ok(messages[0].content.includes(box.draftPersona));
      return JSON.stringify({
        coverage: 'correspondence',
        body: 'Dear Jordan,\n\nI understand that your purchasing team handles supplier enquiries. You are welcome to forward this email to the colleague coordinating the project so they can reply directly in this thread.\n\nFor their reference, I am the sales contact for this enquiry. An outline of their project priorities would give us a starting point for a focused discussion.\n\nKind regards,',
        sourceIndexes: [],
      });
    };
  const mail = h.incoming({
    subject: 'Introduction for our purchasing team',
    bodyText:
      'Our purchasing team handles new suppliers. Please write an introduction I can forward internally, with a practical next step. Kind regards, Jordan.',
  });
  await h.sync();
  await Promise.all([h.s.reception.tick(), h.s.reception.tick()]);
  assert.equal(h.sends.length, 1, h.s.reception.list().items[0]?.reason);
  const sent = h.sends[0];
  assert.equal(sent.to, peer);
  assert.equal(sent.inReplyTo, mail.messageId);
  assert.match(sent.text, /purchas|procur|suppli|forward/i);
  assert.match(sent.text, /Sales office$/);
  const paragraphs = sent.text
    .split(/\n\s*\n/u)
    .filter((line) => line.trim().split(/\s+/).length >= 8);
  assert.ok(paragraphs.length >= 2, '应包含多段实质正文');
  if (live) console.log('真实模型合成采购转介回信（仅测试传输）：\n' + sent.text);
  await h.restart();
  h.events.push(mail);
  await h.sync();
  await h.s.reception.tick();
  assert.equal(h.sends.length, 1);
});

test('扩大自动接待范围须逐邮箱启用，启用前的来信、商务问题、未通过复核的回复均待审', async (t) => {
  for (const scenario of [
    'previous',
    'before',
    'quote',
    'review',
    'declined',
    'fragment',
    'sellerClaim',
  ]) {
    const h = harness(t, scenario === 'review' ? 'review' : 'auto');
    const box = h.s.mailboxes.get('own');
    box.autoBusinessReplies = scenario !== 'previous';
    box.businessReplySince =
      scenario === 'before' ? new Date(h.now + 1000).toISOString() : box.replyEnabledAt;
    h.s.answerQuestion = () => ({ automatic: false, sources: [], reason: '未匹配资料' });
    let verified = false;
    h.model.generate = async (messages) => {
      if (messages[0].content.includes('Verify')) {
        verified = true;
        if (scenario === 'sellerClaim')
          return '{"routineBusinessEmail":true,"sellerClaims":["We supply blinds to commercial customers."]}';
        return '{"routineBusinessEmail":false}';
      }
      if (scenario === 'fragment')
        return '{"coverage":"correspondence","body":"Who handles purchasing?","sourceIndexes":[]}';
      return JSON.stringify({
        coverage: scenario === 'quote' ? 'unanswered' : 'correspondence',
        body: 'Dear colleague,\n\nI understand that you are considering the next step for this project.\n\nWe can continue the discussion in this thread when your team is ready.\n\nKind regards,',
        sourceIndexes: [],
      });
    };
    h.incoming({
      subject: 'Project enquiry',
      bodyText:
        scenario === 'quote'
          ? 'Please quote the price.'
          : 'I would like an introduction for our purchasing team.',
    });
    await h.sync();
    await h.s.reception.tick();
    assert.equal(verified, scenario === 'declined' || scenario === 'sellerClaim');
    assert.equal(h.s.reception.list().items[0].state, 'review');
    assert.equal(h.sends.length, 0);
  }
});

test('无匹配资料时按邮箱身份为采购转介起草，保存待审且不发信', async (t) => {
  const h = harness(t, 'manual');
  const persona = '你是项目销售联络人。用简洁的英文给采购团队写可转发的介绍。';
  h.s.mailboxes.get('own').draftPersona = persona;
  h.s.answerQuestion = () => ({ sources: [] });
  h.incoming({
    subject: 'Purchasing team introduction',
    bodyText: 'Our purchasing team handles this. Please write a short note I can forward to them.',
  });
  await h.sync();
  const id = h.thread().id;
  const sourceId = h.s.conversations.detail(id).messages[0].id;
  let prompt;
  const live = process.env.MAIL_MODEL_LIVE_SMOKE === '1' && mailDraftModel(process.env, fetch);
  const model = {
    name: live ? live.name : 'fixture-chat',
    generate: async (messages) => {
      prompt = messages;
      if (process.env.MAIL_MODEL_LIVE_SMOKE === '1') {
        assert.ok(live, '请先配置验收模型连接');
        return live.generate(messages);
      }
      return JSON.stringify({
        coverage: 'correspondence',
        body: 'I understand that your purchasing team handles this. Please forward my contact details to the buyer handling this project.',
        sourceIndexes: [],
      });
    },
  };
  const { draft } = await generateMailDraft(h.s, id, { sourceId, expectedRevision: 0 }, model);
  assert.ok(prompt.some((message) => message.content.includes(persona)));
  assert.deepEqual(JSON.parse(prompt.at(-1).content).evidence, []);
  assert.match(draft.bodyText, /purchas|procur|buy|forward/i);
  assert.match(draft.bodyText, /Sales office$/);
  assert.deepEqual(draft.provenance.sources, []);
  assert.equal(draft.provenance.automatic, false);
  assert.equal(h.sends.length, 0);
});

test('无匹配资料时说明需与上级讨论，拒绝虚假参数、越界品牌、伪造引用及模型缺失', async (t) => {
  const h = harness(t, 'manual');
  h.s.answerQuestion = () => ({ sources: [] });
  h.incoming();
  await h.sync();
  const id = h.thread().id,
    sourceId = h.s.conversations.detail(id).messages[0].id;
  const input = { sourceId, expectedRevision: 0 };
  await assert.rejects(generateMailDraft(h.s, id, input, null), { status: 503 });
  for (const [body, sourceIndexes] of [
    ['The material is aluminium.', []],
    ['We can ship within 48 hours.', []],
    ['What about Shuangsheng Shutter?', []],
    ['What model?', [3]],
  ]) {
    await assert.rejects(
      generateMailDraft(h.s, id, input, {
        name: 'deepseek-flash',
        generate: async () => JSON.stringify({ coverage: 'answered', body, sourceIndexes }),
      }),
      { status: 502 },
    );
    assert.equal(h.s.replies.draft(id), null);
  }
  const { draft } = await generateMailDraft(h.s, id, input, {
    name: 'deepseek-flash',
    generate: async () =>
      JSON.stringify({
        coverage: 'unanswered',
        body: '',
        sourceIndexes: [],
      }),
  });
  assert.deepEqual(draft.provenance.sources, []);
  assert.match(draft.provenance.reason, /上级/);
  assert.match(draft.bodyText, /discuss your question with my manager/);
  assert.equal(h.sends.length, 0);
});

test('上传并审核的正文能回答保养问题，缺项转上级并保留已知部分及原文位置', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const website = 'https://honeybadgerblinds.com';
  const library = new MaterialLibrary(k, [{ website, brandName: 'Honey Badger Blinds' }]);
  const { id, documentId } = await library.upload({
    name: 'care-note.txt',
    bytes: Buffer.from(
      'Clean the slats with a dry microfiber cloth.\nUse a soft brush on the headrail.',
    ),
    site: 'honeybadgerblinds.com',
    key: 'care-note-test',
  });
  const [first] = library.detail(id).documents[0].extraction.facts;
  library.edit(id, {
    version: 1,
    status: 'approved',
    approvedBy: 'QA',
    sourceFacts: [{ documentId, location: first.location, text: first.text }],
  });
  const live = process.env.MAIL_MODEL_LIVE_SMOKE === '1';
  for (const [question, coverage] of [
    ['How should I clean the slats?', 'answered'],
    ['What is the fire rating?', 'unanswered'],
    ['How should I clean the slats? What is their fire rating?', 'partial'],
    ['请问叶片怎么清洁？另外，它达到哪一级防火标准？', 'partial'],
  ]) {
    const h = harness(t, 'review');
    const box = h.s.mailboxes.get('own');
    Object.assign(box, { website, knowledgeProductIds: [id] });
    h.s.answerQuestion = (...args) => answerMailQuestion(k, ...args);
    h.model = live
      ? mailDraftModel(process.env, fetch)
      : {
          name: 'care-test',
          generate: async (messages) => {
            const { evidence } = JSON.parse(messages[1].content);
            assert.deepEqual(
              evidence.map((s) => s.value),
              [first.text],
            );
            return JSON.stringify({
              coverage,
              language: question.startsWith('请') ? 'zh' : 'en',
              body: coverage === 'unanswered' ? '' : first.text,
              sourceIndexes: coverage === 'unanswered' ? [] : [0],
            });
          },
        };
    h.incoming({ subject: 'Care enquiry', bodyText: question });
    await h.sync();
    await h.s.reception.tick();
    const row = h.s.reception.list().items[0];
    const draft = h.s.replies.draft(h.thread().id);
    assert.ok(draft, row?.reason);
    const sources = draft.provenance.sources;
    if (coverage !== 'unanswered') {
      assert.match(draft.bodyText, /microfib(?:er|re)|超细纤维|微纤维/iu);
      assert.deepEqual(
        sources.map(({ documentId, ref, value }) => [documentId, ref, value]),
        [[documentId, first.location, first.text]],
      );
    } else assert.deepEqual(sources, []);
    assert.equal(/manager|上级/iu.test(draft.bodyText), coverage !== 'answered');
    assert.equal(row.state, 'review');
    assert.equal(h.sends.length, 0);
  }
});

test('大资料的跨语言问题能找到候选窗口之外的已审核段落', async (t) => {
  const k = new ProductKnowledge(),
    h = harness(t, 'manual');
  t.after(() => k.close());
  const box = h.s.mailboxes.get('own');
  box.website = 'https://honeybadgerblinds.com';
  const lib = new MaterialLibrary(k, [{ website: box.website, brandName: 'Honey Badger Blinds' }]);
  const care = '叶片只需使用干燥的超细纤维布清洁。';
  const lines = Array.from({ length: 199 }, (_, i) => '包装标签条目 ' + i).concat(care);
  const { id, documentId } = await lib.upload({
    name: 'manual.txt',
    bytes: Buffer.from(lines.join('\n')),
    key: 'many-passages',
    site: 'honeybadgerblinds.com',
  });
  const facts = lib
    .detail(id)
    .documents[0].extraction.facts.map(({ text, location }) => ({ documentId, text, location }));
  lib.edit(id, { version: 1, status: 'approved', approvedBy: 'QA', sourceFacts: facts });
  box.knowledgeProductIds = [id];
  h.s.answerQuestion = (...args) => answerMailQuestion(k, ...args);
  h.incoming({ subject: 'Care', bodyText: 'What should I use to wipe down the slats?' });
  await h.sync();
  const thread = h.thread().id;
  const sourceId = h.s.conversations.detail(thread).messages[0].id;
  let searched = false;
  const model = {
    name: 'care-test',
    generate: async (messages) => {
      if (messages[0].content.startsWith('Find terms')) {
        searched = true;
        return JSON.stringify({ words: ['清洁', '叶片'] });
      }
      const { evidence } = JSON.parse(messages[1].content);
      assert.ok(evidence.length <= 32);
      const index = evidence.findIndex((s) => s.value === care);
      assert.ok(index >= 0);
      return JSON.stringify({
        coverage: 'answered',
        body: 'Use a dry microfiber cloth.',
        sourceIndexes: [index],
      });
    },
  };
  const { draft } = await generateMailDraft(h.s, thread, { sourceId, expectedRevision: 0 }, model);
  assert.ok(searched);
  assert.deepEqual(
    draft.provenance.sources.map((s) => s.ref),
    ['第 200 段'],
  );
  assert.equal(h.sends.length, 0);
});

test('非正常客户来信及停止联系不进入模型', async (t) => {
  for (const classification of [
    'unsubscribe',
    'hard_bounce',
    'auto_reply',
    'complaint',
    'unverified',
  ]) {
    const h = harness(t, 'manual');
    h.incoming({ classification });
    await h.sync();
    const id = h.thread().id,
      sourceId = h.s.conversations.detail(id).messages[0].id;
    await assert.rejects(
      generateMailDraft(
        h.s,
        id,
        { sourceId, expectedRevision: 0 },
        { name: 'deepseek-flash', generate: assert.fail },
      ),
      { status: 409 },
    );
    assert.equal(h.s.replies.draft(id), null);
  }
});
