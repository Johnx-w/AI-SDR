import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateMailDraft } from '../server/mail-assisted-draft.mjs';
import { mailDraftModel } from '../server/mail-draft-model.mjs';
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
          : { body: 'The material is aluminium.', sourceIndexes: [0] },
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
                return JSON.stringify({ body: 'Hello', sourceIndexes: [5] });
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
    return JSON.stringify({ body: 'The thickness is 5 mm.', sourceIndexes: [0] });
  };
  await h.sync();
  await h.s.reception.tick();
  assert.equal(h.s.reception.list().items[0].state, 'review');
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
                      ? '{"body":"The material is aluminium.","sourceIndexes":[0]}'
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
      return JSON.stringify({ body: 'The material is aluminium.', sourceIndexes: [0] });
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
          JSON.stringify({ body: 'The material is titanium.', sourceIndexes: [0] }),
      },
    ),
    { status: 502 },
  );
  const { draft } = await generateMailDraft(h.s, id, { sourceId, expectedRevision: 0 }, model);
  assert.equal(draft.provenance.model, 'deepseek-flash');
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
  release(JSON.stringify({ body: 'What detail should we confirm?', sourceIndexes: [] }));
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
      return JSON.stringify({ body: 'Could you confirm the model?', sourceIndexes: [] });
    },
  };
  await assert.rejects(generateMailDraft(h.s, id, { sourceId, expectedRevision: 0 }, changed), {
    status: 409,
  });
  assert.equal(h.s.replies.draft(id), null);
});

test('无匹配资料时仅生成澄清草稿，拒绝虚假参数、越界品牌、伪造引用及模型缺失', async (t) => {
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
        generate: async () => JSON.stringify({ body, sourceIndexes }),
      }),
      { status: 502 },
    );
    assert.equal(h.s.replies.draft(id), null);
  }
  const { draft } = await generateMailDraft(h.s, id, input, {
    name: 'deepseek-flash',
    generate: async () =>
      JSON.stringify({
        body: 'Thank you for your inquiry. Could you clarify the model?',
        sourceIndexes: [],
      }),
  });
  assert.deepEqual(draft.provenance.sources, []);
  assert.match(draft.provenance.reason, /没有引用产品资料/);
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
