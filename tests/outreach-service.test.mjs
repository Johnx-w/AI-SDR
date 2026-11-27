import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewOutreachTemplate } from '../server/outreach-template-preview.mjs';
import { OutreachService } from '../server/outreach-service.mjs';
import { eligibleOutreachFacts } from '../server/outreach-content.mjs';
import { saveSequencePolicy } from '../server/outreach-sequence-policy.mjs';

function buyer(id = 'buyer-one', product = 'PVC shutters') {
  const domain = `${id}.example.org`;
  return {
    id,
    name: `Company ${id}`,
    website: `https://${domain}`,
    market: 'Australia',
    grade: 'B',
    status: '待开发',
    email: `info@${domain}`,
    type: '经销商',
    product,
    facts: [
      {
        field: 'entity_type',
        value: 'business',
        quote: 'We are a window furnishing business.',
        source_url: `https://${domain}/about`,
      },
      {
        field: 'products',
        value: product,
        quote: `Our product range includes ${product}.`,
        source_url: `https://${domain}/products`,
      },
    ],
    contactEvidence: [
      {
        kind: 'email',
        value: `info@${domain}`,
        quote: `Email info@${domain}`,
        source_url: `https://${domain}/contact`,
      },
    ],
  };
}

function harness(options = {}) {
  const products = [
    {
      id: 'pvc',
      name: 'PVC 透气窗',
      englishName: 'PVC shutters',
      direction: 'finished',
      status: 'approved',
      version: 1,
      markets: [],
    },
    {
      id: 'roller',
      name: '卷帘',
      englishName: 'roller blinds',
      direction: 'finished',
      status: 'approved',
      version: 1,
      markets: [],
    },
  ];
  const boxes = ['brand-a', 'brand-b', 'brand-c'].map((id, index) => ({
    id,
    email: `sales@${id}.example.org`,
    website: `https://${id}.example.org`,
    brandName: id,
    displayName: id,
    signature: `${id}\nhttps://${id}.example.org`,
    priority: index + 1,
    productIds: ['pvc', 'roller'],
    configured: true,
    smtpStatus: 'connected',
    paused: false,
    dailyLimit: 50,
    intervalSeconds: 30,
  }));
  const deliveries = [];
  const state = {
    clock: Date.parse('2026-10-26T04:00:00Z'),
    leads: [buyer()],
    business: {},
    loadGate: null,
    sendError: null,
  };
  const mailboxes = {
    list: () => structuredClone(boxes),
    get: (id) => structuredClone(boxes.find((box) => box.id === id)),
    save: async (input) => {
      const existing = boxes.find((box) => box.id === input.id);
      Object.assign(existing, input);
      return structuredClone(existing);
    },
    send: async (id, message) => {
      deliveries.push({ mailboxId: id, ...message });
      if (state.sendError) throw state.sendError;
      return { accepted: [message.to], rejected: [], messageId: message.messageId };
    },
  };
  const serviceOptions = {
    path: options.path || ':memory:',
    mailboxes,
    products: () => structuredClone(products),
    loadLeads: async () => {
      if (state.loadGate) await state.loadGate();
      return structuredClone(state.leads);
    },
    businessState: () => state.business,
    now: () => state.clock,
    tickMs: 3600000,
    generator: {
      configured: true,
      generate: async ({ candidate, product }) => ({
        subject: `Window products for ${candidate.companyName}`,
        bodyText: `Hello,\n\nWe supply ${product.englishName}.`,
        sourceIds: candidate.evidence.map((evidence) => evidence.id),
      }),
    },
  };
  const service = new OutreachService(serviceOptions);
  const campaignInput = (overrides = {}) => ({
    name: 'Small first outreach',
    mailboxIds: boxes.map((box) => box.id),
    targetCount: 150,
    intervalSeconds: 30,
    includeExisting: true,
    continuous: false,
    filters: { markets: ['Australia'], grades: [], products: ['pvc', 'roller'] },
    ...overrides,
  });
  return { service, serviceOptions, boxes, products, state, deliveries, campaignInput };
}

async function prepare(h, overrides = {}) {
  const campaign = h.service.saveCampaign(h.campaignInput(overrides));
  h.service.prepare(campaign.id);
  await h.service.preparing.get(campaign.id);
  return h.service.campaign(campaign.id);
}

test('真实预览没有合格样本时拒绝生成，不得回退到虚构卷帘客户', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.service.previewLeads = () => [];
  await assert.rejects(
    previewOutreachTemplate(h.service, {
      step: 0,
      instruction: '',
      mailboxId: 'brand-b',
      category: 'manufacturer',
    }),
    /没有合格样本/,
  );
});

test('无邮箱跳过持久化，重启、恢复及旧计划重扫不恢复，新手动计划可纳入且不消耗名额', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'outreach-skip-'));
  const h = harness({ path: join(directory, 'outreach.sqlite') });
  try {
    h.state.leads = [{ ...buyer(), email: '', contactEvidence: [] }];
    const campaign = await prepare(h, { continuous: true, targetCount: 1 });
    const skipped = h.service.deliveries(campaign.id)[0];
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.reasonCode, 'contact_unverified');
    assert.equal(
      h.service.db.prepare('SELECT count(*) AS n FROM outreach_reservations').get().n,
      0,
    );
    await h.service.close();
    h.service = new OutreachService(h.serviceOptions);
    h.state.leads = [buyer()];
    h.service.activate(campaign.id, campaign.revision);
    await h.service.preparing.get(campaign.id);
    await h.service.tick();
    h.service.pause(campaign.id);
    h.service.activate(campaign.id, campaign.revision);
    await h.service.preparing.get(campaign.id);
    await h.service.tick();
    assert.equal(h.deliveries.length, 0);
    assert.deepEqual(h.service.deliveries(campaign.id), [skipped]);
    h.state.leads.push(buyer('new-customer'));
    h.service.prepare(campaign.id);
    await h.service.preparing.get(campaign.id);
    await h.service.tick();
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0].to, buyer('new-customer').email);
    const next = await prepare(h, { targetCount: 1 });
    h.service.activate(next.id, next.revision);
    await h.service.tick();
    assert.equal(h.deliveries.length, 2);
    assert.equal(h.deliveries[1].to, buyer().email);
    assert.equal(h.service.delivery(skipped.id).status, 'skipped');
  } finally {
    await h.service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('发送前收件邮箱变为非商务地址时跳过，释放占用且不提交邮件', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const campaign = await prepare(h);
  const draft = h.service.deliveries(campaign.id)[0];
  h.state.leads = [{ ...buyer(), email: 'privacy@buyer-one.example.org', contactEvidence: [] }];
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  assert.equal(h.service.delivery(draft.id).status, 'skipped');
  assert.equal(h.service.isReserved(draft.candidate), false);
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.service.campaign(campaign.id).status, 'paused');
  assert.equal(h.service.campaign(campaign.id).lastError, '');
});

test('固定计划因当日额度等待，不产生客户待办，次日仍可按原授权发送', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes[0].dailyLimit = 1;
  h.boxes[1].productIds = [];
  h.boxes[2].productIds = [];
  const first = await prepare(h, { targetCount: 1 });
  h.service.activate(first.id, first.revision);
  await h.service.tick();
  h.state.leads = [buyer('next-day')];
  const second = await prepare(h, { targetCount: 1 });
  assert.equal(h.service.deliveries(second.id).length, 0);
  assert.match(h.service.campaign(second.id).waitingReason, /额度/);
  h.service.activate(second.id, second.revision);
  await h.service.tick();
  assert.equal(h.service.campaign(second.id).status, 'active');
  assert.equal(h.service.withStats(h.service.campaign(second.id)).deliveryGroups.attention, 0);
  h.state.clock += 86400000;
  await h.service.tick();
  await h.service.preparing.get(second.id);
  await h.service.tick();
  await h.service.tick();
  assert.equal(h.deliveries.filter((mail) => mail.to === buyer('next-day').email).length, 1);
});

test('生成前签名配置变化集中显示计划异常，不建立客户需处理记录', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const campaign = h.service.saveCampaign(h.campaignInput());
  const originalGet = h.service.mailboxes.get;
  h.service.mailboxes.get = (id) => ({ ...originalGet(id), signature: '' });
  h.service.prepare(campaign.id);
  await h.service.preparing.get(campaign.id);
  assert.equal(h.service.deliveries(campaign.id).length, 0);
  assert.match(h.service.campaign(campaign.id).waitingReason, /签名/);
  assert.equal(h.service.withStats(h.service.campaign(campaign.id)).deliveryGroups.attention, 0);
  h.service.mailboxes.get = originalGet;
  h.service.prepare(campaign.id);
  await h.service.preparing.get(campaign.id);
  assert.equal(h.service.deliveries(campaign.id, ['draft']).length, 1);
});

test('计划配置异常不会保留旧版空白客户待办', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes.forEach((box) => (box.paused = true));
  const campaign = h.service.saveCampaign(h.campaignInput());
  h.service.putDelivery({
    id: 'old-empty-block',
    campaignId: campaign.id,
    customerId: 'buyer-one',
    mode: 'production',
    status: 'blocked',
    reason: '该产品对应的邮箱已暂停或尚未通过连接验证',
    subject: '',
    bodyText: '',
  });
  h.service.prepare(campaign.id);
  await h.service.preparing.get(campaign.id);
  assert.equal(h.service.delivery('old-empty-block').status, 'cancelled');
  assert.equal(h.service.withStats(h.service.campaign(campaign.id)).deliveryGroups.attention, 0);
  assert.match(h.service.campaign(campaign.id).waitingReason, /邮箱/);
});

async function internalTest(h, key = 'internal-test-unique-key') {
  const result = h.service.internalTest({
    confirmed: true,
    idempotencyKey: key,
    expectedMailboxIds: h.boxes
      .filter((box) => box.configured && !box.paused && box.smtpStatus === 'connected')
      .map((box) => box.id),
  });
  await h.service.tick();
  return h.service.detail(result.campaign.id);
}

async function runInternalTest(h) {
  await internalTest(h);
  for (const row of h.service
    .deliveries()
    .filter((row) => row.mode === 'internal_test' && row.status === 'accepted'))
    h.service.confirmInternalReceipt(row.id);
  h.state.clock += 31000;
}

test('发送时段拒绝无效时间和空时段', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  for (const [start, end] of [
    ['99:99', '12:00'],
    ['24:00', '12:00'],
    ['09:60', '12:00'],
    ['12:00', '12:00'],
  ])
    assert.throws(
      () =>
        h.service.saveCampaign(
          h.campaignInput({ sendWindow: { start, end, timezone: 'Asia/Shanghai' } }),
        ),
      { status: 400 },
    );
  for (const timezone of [undefined, ''])
    assert.throws(
      () =>
        h.service.saveCampaign(
          h.campaignInput({ sendWindow: { start: '11:00', end: '13:00', timezone } }),
        ),
      { status: 400 },
    );
  const campaign = h.service.saveCampaign(
    h.campaignInput({ sendWindow: { start: '11:00', end: '13:00', timezone: 'Asia/Shanghai' } }),
  );
  assert.equal(h.service.inWindow(campaign), true);
  h.state.clock = Date.parse('2026-10-26T16:30:00Z');
  const overnight = h.service.saveCampaign(
    h.campaignInput({ sendWindow: { start: '23:00', end: '01:00', timezone: 'Asia/Shanghai' } }),
  );
  assert.equal(h.service.inWindow(overnight), true);
});

test('旧计划保存的无效发送时段不会进入发送窗口', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const campaign = h.service.saveCampaign(h.campaignInput());
  for (const sendWindow of [
    { start: '00:00', end: '99:99', timezone: 'Asia/Shanghai' },
    { start: '00:00', end: '23:59' },
    { start: '00:00', end: '00:00', timezone: 'Asia/Shanghai' },
    { start: '00:00', end: '23:59', timezone: 'Invalid/Zone' },
  ]) {
    h.service.putCampaign({ ...campaign, sendWindow });
    assert.equal(h.service.inWindow(h.service.campaign(campaign.id)), false);
  }
});

test('网页编辑未提交客户名单时保留范围，只有显式空名单才解除限制', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.state.leads = [buyer('first'), buyer('second')];
  const created = h.service.saveCampaign(h.campaignInput({ customerIds: ['first'] }));
  const edited = h.service.saveCampaign(
    h.campaignInput({ name: 'Edited in web', revision: created.revision }),
    created.id,
  );
  assert.deepEqual(edited.customerIds, ['first']);
  assert.deepEqual(
    (await h.service.candidates(edited)).eligible.map((row) => row.customerId),
    ['first'],
  );
  const cleared = h.service.saveCampaign(
    h.campaignInput({ revision: edited.revision, customerIds: [] }),
    edited.id,
  );
  assert.deepEqual(
    (await h.service.candidates(cleared)).eligible.map((row) => row.customerId).sort(),
    ['first', 'second'],
  );
});

test('编辑计划保留发送时段，只有显式 null 才清除', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const sendWindow = { start: '23:00', end: '01:00', timezone: 'Asia/Shanghai' };
  const created = h.service.saveCampaign(h.campaignInput({ sendWindow }));
  const edited = h.service.saveCampaign(
    h.campaignInput({ revision: created.revision }),
    created.id,
  );
  assert.deepEqual(edited.sendWindow, sendWindow);
  const cleared = h.service.saveCampaign(
    h.campaignInput({ revision: edited.revision, sendWindow: null }),
    edited.id,
  );
  assert.equal(cleared.sendWindow, null);
  h.service.putCampaign({ ...cleared, sendWindow: { ...sendWindow, start: '99:99' } });
  assert.throws(
    () => h.service.saveCampaign(h.campaignInput({ revision: cleared.revision }), cleared.id),
    { status: 400 },
  );
  const recovered = h.service.saveCampaign(
    h.campaignInput({ revision: cleared.revision, sendWindow: null }),
    cleared.id,
  );
  assert.equal(recovered.sendWindow, null);
});

test('自动开发使用同域旧地址并跳过无依据跨域邮箱，带固定签名发送且总量严格停在20封', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.state.leads = Array.from({ length: 25 }, (_, i) => buyer(`automatic-${i}`));
  for (const lead of h.state.leads) lead.contactEvidence = [];
  h.state.leads[0].email = 'buyer@gmail.com';
  h.service.generator.generate = async ({ candidate, product, campaign }) => ({
    subject: `Supply cooperation with ${candidate.companyName}`,
    bodyText: `Hello,\n\nWe supply ${product.englishName}. Would you be open to discussing supply cooperation?`,
    sourceIds: candidate.evidence.map((e) => e.id),
    factIds: eligibleOutreachFacts(product, campaign).map((f) => f.id),
  });
  const c = h.service.saveCampaign(h.campaignInput({ targetCount: 20 }));
  h.service.activate(c.id, c.revision);
  await h.service.preparing.get(c.id);
  for (let i = 0; i < 25; i++) {
    h.state.clock += 31000;
    await h.service.tick();
  }
  const detail = h.service.detail(c.id);
  assert.equal(detail.campaign.status, 'completed');
  assert.equal(detail.campaign.stats.accepted, 20);
  assert.equal(detail.campaign.stats.draft, 0);
  assert.equal(h.deliveries.length, 20);
  assert.equal(new Set(h.deliveries.map((d) => d.to)).size, 20);
  assert.ok(h.deliveries.every((row) => row.to !== 'buyer@gmail.com'));
  assert.equal(
    h.service.deliveries(c.id).find((row) => row.customerId === 'automatic-0').reasonCode,
    'contact_unverified',
  );
  assert.ok(
    h.deliveries.every((d) => d.text.endsWith(h.boxes.find((b) => b.id === d.mailboxId).signature)),
  );
});

test('自动计划客户不足时暂停并报告实际数量，不把不足20封显示为完成', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.service.generator.generate = async () => ({
    subject: 'Supply cooperation',
    bodyText: 'Hello, would you like to discuss window furnishings?',
  });
  const c = h.service.saveCampaign(h.campaignInput({ targetCount: 20 }));
  h.service.activate(c.id, c.revision);
  await h.service.preparing.get(c.id);
  await h.service.tick();
  assert.equal(h.service.campaign(c.id).status, 'paused');
  assert.match(h.service.campaign(c.id).lastError, /1 \/ 20/);
  assert.equal(h.deliveries.length, 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const signatureDesign = () => ({
  closing: 'Best regards,',
  companyName: 'Example & Co.',
  address: 'Dongguan, China',
  website: 'https://brand-a.example.org',
  logo: {
    name: 'logo.png',
    contentType: 'image/png',
    contentBase64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=',
  },
  logoWidth: 160,
});

test('开发信与内部测试保留排版签名及Logo，生成正文按纯文本转义', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes[0].displayName = 'Alice <Sales>';
  h.boxes[0].signatureDesign = signatureDesign();
  await runInternalTest(h);
  const testMail = h.deliveries.find((row) => row.mailboxId === h.boxes[0].id);
  assert.ok(testMail.text.endsWith(h.boxes[0].email));
  assert.match(testMail.html, /<strong>Alice &lt;Sales&gt;<\/strong>/u);
  assert.match(testMail.html, /<img src="data:image\/png;base64,/u);
  h.service.generator.generate = async () => ({
    subject: 'A business introduction',
    bodyText: 'Hello <buyer>,\nApproved & available.',
    sourceIds: [],
  });
  const campaign = await prepare(h);
  const draft = h.service.deliveries(campaign.id)[0];
  assert.equal(draft.status, 'draft');
  assert.match(draft.bodyHtml, /^Hello &lt;buyer&gt;,<br>Approved &amp; available\./u);
  assert.match(draft.bodyHtml, /<strong>Alice &lt;Sales&gt;<\/strong>/u);
  assert.match(draft.bodyHtml, /<a href="https:\/\/brand-a\.example\.org\/">/u);
  assert.equal(draft.bodyText.match(/Best regards,/gu).length, 1);
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  const sent = h.deliveries.find((row) => row.to === draft.to);
  assert.equal(sent.html, draft.bodyHtml);
  assert.equal(sent.text, draft.bodyText);
});

test('修改Logo后阻止旧签名草稿发送', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes[0].signatureDesign = signatureDesign();
  await runInternalTest(h);
  const campaign = await prepare(h);
  const draft = h.service.deliveries(campaign.id)[0];
  const previousText = h.boxes[0].signature;
  h.boxes[0].signatureDesign.logo.contentBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  assert.equal(h.boxes[0].signature, previousText);
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  const blocked = h.service.delivery(draft.id);
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /签名/u);
  assert.equal(blocked.bodyHtml, draft.bodyHtml);
  assert.equal(
    h.deliveries.some((row) => row.to === draft.to),
    false,
  );
});

test('内部测试只在预览过的已配置公司邮箱间形成环，重试不重发', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  assert.throws(
    () => h.service.internalTest({ confirmed: false, idempotencyKey: 'internal-test-key' }),
    { status: 400 },
  );
  assert.throws(
    () =>
      h.service.internalTest({
        confirmed: true,
        idempotencyKey: 'internal-test-key',
        expectedMailboxIds: ['outdated'],
      }),
    { status: 409 },
  );
  const result = await internalTest(h);
  assert.equal(result.campaign.status, 'completed');
  assert.equal(h.deliveries.length, 3);
  assert.deepEqual(
    h.deliveries.map((item) => item.to),
    [h.boxes[1].email, h.boxes[2].email, h.boxes[0].email],
  );
  assert.ok(h.deliveries.every((item) => item.subject.startsWith('[ShadeFlow-Test:')));
  assert.ok(h.deliveries.every((item) => !item.to.includes('buyer-one')));
  const retry = await internalTest(h);
  assert.equal(retry.campaign.id, result.campaign.id);
  assert.equal(h.deliveries.length, 3);
});

test('未连接邮箱不参与内部测试，少于两个有效邮箱拒绝开始', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes[2].configured = false;
  const result = await internalTest(h);
  assert.equal(result.deliveries.length, 2);
  assert.ok(result.deliveries.every((row) => row.to !== h.boxes[2].email));
  h.boxes[1].smtpStatus = 'error';
  assert.throws(
    () => h.service.internalTest({ confirmed: true, idempotencyKey: 'another-internal-key' }),
    { status: 400 },
  );
});

test('启动当前版本直接生成发送，无需内部试发或样稿审批', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const campaign = await prepare(h);
  assert.equal(h.service.detail(campaign.id).campaign.stats.draft, 1);
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  const detail = h.service.detail(campaign.id);
  assert.equal(detail.deliveries[0].status, 'accepted');
  assert.equal(detail.campaign.stats.accepted, 1);
  assert.equal(h.deliveries.filter((row) => row.to === 'info@buyer-one.example.org').length, 1);
  assert.equal(detail.deliveries[0].bodyText.endsWith(h.boxes[0].signature), true);
  assert.equal(detail.deliveries[0].status === 'delivered', false);
});

test('另一计划、客户业务既有沟通和勿再联系状态不能绕过企业首封去重', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  await runInternalTest(h);
  const first = await prepare(h);
  h.service.activate(first.id, first.revision);
  await h.service.tick();
  const second = await prepare(h, { name: 'Second campaign' });
  assert.equal(h.service.detail(second.id).campaign.stats.draft, 0);
  assert.equal(h.service.detail(second.id).campaign.stats.skipped, 1);
  h.state.leads = [buyer('known-contact'), buyer('suppressed-company'), buyer('manual-contact')];
  h.state.business = {
    messages: [{ customerId: 'known-contact', deliveryStatus: 'sent' }],
    customerContexts: [{ customerId: 'manual-contact', doNotContact: true }],
  };
  h.service.suppress({ domain: 'suppressed-company.example.org', reason: 'Do not contact' });
  const third = await prepare(h, { name: 'Known business contact campaign' });
  assert.equal(h.service.detail(third.id).campaign.stats.draft, 0);
  assert.equal(h.service.detail(third.id).campaign.stats.skipped, 3);
  assert.equal(h.deliveries.filter((row) => !row.subject.startsWith('[ShadeFlow-Test:')).length, 1);
});

test('重启后发送中的记录转为待核实，保留企业占用且不自动重发', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'outreach-restart-'));
  const h = harness({ path: join(directory, 'outreach.sqlite') });
  let reopened;
  try {
    await runInternalTest(h);
    const campaign = await prepare(h);
    const delivery = h.service.deliveries(campaign.id)[0];
    h.service.putCampaign({ ...h.service.campaign(campaign.id), status: 'active' });
    h.service.putDelivery({
      ...delivery,
      status: 'sending',
      attemptedAt: new Date(h.state.clock).toISOString(),
    });
    await h.service.close();
    const before = h.deliveries.length;
    reopened = new OutreachService(h.serviceOptions);
    assert.equal(reopened.delivery(delivery.id).status, 'unknown');
    await reopened.tick();
    assert.equal(h.deliveries.length, before);
    assert.equal(reopened.isReserved(delivery.candidate), true);
  } finally {
    if (!h.service.closed) await h.service.close();
    await reopened?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('覆盖相同产品的邮箱按已有发送量分配，独立额度包含公司测试信', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes[0].dailyLimit = 2;
  h.boxes[1].dailyLimit = 4;
  h.state.leads = [
    buyer('shutter-a'),
    buyer('shutter-b'),
    buyer('roller-a', 'roller blinds'),
    buyer('roller-b', 'roller blinds'),
  ];
  await runInternalTest(h);
  const campaign = await prepare(h);
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  h.state.clock += 31000;
  await h.service.tick();
  const rows = h.service.deliveries(campaign.id);
  assert.equal(
    rows.filter((row) => row.mailboxId === 'brand-a' && row.status === 'accepted').length,
    1,
  );
  assert.equal(
    rows.filter((row) => row.mailboxId === 'brand-a' && row.status === 'queued').length,
    0,
  );
  assert.equal(
    rows.filter((row) => row.mailboxId === 'brand-b' && row.status === 'accepted').length,
    2,
  );
  assert.equal(
    rows.filter((row) => row.mailboxId === 'brand-c' && row.status === 'accepted').length,
    1,
  );
  assert.equal(rows.filter((row) => row.status === 'accepted').length, 4);
});

test('暂停单个邮箱时其他邮箱继续，恢复后仍用草稿已确定的账号发信', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.state.leads = [buyer('shutter-a'), buyer('roller-a', 'roller blinds')];
  await runInternalTest(h);
  const campaign = await prepare(h, {
    sendWindow: { start: '13:00', end: '14:00', timezone: 'Asia/Shanghai' },
  });
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  h.boxes[0].paused = true;
  h.state.clock += 3600000;
  await h.service.tick();
  assert.equal(
    h.service.deliveries(campaign.id).find((row) => row.mailboxId === 'brand-a').status,
    'queued',
  );
  assert.equal(
    h.service.deliveries(campaign.id).find((row) => row.mailboxId === 'brand-b').status,
    'accepted',
  );
  h.boxes[0].paused = false;
  h.state.clock += 31000;
  await h.service.tick();
  assert.equal(
    h.service.deliveries(campaign.id).find((row) => row.mailboxId === 'brand-a').status,
    'accepted',
  );
});

test('跨计划分配计入已保留草稿，但待发草稿复核不因邮箱负载改变而被换号或阻止', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  await runInternalTest(h);
  h.boxes.forEach((box) => {
    box.dailyLimit = 2;
  });
  const first = await prepare(h);
  h.state.leads.push(buyer('second-buyer'), buyer('third-buyer'), buyer('fourth-buyer'));
  const second = await prepare(h, { name: 'Further pool allocation' });
  const drafts = h.service.deliveries(second.id).filter((row) => row.status === 'draft');
  assert.deepEqual(
    drafts.map((row) => row.mailboxId),
    ['brand-b', 'brand-c'],
  );
  assert.equal(
    h.service.deliveries(second.id).some((row) => row.customerId === 'fourth-buyer'),
    false,
  );
  assert.match(h.service.campaign(second.id).waitingReason, /额度/);
  // Allocation priority does not change an already prepared sender.
  h.boxes[0].priority = 999;
  h.service.activate(first.id, first.revision);
  await h.service.tick();
  assert.equal(h.service.deliveries(first.id)[0].status, 'accepted');
  assert.equal(h.service.deliveries(first.id)[0].mailboxId, 'brand-a');
  h.service.activate(second.id, second.revision);
  await h.service.tick();
  assert.equal(
    h.service.deliveries(second.id).filter((row) => row.status === 'accepted').length,
    2,
  );
});

test('计划明确产品集合与邮箱范围共同决定首封资格，品类只作选择分组', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.products[0].category = 'ventilation';
  h.products[1].category = 'indoor';
  h.state.leads = [buyer('shutter'), buyer('roller', 'roller blinds')];
  const campaign = await prepare(h, { filters: { products: ['roller'], categories: ['indoor'] } });
  assert.deepEqual(campaign.filters.categories, []);
  assert.deepEqual(campaign.filters.products, ['roller']);
  const drafts = h.service.deliveries(campaign.id).filter((row) => row.status === 'draft');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].customerId, 'roller');
  assert.equal(drafts[0].mailboxId, 'brand-a');
});

test('已准备首信更换官网时撤回旧正文，不发送旧品牌草稿', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  await runInternalTest(h);
  const campaign = await prepare(h);
  const draft = h.service.deliveries(campaign.id)[0];
  h.boxes.find((box) => box.id === draft.mailboxId).website = 'https://other-brand.example.org';
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  assert.notEqual(h.service.delivery(draft.id).status, 'accepted');
  assert.equal(
    h.deliveries.some((row) => row.to === draft.to),
    false,
  );
});

test('已审核草稿的产品范围被撤回时停止发送，不切换到其他邮箱', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  await runInternalTest(h);
  const campaign = await prepare(h);
  const draft = h.service.deliveries(campaign.id)[0];
  h.boxes.find((box) => box.id === draft.mailboxId).productIds = ['roller'];
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  assert.equal(h.service.delivery(draft.id).status, 'blocked');
  assert.match(h.service.delivery(draft.id).reason, /产品范围/);
  assert.equal(
    h.deliveries.some((row) => row.to === draft.to),
    false,
  );
});

test('三个邮箱各自经营不同产品时，客户按产品分到对应业务身份', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes[0].productIds = ['pvc'];
  h.boxes[1].productIds = ['roller'];
  h.boxes[2].productIds = [];
  h.state.leads = [buyer('shutter'), buyer('roller', 'roller blinds')];
  const campaign = await prepare(h);
  const drafts = h.service.deliveries(campaign.id).filter((row) => row.status === 'draft');
  assert.deepEqual(
    drafts.map((row) => [row.customerId, row.mailboxId]),
    [
      ['shutter', 'brand-a'],
      ['roller', 'brand-b'],
    ],
  );
});

test('两个计划同时准备时共享邮箱额度不会被重复分配', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes.forEach((box) => {
    box.dailyLimit = 1;
  });
  h.state.leads = [buyer('first'), buyer('second')];
  const campaigns = ['first', 'second'].map((customerId) =>
    h.service.saveCampaign(h.campaignInput({ customerIds: [customerId] })),
  );
  for (const campaign of campaigns) h.service.prepare(campaign.id);
  await Promise.all(campaigns.map((campaign) => h.service.preparing.get(campaign.id)));
  assert.deepEqual(
    campaigns.map((campaign) => h.service.deliveries(campaign.id)[0].mailboxId),
    ['brand-a', 'brand-b'],
  );
});

test('已启动计划自动接入之后入库的待开发客户，并在目标数量停止', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  await runInternalTest(h);
  const campaign = await prepare(h, { targetCount: 3, continuous: true });
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  await h.service.preparing.get(campaign.id);
  assert.equal(h.service.detail(campaign.id).campaign.stats.accepted, 1);
  h.state.leads.push(buyer('later-two'), buyer('later-three'), buyer('beyond-target'));
  h.state.clock += 61000;
  await h.service.tick();
  await h.service.preparing.get(campaign.id);
  assert.equal(h.service.detail(campaign.id).campaign.stats.queued, 2);
  await h.service.tick();
  assert.equal(h.service.detail(campaign.id).campaign.stats.accepted, 3);
  assert.equal(h.service.campaign(campaign.id).status, 'completed');
  assert.equal(
    h.deliveries.some((row) => row.to === 'info@beyond-target.example.org'),
    false,
  );
});

test('产品匹配不足跳过本次，新计划可重新评估，已有样稿不误报', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.state.leads.push(buyer('buyer-two'));
  h.products[0].englishName = '';
  const campaign = await prepare(h);
  assert.equal(h.service.detail(campaign.id).campaign.stats.draft, 0);
  assert.equal(h.service.detail(campaign.id).campaign.stats.skipped, 2);
  assert.equal(h.service.campaign(campaign.id).lastError, '');
  assert.doesNotMatch(h.service.campaign(campaign.id).lastError, /没有符合条件/);
  h.products[0].englishName = 'PVC shutters';
  const updated = h.service.saveCampaign(
    h.campaignInput({ revision: campaign.revision }),
    campaign.id,
  );
  h.service.prepare(updated.id);
  await h.service.preparing.get(updated.id);
  assert.equal(h.service.detail(updated.id).campaign.stats.draft, 0);
  assert.equal(h.service.detail(updated.id).campaign.stats.skipped, 2);
  const next = await prepare(h, { name: 'New campaign' });
  assert.equal(h.service.detail(next.id).campaign.stats.draft, 2);
  h.service.prepare(updated.id);
  await h.service.preparing.get(updated.id);
  assert.equal(h.service.campaign(updated.id).lastError, '');
  assert.equal(h.deliveries.length, 0);
});

test('连续计划生成失败重试18轮只更新原记录，取消后不再重试', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  let attempts = 0;
  h.state.leads.push(buyer('ready-buyer'));
  const generate = h.service.generator.generate;
  h.service.generator.generate = async (input) => {
    if (input.candidate.customerId === 'ready-buyer') return generate(input);
    attempts++;
    throw Object.assign(new Error('模型暂不可用'), { status: 503 });
  };
  const campaign = await prepare(h, { continuous: true });
  const original = h.service.deliveries(campaign.id)[0];
  h.service.activate(campaign.id, campaign.revision);
  for (let i = 0; i < 18; i++) {
    h.state.clock += 61000;
    await h.service.tick();
    await h.service.preparing.get(campaign.id);
  }
  assert.ok(attempts >= 19);
  assert.deepEqual(
    h.service
      .deliveries(campaign.id)
      .filter((row) => row.customerId === original.customerId)
      .map((row) => row.id),
    [original.id],
  );
  assert.equal(h.service.delivery(original.id).reason, '模型暂不可用');
  h.service.cancel(campaign.id, campaign.revision, true);
  const before = attempts;
  h.state.clock += 61000;
  await h.service.tick();
  assert.equal(attempts, before);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].to, 'info@ready-buyer.example.org');
});

test('客户库补充邮箱后旧计划重新准备仍保留跳过，且不占用待处理计数', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const email = h.state.leads[0].email;
  h.state.leads[0].email = '';
  h.state.leads[0].contactEvidence = [];
  const campaign = await prepare(h);
  assert.equal(h.service.detail(campaign.id).campaign.stats.skipped, 1);
  h.state.leads[0].email = email;
  h.service.prepare(campaign.id);
  await h.service.preparing.get(campaign.id);
  const detail = h.service.detail(campaign.id);
  assert.equal(detail.campaign.stats.blocked, 0);
  assert.equal(detail.campaign.stats.draft, 0);
  assert.equal(detail.campaign.stats.skipped, 1);
  assert.equal(detail.campaign.deliveryGroups.attention, 0);
  assert.equal(detail.deliveries.length, 1);
});

test('发送前异步核对期间修改邮箱身份或计划，旧草稿不能继续发送', async (t) => {
  for (const mutation of ['mailbox', 'campaign']) {
    const h = harness();
    t.after(() => h.service.close());
    await runInternalTest(h);
    const campaign = await prepare(h);
    const entered = deferred(),
      release = deferred();
    h.state.loadGate = () => {
      entered.resolve();
      return release.promise;
    };
    h.service.activate(campaign.id, campaign.revision);
    await entered.promise;
    try {
      if (mutation === 'mailbox') h.boxes[0].signature = 'A different sender identity';
      else {
        h.service.pause(campaign.id);
        h.service.saveCampaign(
          h.campaignInput({ name: 'Changed plan', revision: campaign.revision }),
          campaign.id,
        );
      }
    } finally {
      release.resolve();
    }
    await h.service.tick();
    assert.equal(h.deliveries.filter((row) => row.to === 'info@buyer-one.example.org').length, 0);
    assert.notEqual(h.service.deliveries(campaign.id)[0].status, 'accepted');
  }
});

test('SMTP结果不明确时暂停该邮箱，未知记录不可作为自动重试依据', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  await runInternalTest(h);
  const campaign = await prepare(h);
  h.state.sendError = Object.assign(new Error('Connection dropped after DATA'), {
    code: 'ECONNECTION',
  });
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  assert.equal(h.service.deliveries(campaign.id)[0].status, 'unknown');
  assert.equal(h.boxes[0].paused, true);
  h.boxes[0].paused = false;
  h.state.clock += 31000;
  await h.service.tick();
  assert.equal(h.deliveries.filter((row) => row.to === 'info@buyer-one.example.org').length, 1);
});

test('初次准备等待客户库时暂停计划，读取完成不能恢复旧运行状态', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const entered = deferred(),
    release = deferred();
  h.state.loadGate = () => {
    entered.resolve();
    return release.promise;
  };
  const campaign = h.service.saveCampaign(h.campaignInput());
  h.service.prepare(campaign.id);
  await entered.promise;
  h.service.pause(campaign.id);
  release.resolve();
  await h.service.preparing.get(campaign.id);
  assert.equal(h.service.campaign(campaign.id).status, 'paused');
  assert.equal(h.service.deliveries(campaign.id).filter((row) => row.status === 'draft').length, 0);
});

test('取消触达计划需要确认当前版本，取消后不可恢复且重复请求不会改变记录', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const campaign = h.service.saveCampaign(h.campaignInput());
  assert.throws(() => h.service.cancel(campaign.id, campaign.revision, false), { status: 400 });
  assert.throws(() => h.service.cancel(campaign.id, campaign.revision + 1, true), { status: 409 });
  assert.equal(h.service.campaign(campaign.id).status, 'draft');
  const cancelled = h.service.cancel(campaign.id, campaign.revision, true);
  assert.equal(cancelled.campaign.status, 'cancelled');
  assert.equal(cancelled.campaign.revision, campaign.revision + 1);
  assert.equal(cancelled.campaign.approvedRevision, null);
  assert.equal(cancelled.campaign.cancelledAt, new Date(h.state.clock).toISOString());
  h.state.clock += 1000;
  assert.deepEqual(h.service.cancel(campaign.id, campaign.revision, true), cancelled);
  for (const action of [
    () =>
      h.service.saveCampaign(
        h.campaignInput({ revision: cancelled.campaign.revision }),
        campaign.id,
      ),
    () => h.service.prepare(campaign.id),
    () => h.service.activate(campaign.id, cancelled.campaign.revision),
    () => h.service.pause(campaign.id),
  ])
    assert.throws(action, { status: 409 });
  await h.service.tick();
  assert.equal(h.deliveries.length, 0);
  assert.equal(h.service.campaign(campaign.id).status, 'cancelled');
});

test('草稿、准备中、已就绪、运行中和暂停计划均可取消，已完成计划不可取消', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  for (const status of ['draft', 'preparing', 'ready', 'active', 'paused', 'completed']) {
    const campaign = h.service.saveCampaign(h.campaignInput({ name: status }));
    h.service.putCampaign({ ...campaign, status });
    if (status === 'completed') {
      assert.throws(() => h.service.cancel(campaign.id, campaign.revision, true), { status: 409 });
      assert.equal(h.service.campaign(campaign.id).status, 'completed');
    } else
      assert.equal(
        h.service.cancel(campaign.id, campaign.revision, true).campaign.status,
        'cancelled',
      );
  }
});

test('取消只释放未发送客户的占用，保留已提交、失败和结果待核实记录', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const statuses = ['draft', 'queued', 'blocked', 'accepted', 'sending', 'failed', 'unknown'];
  h.state.leads = statuses.map((status) => buyer(status));
  const campaign = await prepare(h);
  const rows = h.service.deliveries(campaign.id);
  assert.equal(rows.length, statuses.length);
  rows.forEach((row, index) => h.service.putDelivery({ ...row, status: statuses[index] }));
  const before = h.service.deliveries(campaign.id);
  const result = h.service.cancel(campaign.id, campaign.revision, true);
  result.deliveries.forEach((row, index) => {
    if (index < 3) {
      assert.equal(row.status, 'cancelled');
      assert.equal(h.service.isReserved(row.candidate), false);
    } else {
      assert.deepEqual(row, before[index]);
      assert.equal(h.service.isReserved(row.candidate), true);
    }
  });
  const another = await prepare(h, { name: 'New outreach plan' });
  assert.deepEqual(
    h.service
      .deliveries(another.id)
      .filter((row) => row.status === 'draft')
      .map((row) => row.customerId),
    ['draft', 'queued', 'blocked'],
  );
});

test('读取客户库期间取消，读取完成或失败都不会恢复计划或新建草稿', async (t) => {
  for (const rejects of [false, true]) {
    const h = harness();
    t.after(() => h.service.close());
    const entered = deferred(),
      release = deferred();
    h.state.loadGate = async () => {
      entered.resolve();
      await release.promise;
      if (rejects) throw new Error('Customer load failed after cancellation');
    };
    const campaign = h.service.saveCampaign(h.campaignInput());
    h.service.prepare(campaign.id);
    await entered.promise;
    const cancelled = h.service.cancel(campaign.id, campaign.revision, true);
    release.resolve();
    await h.service.preparing.get(campaign.id);
    assert.deepEqual(h.service.detail(campaign.id), cancelled);
  }
});

test('生成样稿期间取消，模型返回或报错均不能复活草稿及客户占用', async (t) => {
  for (const rejects of [false, true]) {
    const h = harness();
    t.after(() => h.service.close());
    h.state.leads = ['one', 'two', 'three', 'four'].map((id) => buyer(id));
    const entered = deferred(),
      release = deferred();
    const generate = h.service.generator.generate;
    let generated = 0;
    h.service.generator.generate = async (input) => {
      generated++;
      entered.resolve();
      await release.promise;
      if (rejects) throw new Error('Generation failed after cancellation');
      return generate(input);
    };
    const campaign = h.service.saveCampaign(h.campaignInput());
    h.service.prepare(campaign.id);
    await entered.promise;
    const cancelled = h.service.cancel(campaign.id, campaign.revision, true);
    assert.throws(() => h.service.prepare(campaign.id), { status: 409 });
    release.resolve();
    await h.service.preparing.get(campaign.id);
    assert.equal(generated, 3);
    assert.deepEqual(h.service.detail(campaign.id), cancelled);
    assert.ok(
      cancelled.deliveries.every(
        (row) => row.status === 'cancelled' && !h.service.isReserved(row.candidate),
      ),
    );
    h.service.generator.generate = generate;
    const another = await prepare(h);
    assert.equal(h.service.detail(another.id).campaign.stats.draft, 4);
  }
});

test('候选读取完成与写入之间取消，不再写入待处理客户记录', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.state.leads[0].email = '';
  const campaign = h.service.saveCampaign(h.campaignInput());
  const candidates = h.service.candidates.bind(h.service);
  h.service.candidates = async (...args) => {
    const result = await candidates(...args);
    queueMicrotask(() => h.service.cancel(campaign.id, campaign.revision, true));
    return result;
  };
  h.service.prepare(campaign.id);
  await h.service.preparing.get(campaign.id);
  assert.equal(h.service.campaign(campaign.id).status, 'cancelled');
  assert.deepEqual(h.service.deliveries(campaign.id), []);
});

test('发送前异步核对期间取消，核对返回或报错均不发信且保留取消状态', async (t) => {
  for (const rejects of [false, true]) {
    const h = harness();
    t.after(() => h.service.close());
    await runInternalTest(h);
    const campaign = await prepare(h);
    const entered = deferred(),
      release = deferred();
    h.state.loadGate = async () => {
      entered.resolve();
      await release.promise;
      if (rejects) throw new Error('Send check failed after cancellation');
    };
    h.service.activate(campaign.id, campaign.revision);
    await entered.promise;
    const cancelled = h.service.cancel(campaign.id, campaign.revision, true);
    release.resolve();
    await h.service.tick();
    assert.deepEqual(h.service.detail(campaign.id), cancelled);
    assert.equal(
      h.deliveries.filter((row) => !row.subject.startsWith('[ShadeFlow-Test:')).length,
      0,
    );
  }
});

test('取消保留正在提交SMTP邮件的真实结果，停止同一队列快照中后续邮件', async (t) => {
  for (const rejects of [false, true]) {
    const h = harness();
    t.after(() => h.service.close());
    await runInternalTest(h);
    h.state.leads = [buyer('first'), buyer('second')];
    const campaign = await prepare(h);
    const entered = deferred(),
      release = deferred();
    const send = h.service.mailboxes.send;
    let submitted = 0;
    h.service.mailboxes.send = async (...args) => {
      submitted++;
      entered.resolve();
      await release.promise;
      if (rejects) throw Object.assign(new Error('SMTP outcome unknown'), { code: 'ECONNECTION' });
      return send(...args);
    };
    h.service.activate(campaign.id, campaign.revision);
    await entered.promise;
    const cancelled = h.service.cancel(campaign.id, campaign.revision, true);
    assert.deepEqual(
      cancelled.deliveries.map((row) => row.status),
      ['sending', 'cancelled'],
    );
    release.resolve();
    await h.service.tick();
    const result = h.service.detail(campaign.id);
    assert.equal(result.campaign.status, 'cancelled');
    assert.deepEqual(
      result.deliveries.map((row) => row.status),
      [rejects ? 'unknown' : 'accepted', 'cancelled'],
    );
    assert.equal(submitted, 1);
    assert.equal(h.service.isReserved(result.deliveries[0].candidate), true);
    assert.equal(h.service.isReserved(result.deliveries[1].candidate), false);
    h.state.clock += 61000;
    await h.service.tick();
    assert.equal(submitted, 1);
  }
});

test('服务重启保留取消终态和未发送记录，提交中邮件转为待核实且不会重发', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'outreach-cancel-restart-'));
  const h = harness({ path: join(directory, 'outreach.sqlite') });
  let reopened;
  try {
    h.state.leads = [buyer('pending'), buyer('not-sent')];
    const campaign = await prepare(h);
    const pending = h.service.deliveries(campaign.id)[0];
    h.service.putDelivery({ ...pending, status: 'sending' });
    h.service.cancel(campaign.id, campaign.revision, true);
    await h.service.close();
    reopened = new OutreachService(h.serviceOptions);
    assert.equal(reopened.campaign(campaign.id).status, 'cancelled');
    assert.deepEqual(
      reopened.deliveries(campaign.id).map((row) => row.status),
      ['unknown', 'cancelled'],
    );
    assert.equal(reopened.isReserved(pending.candidate), true);
    await reopened.tick();
    assert.equal(h.deliveries.length, 0);
    assert.throws(() => reopened.pause(campaign.id), { status: 409 });
  } finally {
    if (!h.service.closed) await h.service.close();
    await reopened?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function materialHarness(t) {
  const h = harness();
  t.after(() => h.service.close());
  await runInternalTest(h);
  const product = h.products[0];
  product.category = 'ventilation';
  h.service.generator.generate = async ({ product, campaign, candidate, now }) => {
    const facts = eligibleOutreachFacts(product, campaign, now);
    return {
      subject: 'PVC shutters',
      bodyText: facts.map((f) => [f.text, f.conditions].filter(Boolean).join(' ')).join('\n\n'),
      factIds: facts.map((f) => f.id),
      sourceIds: candidate.evidence.map((f) => f.id),
    };
  };
  const campaign = await prepare(h);
  const original = h.service.deliveries(campaign.id)[0];
  h.boxes.find((box) => box.id === original.mailboxId).dailyLimit = 1;
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  h.boxes.find((box) => box.id === original.mailboxId).dailyLimit = 50;
  return { ...h, campaign, product, original };
}

test('确认新资料后在原计划授权内自动重做未发邮件，保留原邮箱和旧文案', async (t) => {
  const h = await materialHarness(t);
  h.product.version++;
  // Other eligible accounts have capacity; refreshing must preserve the chosen account.
  h.boxes.find((box) => box.id === h.original.mailboxId).dailyLimit = 2;
  await h.service.tick();
  await h.service.preparing.get(h.campaign.id);
  const rows = h.service.deliveries(h.campaign.id);
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[0].productVersion, 1);
  const fresh = rows.find((row) => row.status === 'queued');
  assert.equal(fresh.mailboxId, h.original.mailboxId);
  assert.equal(fresh.replacesDeliveryId, h.original.id);
  assert.equal(fresh.productVersion, 2);
  assert.equal(h.service.campaign(h.campaign.id).approvedRevision, h.campaign.revision);
  await h.service.tick();
  assert.equal(h.service.delivery(fresh.id).status, 'accepted');
  const sentSnapshot = structuredClone(h.service.delivery(fresh.id));
  h.product.version++;
  h.service.refreshProductMaterials();
  assert.deepEqual(h.service.delivery(fresh.id), sentSnapshot);
});

test('产品身份或品牌范围改变不能继承自动授权，资料未确认期间也不发送', async (t) => {
  for (const change of ['draft', 'identity', 'brand']) {
    const h = await materialHarness(t);
    h.product.version++;
    if (change === 'draft') h.product.status = 'draft';
    if (change === 'identity') h.product.englishName = 'Aluminium shutters';
    if (change === 'brand') h.product.brands = ['A different brand'];
    await h.service.tick();
    await h.service.preparing.get(h.campaign.id);
    assert.equal(h.service.delivery(h.original.id).status, 'blocked', change);
    assert.equal(h.service.campaign(h.campaign.id).status, 'active', change);
    assert.equal(h.deliveries.filter((row) => row.to === h.original.to).length, 0, change);
  }
});

test('非持续计划等待资料确认，重新确认后也能自动重做和继续', async (t) => {
  const h = await materialHarness(t);
  h.product.version++;
  h.product.status = 'draft';
  await h.service.tick();
  assert.equal(h.service.campaign(h.campaign.id).status, 'active');
  h.product.version++;
  h.product.status = 'approved';
  await h.service.tick();
  await h.service.preparing.get(h.campaign.id);
  const fresh = h.service.deliveries(h.campaign.id).find((row) => row.status === 'queued');
  assert.ok(fresh);
  assert.equal(fresh.productVersion, h.product.version);
});

test('生成期间资料变化，迟到的旧正文不进入发送队列', async (t) => {
  const h = await materialHarness(t);
  const entered = deferred(),
    release = deferred();
  const generate = h.service.generator.generate;
  h.service.generator.generate = async (input) => {
    const result = await generate(input);
    entered.resolve();
    await release.promise;
    return result;
  };
  h.product.version++;
  h.service.refreshProductMaterials();
  await entered.promise;
  h.product.version++;
  release.resolve();
  await h.service.preparing.get(h.campaign.id);
  const late = h.service
    .deliveries(h.campaign.id)
    .find((row) => row.replacesDeliveryId === h.original.id);
  assert.equal(late.status, 'blocked');
  assert.equal(late.materialRefresh, true);
  assert.equal(h.deliveries.filter((row) => row.to === h.original.to).length, 0);
});

test('SMTP连接准备期间资料变化，最终提交前阻止旧版本，结果不会记为已发送', async (t) => {
  const h = await materialHarness(t);
  const entered = deferred(),
    release = deferred();
  h.service.mailboxes.send = async (id, message, { beforeSend } = {}) => {
    entered.resolve();
    await release.promise;
    beforeSend?.();
    h.deliveries.push({ mailboxId: id, ...message });
    return { accepted: [message.to], rejected: [], messageId: message.messageId };
  };
  const tick = h.service.tick();
  await entered.promise;
  h.product.version++;
  release.resolve();
  await tick;
  assert.equal(h.service.delivery(h.original.id).status, 'blocked');
  assert.equal(h.service.delivery(h.original.id).materialRefresh, true);
  assert.equal(h.deliveries.filter((row) => row.to === h.original.to).length, 0);
});

test('SMTP提交前进入发布维护，保留原队列与计划，解除后同一封正常发送', async (t) => {
  const h = await materialHarness(t);
  const entered = deferred(),
    release = deferred();
  let maintaining = false;
  h.service.isMaintaining = () => maintaining;
  h.service.mailboxes.send = async (id, message, { beforeSend } = {}) => {
    entered.resolve();
    await release.promise;
    beforeSend?.();
    h.deliveries.push({ mailboxId: id, ...message });
    return { accepted: [message.to], rejected: [], messageId: message.messageId };
  };
  const tick = h.service.tick();
  await entered.promise;
  maintaining = true;
  release.resolve();
  await tick;
  assert.equal(h.service.delivery(h.original.id).status, 'queued');
  assert.equal(h.service.campaign(h.campaign.id).status, 'active');
  assert.equal(h.deliveries.filter((row) => row.to === h.original.to).length, 0);
  await h.service.tick();
  assert.equal(h.service.delivery(h.original.id).status, 'queued');
  maintaining = false;
  await h.service.tick();
  assert.equal(h.service.delivery(h.original.id).status, 'accepted');
  assert.equal(h.deliveries.filter((row) => row.to === h.original.to).length, 1);
});

test('资料重做失败保留原产品与邮箱，等待后重试不会结束计划或按余量换号', async (t) => {
  const h = await materialHarness(t);
  const generate = h.service.generator.generate;
  h.service.generator.generate = async () => {
    throw Object.assign(new Error('模型暂不可用'), { status: 503 });
  };
  h.product.version++;
  await h.service.tick();
  await h.service.preparing.get(h.campaign.id);
  const failed = h.service.deliveries(h.campaign.id).find((row) => row.status === 'blocked');
  assert.equal(failed.materialRefresh, true);
  await h.service.tick();
  assert.equal(h.service.campaign(h.campaign.id).status, 'active');
  assert.equal(h.service.preparing.has(h.campaign.id), false);
  h.state.clock += 60001;
  h.service.generator.generate = generate;
  await h.service.tick();
  await h.service.preparing.get(h.campaign.id);
  const fresh = h.service.deliveries(h.campaign.id).find((row) => row.status === 'queued');
  assert.equal(fresh.id, failed.id);
  assert.equal(fresh.replacesDeliveryId, h.original.id);
  assert.equal(h.service.deliveries(h.campaign.id).length, 2);
  assert.equal(fresh.mailboxId, h.original.mailboxId);
  assert.equal(fresh.candidate.productId, h.original.candidate.productId);
});

test('已审核客户在就绪计划重做资料时保留已授予的计划授权', async (t) => {
  const h = await materialHarness(t);
  h.service.putCampaign({ ...h.service.campaign(h.campaign.id), status: 'ready' });
  h.product.version++;
  h.service.refreshProductMaterials();
  await h.service.preparing.get(h.campaign.id);
  assert.equal(h.service.campaign(h.campaign.id).approvedRevision, h.campaign.revision);
  const fresh = h.service.deliveries(h.campaign.id).find((row) => row.status === 'draft');
  assert.equal(fresh.status, 'draft');
});

test('首次生成失败时发生资料变化，仍保留待重做状态与原分配', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.service.generator.generate = async () => {
    h.products[0].version++;
    throw Object.assign(new Error('模型暂不可用'), { status: 503 });
  };
  const campaign = await prepare(h);
  const row = h.service.deliveries(campaign.id)[0];
  assert.equal(row.status, 'blocked');
  assert.equal(row.materialRefresh, true);
  assert.equal(row.mailboxId, h.boxes[0].id);
});

async function followUpHarness(options) {
  const h = harness(options);
  if (options?.policy) saveSequencePolicy(h.service, { revision: 1, ...options.policy });
  h.service.mailboxes.readMailbox = async () => ({ folders: [], hasMore: false });
  h.service.generator.generateFollowUp = async ({ step }) =>
    step === 1
      ? 'Does your team source PVC shutters externally?'
      : 'Who handles PVC shutters sourcing?';
  const send = h.service.mailboxes.send;
  h.service.mailboxes.send = async (id, message, options) => {
    options?.beforeSend?.();
    return send(id, message);
  };
  const c = await prepare(h, { targetCount: 1, followUpEnabled: true });
  h.service.activate(c.id, c.revision);
  await h.service.tick();
  h.first = h.service.deliveries(c.id)[0];
  h.campaign = c;
  return h;
}
test('跟进变量重复时可预览并提示修改，正式起草保留相同正文', async (t) => {
  const template = {
    subject: 'A note for {{company}}',
    body: '{{ai_opener}}{{ai_body}}{{ai_body}}',
  };
  const instruction = 'Would a product card help?';
  const h = await followUpHarness({
    policy: { name: '跟进预览', steps: [{ day: 3, instruction, template }] },
  });
  t.after(() => h.service.close());
  delete h.service.generator.generateFollowUp;
  h.service.getEnv = () => ({
    RESEARCH_MODEL_PROVIDER: 'openai_compatible',
    RESEARCH_MODEL_BASE_URL: 'https://test.invalid/v1',
    RESEARCH_MODEL_API_KEY: 'fixture',
    RESEARCH_MODEL_MODEL: 'fixture',
  });
  const draft = 'Here is a product update. ' + instruction;
  h.service.fetchImpl = async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify({ body_text: draft }) } }],
    });
  const input = { step: 1, day: 3, template, instruction, mailboxId: h.boxes[0].id };
  h.service.previewLeads = (category) => [
    {
      id: 'buyer-one',
      lead: {
        ...buyer('buyer-one', 'roller blinds'),
        facts: [
          ...buyer('buyer-one', 'roller blinds').facts,
          {
            field: 'customer_type',
            value: category,
            quote: 'We operate as ' + category + '.',
            source_url: 'https://buyer-one.example.org/about',
          },
        ],
      },
    },
  ];
  for (const [customer, company] of [
    ['distributor', 'Company buyer-one'],
    ['manufacturer', 'Company buyer-one'],
  ]) {
    const sample = await previewOutreachTemplate(h.service, { ...input, category: customer });
    assert.ok(
      sample.body.startsWith(
        'Hi ' + company + ' team,\n\nHere is a product update.' + draft + draft,
      ),
    );
    assert.match(sample.warning, /重复插入/);
    assert.equal(sample.subject, 'A note for ' + company);
    const corrected = await previewOutreachTemplate(h.service, {
      ...input,
      category: customer,
      template: { subject: '', body: '{{company}} {{ai_question}}' },
    });
    assert.ok(corrected.body.includes(company + ' ' + instruction));
    assert.equal(corrected.warning, undefined);
  }
  await assert.rejects(previewOutreachTemplate(h.service, { ...input, category: '' }), {
    status: 400,
  });
  const item = h.service.followUps.pending()[0];
  h.state.clock = Date.parse(item.dueAt);
  await h.service.followUps.dispatch(item, h.boxes[0]);
  assert.ok(h.deliveries.at(-1).text.includes(draft + draft));
  assert.equal(h.deliveries.at(-1).subject, 'A note for ' + h.first.companyName);
  assert.equal(h.deliveries.length, 2);
});

function addResponse(
  h,
  {
    direction = 'inbound',
    classification = 'normal',
    bodyText = 'Please send details.',
    subject = 'Re: Products',
  } = {},
) {
  h.service.conversations.importDeliveries();
  h.service.conversations.putMessage(h.boxes[0], {
    identity: 'reply-' + h.state.clock,
    messageId: `<reply-${h.state.clock}@example.org>`,
    inReplyTo: h.first.messageId,
    references: [h.first.messageId],
    direction,
    from: direction === 'inbound' ? h.first.to : h.first.from,
    to: direction === 'inbound' ? h.first.from : h.first.to,
    subject,
    bodyText,
    classification,
    source: 'imap',
    deliveryStatus: direction === 'inbound' ? 'received' : 'sent',
    occurredAt: new Date(h.state.clock).toISOString(),
  });
}
test('自动追信按首封72/168小时各一次，首封完成不终止追信且不污染首封数量', async () => {
  const h = await followUpHarness();
  try {
    assert.equal(h.first.status, 'accepted');
    assert.equal(h.service.followUps.all().length, 2);
    assert.equal(h.service.campaign(h.campaign.id).status, 'completed');
    assert.deepEqual((await h.service.state()).followUpStats, { sending: 0, active: 2 });
    h.state.clock += 72 * 3600000;
    await h.service.tick();
    assert.equal(h.deliveries.length, 2, JSON.stringify(h.service.followUps.all()));
    assert.equal(h.deliveries[1].inReplyTo, h.first.messageId);
    assert(h.deliveries[1].html.includes('brand-a'));
    assert.equal(h.service.conversations.list({ customerId: h.first.customerId }).items.length, 1);
    assert.equal(h.service.conversations.list({ customerId: 'another-buyer' }).items.length, 0);
    assert.equal(h.service.detail(h.campaign.id).campaign.stats.accepted, 1);
    await h.service.tick();
    assert.equal(h.deliveries.length, 2);
    h.state.clock = Date.parse(h.first.sentAt) + 168 * 3600000;
    await h.service.tick();
    assert.equal(h.deliveries.length, 3, JSON.stringify(h.service.followUps.all()));
    assert(h.service.followUps.all().every((r) => r.status === 'accepted'));
    assert.equal(h.service.conversations.list().items.length, 1);
  } finally {
    await h.service.close();
  }
});

test('自定义三步在首封提交时冻结规则，重启后将各步要求、原信和历史交给模型并在原线程发送一次', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'sequence-model-'));
  const steps = [
    { day: 1, instruction: '询问规格' },
    { day: 4, instruction: '核对应用' },
    { day: 6, instruction: '请求负责人转交' },
  ];
  const h = await followUpHarness({
    path: join(directory, 'outreach.sqlite'),
    policy: { name: '采购沟通', steps },
  });
  try {
    assert.equal(h.first.sequencePolicyRevision, 2);
    saveSequencePolicy(h.service, { name: '仅首封', revision: 2, steps: [] });
    await h.service.close();
    h.service = new OutreachService(h.serviceOptions);
    delete h.service.generator.generateFollowUp;
    h.service.getEnv = () => ({
      RESEARCH_MODEL_PROVIDER: 'openai_compatible',
      RESEARCH_MODEL_BASE_URL: 'https://test.invalid/v1',
      RESEARCH_MODEL_API_KEY: 'synthetic',
      RESEARCH_MODEL_MODEL: 'qa',
    });
    const prompts = [];
    t.mock.method(globalThis, 'fetch', async (url, req) => {
      assert.equal(url, 'https://test.invalid/v1/chat/completions');
      const payload = JSON.parse(req.body),
        prompt = JSON.parse(payload.messages[1].content);
      prompts.push(prompt);
      const body = 'Can we discuss the application for step ' + prompt.step + '?';
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ body_text: body }) } }],
      });
    });
    for (const [index, step] of steps.entries()) {
      h.state.clock = Date.parse(h.first.sentAt) + step.day * 86400000 - 1000;
      await h.service.tick();
      assert.equal(h.deliveries.length, index + 1);
      h.state.clock += 1000;
      if (index === 0) {
        const item = h.service.followUps.pending()[0];
        await Promise.all([
          h.service.followUps.dispatch(item, h.boxes[0]),
          h.service.followUps.dispatch(item, h.boxes[0]),
        ]);
      } else await h.service.tick();
      await h.service.tick();
      assert.equal(h.deliveries.length, index + 2, JSON.stringify(h.service.followUps.all()));
      const submitted = h.deliveries.at(-1),
        prompt = prompts.at(-1);
      assert.equal(submitted.inReplyTo, h.first.messageId);
      assert.ok(submitted.text.includes('application for step ' + (index + 1) + '?'));
      assert.equal(prompt.day, step.day);
      assert.equal(prompt.writingInstruction, step.instruction);
      assert.deepEqual(prompt.firstEmail, { subject: h.first.subject, body: h.first.bodyText });
      if (index)
        assert.ok(
          prompt.history.some((m) => m.body.includes('application for step ' + index + '?')),
        );
    }
    assert.ok(
      h.service.followUps.all().every((s) => s.status === 'accepted' && s.policyRevision === 2),
    );
    assert.equal(h.service.followUps.policy().steps.length, 0);
  } finally {
    await h.service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('跟进生成及 SMTP 提交前校验邮件所属品牌、官网和可推产品', async (t) => {
  const h = await followUpHarness();
  t.after(() => h.service.close());
  const item = h.service.followUps.pending()[0],
    mailbox = h.boxes[0];
  h.state.clock = Date.parse(item.dueAt);
  h.boxes[1].brandName = 'Coastal Screens';
  h.products.push({ id: 'canopy', name: '篷布轨道', englishName: 'Fabric canopy rails' });
  for (const forbidden of [
    'Shuangsheng Shutter',
    'Coastal Screens',
    'brand-b.example.org',
    'Fabric canopy rails',
  ]) {
    h.service.generator.generateFollowUp = async () =>
      `Would you like information on ${forbidden}?`;
    await assert.rejects(h.service.followUps.dispatch(item, mailbox), {
      code: 'FOLLOWUP_PRE_SEND_BLOCKED',
    });
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.service.followUps.get(item.id).status, 'pending');
  }
  // A website can be assigned to a new brand while SMTP is being prepared.
  h.service.generator.generateFollowUp = async () => 'Would North Coast Supply be a good fit?';
  const send = h.service.mailboxes.send;
  h.service.mailboxes.send = async (...args) => {
    h.boxes[1].brandName = 'North Coast Supply';
    return send(...args);
  };
  await h.service.followUps.dispatch(item, mailbox);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.service.followUps.get(item.id).status, 'pending');
  assert.match(h.service.followUps.get(item.id).reason, /其他品牌/u);
  h.service.generator.generateFollowUp = async () => 'Could we help with PVC shutters?';
  await h.service.followUps.dispatch(h.service.followUps.get(item.id), mailbox);
  assert.equal(h.deliveries.length, 2);
  assert.equal(h.service.followUps.get(item.id).status, 'accepted');
});

test('追信重启恢复保留发送结果未知，不重复发送或自动执行第二次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'followups-restart-'));
  const h = await followUpHarness({ path: join(dir, 'outreach.sqlite') });
  try {
    const item = h.service.followUps.all()[0];
    h.service.followUps.put({ ...item, status: 'sending', attemptedAt: item.dueAt });
    await h.service.close();
    h.service = new OutreachService(h.serviceOptions);
    assert.equal(h.service.followUps.get(item.id).status, 'unknown');
    h.state.clock = Date.parse(h.first.sentAt) + 168 * 3600000;
    await h.service.tick();
    assert.equal(h.deliveries.length, 1);
  } finally {
    await h.service.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('追信共享发送窗口和每日额度，SMTP提交前暂停生效，记录故障不改写成功结果', async () => {
  const h = await followUpHarness();
  try {
    h.state.clock += 72 * 3600000;
    h.service.putCampaign({
      ...h.service.campaign(h.campaign.id),
      sendWindow: { timezone: 'UTC', start: '05:00', end: '06:00' },
    });
    await h.service.tick();
    assert.equal(h.deliveries.length, 1);
    h.service.putCampaign({ ...h.service.campaign(h.campaign.id), sendWindow: null });
    h.boxes[0].dailyLimit = 0;
    await h.service.tick();
    assert.equal(h.deliveries.length, 1);
    h.boxes[0].dailyLimit = 50;
    const send = h.service.mailboxes.send;
    h.service.mailboxes.send = async (id, message, options) => {
      h.service.putCampaign({ ...h.service.campaign(h.campaign.id), followUpPaused: true });
      return send(id, message, options);
    };
    await h.service.tick();
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.service.followUps.all()[0].status, 'pending');
    h.service.mailboxes.send = send;
    h.service.putCampaign({ ...h.service.campaign(h.campaign.id), followUpPaused: false });
    h.state.clock += 60001;
    const importDeliveries = h.service.conversations.importDeliveries.bind(h.service.conversations);
    h.service.conversations.importDeliveries = () => {
      if (h.service.followUps.all().some((r) => r.status === 'accepted'))
        throw new Error('模拟收件缓存暂不可写');
      return importDeliveries();
    };
    await h.service.tick();
    assert.equal(h.service.followUps.all()[0].status, 'accepted');
    h.service.conversations.importDeliveries = importDeliveries;
    await h.service.tick();
    assert.equal(h.deliveries.length, 2);
  } finally {
    await h.service.close();
  }
});
test('追信生成与提交期间更换发件官网，原品牌的剩余追信均撤回', async () => {
  const h = await followUpHarness();
  try {
    h.state.clock += 72 * 3600000;
    const send = h.service.mailboxes.send;
    h.service.mailboxes.send = async (id, message, opts) => {
      h.boxes[0].website = 'https://new-brand.example.org';
      return send(id, message, opts);
    };
    await h.service.tick();
    assert.equal(h.deliveries.length, 1);
    assert.ok(h.service.followUps.all().every((item) => item.status === 'cancelled'));
  } finally {
    await h.service.close();
  }
});
test('真人回复及人工发信立即终止剩余追信，新任务中的自动回执不改变第3、7天安排', async () => {
  for (const direction of ['inbound', 'outbound']) {
    const h = await followUpHarness();
    try {
      h.state.clock += 60000;
      addResponse(h, { direction });
      await h.service.tick();
      assert(h.service.followUps.all().every((r) => r.status === 'cancelled'));
      assert.equal(h.deliveries.length, 1);
    } finally {
      await h.service.close();
    }
  }
  const h = await followUpHarness();
  try {
    h.state.clock += 60000;
    addResponse(h, {
      classification: 'auto_reply',
      subject: 'Out of office',
      bodyText: 'I am away.',
    });
    h.state.clock = Date.parse(h.first.sentAt) + 72 * 3600000;
    await h.service.tick();
    assert.equal(h.deliveries.length, 2);
    h.state.clock = Date.parse(h.first.sentAt) + 168 * 3600000;
    await h.service.tick();
    assert.equal(h.deliveries.length, 3);
  } finally {
    await h.service.close();
  }
});
test('已因自动回执等待人工的旧追信保留原状态，新追信缺已发件夹时也不会提交', async () => {
  const h = await followUpHarness();
  try {
    const legacy = h.service.followUps.all()[0];
    h.service.followUps.put({ ...legacy, notificationPolicy: undefined, reviewedAutoReplies: [] });
    h.state.clock += 60000;
    addResponse(h, {
      classification: 'auto_reply',
      subject: 'Out of office',
      bodyText: 'I am away.',
    });
    h.state.clock = Date.parse(h.first.sentAt) + 72 * 3600000;
    await h.service.tick();
    assert.match(h.service.followUps.get(legacy.id).reason, /系统自动回复/);
    h.service.mailboxes.readMailbox = async () => ({
      folders: [],
      hasMore: false,
      folderCoverage: { inbox: true, sent: false },
    });
    h.service.followUps.control(h.campaign.id, 'resume');
    await h.service.tick();
    assert.equal(h.deliveries.length, 1);
    assert.match(h.service.followUps.get(legacy.id).reason, /已发送文件夹/);
  } finally {
    await h.service.close();
  }
});
test('追信遵守暂停与24小时期限，收信失败或分页不完整不得发送，启用不追溯首封', async () => {
  const h = await followUpHarness();
  try {
    h.state.clock += 72 * 3600000;
    h.service.mailboxes.readMailbox = async () => ({ folders: [], hasMore: true });
    await h.service.tick();
    assert.equal(h.deliveries.length, 1);
    h.state.clock += 24 * 3600000 + 1;
    await h.service.tick();
    assert.equal(h.service.followUps.all()[0].status, 'skipped');
    h.service.followUps.control(h.campaign.id, 'disable');
    h.service.followUps.control(h.campaign.id, 'enable');
    await h.service.tick();
    assert.equal(h.service.followUps.all().length, 2);
    assert.equal(h.service.followUps.all()[1].status, 'cancelled');
  } finally {
    await h.service.close();
  }
});
test('追信SMTP结果未知不重发也不继续第二次；生成中出现回复淘汰草稿', async () => {
  const h = await followUpHarness();
  try {
    h.state.clock += 72 * 3600000;
    h.state.sendError = new Error('socket lost');
    await h.service.tick();
    assert.equal(h.service.followUps.all()[0].status, 'unknown');
    const count = h.deliveries.length;
    h.state.clock = Date.parse(h.first.sentAt) + 168 * 3600000;
    await h.service.tick();
    assert.equal(h.deliveries.length, count);
  } finally {
    await h.service.close();
  }
  const g = await followUpHarness();
  try {
    g.state.clock += 72 * 3600000;
    g.service.generator.generateFollowUp = async () => {
      addResponse(g);
      return 'Who handles sourcing?';
    };
    await g.service.tick();
    assert.equal(g.deliveries.length, 1);
    assert(g.service.followUps.all().every((r) => r.status === 'cancelled'));
  } finally {
    await g.service.close();
  }
});

test('首封计划核对监管、平台客服及官网跨域联系方式', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const cases = [
    [
      'dcb',
      'enquiries@authority.example',
      '/privacy',
      'Lodge a complaint with the Information Commissioner at',
    ],
    ['crazy', 'help@radio.example', 'https://radio.example/help', 'Radio customer support:'],
    [
      'mastercraft',
      'office@partner.example',
      '/contact',
      'Mastercraft Shutters | Phone 555 | Email:',
    ],
    [
      'homepage',
      'home@partner.example',
      '/index.html',
      'Mastercraft Shutters | Phone 555 | Email:',
    ],
    ['platform', 'support@platform.example', '/contact', 'For radio platform support | Email:'],
    [
      'platform-cta',
      'account@platform.example',
      '/contact',
      'Third-party radio platform support | Contact us at',
    ],
    ['fallback', 'help@radio.example', 'https://radio.example/help', 'Radio customer support:'],
  ];
  h.state.leads = cases.map(([id, email, path, label]) => {
    const lead = buyer(id);
    if (['mastercraft', 'homepage'].includes(id)) lead.name = 'Mastercraft Shutters';
    lead.contactEvidence = [
      {
        kind: 'email',
        value: email,
        source_url: new URL(path, lead.website).href,
        quote: label + ' ' + email,
      },
    ];
    lead.email = id === 'fallback' ? email + ' ' + lead.email : email;
    return lead;
  });
  await runInternalTest(h);
  const campaign = await prepare(h);
  h.service.activate(campaign.id, campaign.revision);
  const rows = h.service.deliveries(campaign.id);
  assert.deepEqual(
    rows
      .filter((r) => r.status === 'queued')
      .map((r) => r.to)
      .sort(),
    ['home@partner.example', 'info@fallback.example.org', 'office@partner.example'],
  );
  assert.deepEqual(
    rows
      .filter((r) => r.reasonCode === 'contact_unverified')
      .map((r) => r.customerId)
      .sort(),
    ['crazy', 'dcb', 'platform', 'platform-cta'],
  );
});

test('正式首封拒绝模板或生成器带入邮箱范围外产品', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes[0].productIds = ['pvc'];
  h.service.generator.generate = async () => ({
    subject: 'Products',
    bodyText: 'We supply roller blinds.',
    sourceIds: [],
  });
  const campaign = await prepare(h, {
    mailboxIds: [h.boxes[0].id],
    filters: { products: ['pvc'] },
  });
  const row = h.service.deliveries(campaign.id)[0];
  assert.equal(row.status, 'blocked');
  assert.match(row.reason, /产品|品牌/);
  assert.equal(h.deliveries.length, 0);
});

test('删除阻止服务商提交前的旧邮件且不会重新生成追信', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  await runInternalTest(h);
  const c = await prepare(h, { followUpEnabled: true });
  const entered = deferred(),
    release = deferred();
  let submitted = 0;
  h.service.mailboxes.send = async (id, message, { beforeSend }) => {
    entered.resolve();
    await release.promise;
    beforeSend();
    submitted++;
    return { accepted: [message.to] };
  };
  h.service.activate(c.id, c.revision);
  await entered.promise;
  h.service.deleteCampaign(c.id, c.revision, true);
  release.resolve();
  await h.service.tick();
  assert.equal(submitted, 0);
  assert.equal(h.service.detail(c.id).deliveries[0].status, 'cancelled');
  assert.equal(h.service.followUps.all().length, 0);
});

test('删除保留提交后成功失败未知，未知人工核实后不生成追信且保留企业占用', async (t) => {
  for (const result of ['accepted', 'failed', 'unknown']) {
    const h = harness();
    t.after(() => h.service.close());
    await runInternalTest(h);
    const c = await prepare(h, { followUpEnabled: true });
    const entered = deferred(),
      release = deferred();
    let submitted = 0;
    h.service.mailboxes.send = async (id, message, { beforeSend }) => {
      beforeSend();
      submitted++;
      entered.resolve();
      await release.promise;
      if (result === 'unknown')
        throw Object.assign(new Error('uncertain'), { code: 'ECONNECTION' });
      return result === 'accepted' ? { accepted: [message.to] } : { rejected: [message.to] };
    };
    h.service.activate(c.id, c.revision);
    await entered.promise;
    h.service.deleteCampaign(c.id, c.revision, true);
    release.resolve();
    await h.service.tick();
    let d = h.service.detail(c.id).deliveries[0];
    assert.equal(d.status, result);
    assert.equal(submitted, 1);
    assert.equal(h.service.followUps.all().length, 0);
    if (result === 'unknown') {
      assert.equal(h.service.isReserved(d.candidate), true);
      const unresolved = await h.service.reconcileDelivery(d.id);
      assert.equal(unresolved.status, 'unknown');
      d = await h.service.resolveDelivery(d.id, {
        outcome: 'accepted',
        evidence: '原邮箱已发送文件夹人工确认 Message-ID',
        operator: '测试业务员',
      });
      assert.equal(d.status, 'accepted');
      assert.equal(h.service.followUps.all().length, 0);
    }
    h.state.clock += 61000;
    await h.service.tick();
    assert.equal(submitted, 1);
  }
});
test('手动计划拒绝空集合和无覆盖产品，保存只授权明确编号并在启动时复查', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes[0].productIds = ['pvc'];
  h.boxes[1].productIds = ['roller'];
  assert.throws(
    () => h.service.saveCampaign(h.campaignInput({ filters: { products: [] } })),
    /至少选择一个供货产品/,
  );
  assert.throws(
    () =>
      h.service.saveCampaign(
        h.campaignInput({ mailboxIds: ['brand-a'], filters: { products: ['roller'] } }),
      ),
    /负责范围/,
  );
  const first = h.service.saveCampaign(
    h.campaignInput({ mailboxIds: ['brand-a'], filters: { products: ['pvc'] } }),
  );
  const second = h.service.saveCampaign(
    h.campaignInput({ mailboxIds: ['brand-b'], filters: { products: ['roller'] } }),
  );
  assert.deepEqual(h.service.detail(first.id).campaign.filters.products, ['pvc']);
  assert.deepEqual(h.service.detail(second.id).campaign.filters.products, ['roller']);
  h.products.push({ ...h.products[0], id: 'outdoor' });
  assert.throws(
    () => h.service.saveCampaign(h.campaignInput({ filters: { products: ['outdoor'] } })),
    /负责范围/,
  );
  h.boxes[0].productIds.push('outdoor');
  assert.deepEqual(h.service.detail(first.id).campaign.filters.products, ['pvc']);
  h.products[0].effectiveDate = '2099-01-01';
  assert.throws(() => h.service.activate(first.id, first.revision), /尚未生效/);
  delete h.products[0].effectiveDate;
  h.products[0].status = 'draft';
  assert.throws(() => h.service.activate(first.id, first.revision), /尚未审核/);
  h.products[0].status = 'approved';
  h.boxes[0].productIds = [];
  assert.throws(() => h.service.activate(first.id, first.revision), /负责范围/);
});

test('旧计划按保存快照和原品类迁移，空交集与缺失快照等待确认，重启无扩大且历史可读', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'outreach-selection-migration-'));
  const h = harness({ path: join(directory, 'outreach.sqlite') });
  try {
    h.products[0].category = 'ventilation';
    h.products[1].category = 'indoor';
    const seed = h.service.saveCampaign(h.campaignInput());
    const scopes = h.service.campaign(seed.id).productScopes;
    for (const [id, categories, productScopes] of [
      ['limited', ['indoor'], scopes],
      ['all', [], scopes],
      ['empty', ['outdoor'], scopes],
      ['missing', [], undefined],
    ])
      h.service.putCampaign({
        ...seed,
        id,
        status: 'paused',
        productSelectionVersion: undefined,
        filters: { ...seed.filters, products: [], categories },
        productScopes,
      });
    h.service.putDelivery({
      id: 'historic',
      campaignId: 'missing',
      status: 'accepted',
      subject: 'Original sent mail',
    });
    await h.service.close();
    h.products.push({ ...h.products[0], id: 'new' });
    h.boxes[0].productIds.push('new');
    h.service = new OutreachService(h.serviceOptions);
    assert.deepEqual(h.service.detail('limited').campaign.filters.products, ['roller']);
    assert.deepEqual(h.service.detail('all').campaign.filters.products, ['pvc', 'roller']);
    for (const id of ['empty', 'missing']) {
      assert.deepEqual(h.service.detail(id).campaign.filters.products, []);
      assert.equal(h.service.detail(id).campaign.productSelectionState, 'confirmation_required');
      assert.throws(() => h.service.activate(id, seed.revision), /编辑并确认/);
    }
    assert.equal(h.service.detail('missing').deliveries[0].subject, 'Original sent mail');
    const before = h.service.detail('all').campaign;
    await h.service.close();
    h.service = new OutreachService(h.serviceOptions);
    assert.deepEqual(h.service.detail('all').campaign, before);
  } finally {
    await h.service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP 新建双邮箱明确产品计划，拒绝无覆盖对照和空编辑，回读保持原集合', async (t) => {
  const { createApp } = await import('../server/app.mjs');
  const h = harness();
  h.boxes[0].productIds = ['pvc'];
  h.boxes[1].productIds = ['roller'];
  h.products.push({ ...h.products[0], id: 'outdoor' });
  const server = createApp({ env: {}, outreachServiceFactory: () => h.service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await h.service.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1/outreach`;
  const write = (path, body, method = 'POST') =>
    fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  for (const [mailbox, product] of [
    ['brand-a', 'pvc'],
    ['brand-b', 'roller'],
  ]) {
    const result = await write(
      '/campaigns',
      h.campaignInput({ mailboxIds: [mailbox], filters: { products: [product] } }),
    );
    assert.equal(result.status, 200);
    const created = await result.json();
    const id = created.id;
    assert.deepEqual(
      (await (await fetch(base + '/campaigns/' + id)).json()).campaign.filters.products,
      [product],
    );
    assert.equal(
      (
        await write(
          '/campaigns/' + id,
          { ...h.campaignInput(), revision: created.revision, filters: { products: [] } },
          'PUT',
        )
      ).status,
      400,
    );
    assert.deepEqual(
      (await (await fetch(base + '/campaigns/' + id)).json()).campaign.filters.products,
      [product],
    );
  }
  assert.equal(
    (await write('/campaigns', h.campaignInput({ filters: { products: ['outdoor'] } }))).status,
    400,
  );
  assert.equal(
    (await write('/campaigns', h.campaignInput({ filters: { products: [] } }))).status,
    400,
  );
  assert.equal(h.deliveries.length, 0);
});

test('两个明确产品计划经正常启动仅向各自邮箱提交所选产品，户外对照没有发送', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes[0].productIds = ['pvc'];
  h.boxes[1].productIds = ['roller'];
  h.products.push({ ...h.products[0], id: 'outdoor', englishName: 'outdoor awnings' });
  h.state.leads = [
    buyer('pvc-buyer'),
    buyer('roller-buyer', 'roller blinds'),
    buyer('outdoor-buyer', 'outdoor awnings'),
  ];
  for (const [mailbox, product] of [
    ['brand-a', 'pvc'],
    ['brand-b', 'roller'],
  ]) {
    const campaign = h.service.saveCampaign(
      h.campaignInput({ mailboxIds: [mailbox], filters: { products: [product] }, targetCount: 1 }),
    );
    h.service.activate(campaign.id, campaign.revision);
    await h.service.preparing.get(campaign.id);
    await h.service.tick();
    const accepted = h.service
      .detail(campaign.id)
      .deliveries.filter((d) => d.status === 'accepted');
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].mailboxId, mailbox);
    assert.equal(accepted[0].customerId, product + '-buyer');
  }
  assert.equal(h.deliveries.length, 2);
  assert.deepEqual(
    h.deliveries.map((d) => d.mailboxId),
    ['brand-a', 'brand-b'],
  );
  assert.match(h.deliveries[0].text, /We supply PVC shutters/);
  assert.match(h.deliveries[1].text, /We supply roller blinds/);
  assert.equal(
    h.deliveries.some((d) => d.to.includes('outdoor-buyer')),
    false,
  );
});

test('新增邮箱产品覆盖不作废原手动计划已准备的产品与发件身份', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  await runInternalTest(h);
  const campaign = await prepare(h, { filters: { products: ['pvc'] } });
  const draft = h.service.deliveries(campaign.id)[0];
  h.boxes.find((box) => box.id === draft.mailboxId).productIds.push('new-product');
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  assert.equal(h.service.delivery(draft.id).status, 'accepted');
  assert.equal(h.service.delivery(draft.id).mailboxId, draft.mailboxId);
  assert.equal(h.service.delivery(draft.id).candidate.productId, 'pvc');
  assert.deepEqual(h.service.campaign(campaign.id).filters.products, ['pvc']);
});

test('原邮箱消失时保留原产品和身份并阻止未提交邮件，其他覆盖邮箱不接替', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const campaign = await prepare(h, {
    mailboxIds: ['brand-a', 'brand-b'],
    filters: { products: ['pvc'] },
  });
  const draft = h.service.deliveries(campaign.id)[0];
  h.boxes.splice(
    h.boxes.findIndex((box) => box.id === draft.mailboxId),
    1,
  );
  h.service.refreshProductMaterials();
  const actual = h.service.delivery(draft.id);
  assert.equal(actual.status, 'blocked');
  assert.match(actual.reason, /产品范围/);
  assert.equal(actual.mailboxId, draft.mailboxId);
  assert.equal(actual.candidate.productId, 'pvc');
  assert.equal(h.deliveries.length, 0);
});

test('SMTP准备中撤销邮箱覆盖后提交数为零且保留原产品和发件身份', async (t) => {
  const h = await materialHarness(t);
  const entered = deferred(),
    release = deferred();
  h.service.mailboxes.send = async (id, message, { beforeSend }) => {
    entered.resolve();
    await release.promise;
    beforeSend();
    h.deliveries.push({ mailboxId: id, ...message });
    return { accepted: [message.to] };
  };
  const tick = h.service.tick();
  await entered.promise;
  const mailbox = h.boxes.find((box) => box.id === h.original.mailboxId);
  mailbox.productIds = mailbox.productIds.filter((id) => id !== h.original.candidate.productId);
  release.resolve();
  await tick;
  const actual = h.service.delivery(h.original.id);
  assert.equal(actual.status, 'blocked');
  assert.match(actual.reason, /产品范围/);
  assert.equal(actual.mailboxId, h.original.mailboxId);
  assert.equal(actual.candidate.productId, h.original.candidate.productId);
  assert.equal(h.deliveries.filter((row) => row.to === h.original.to).length, 0);
});
