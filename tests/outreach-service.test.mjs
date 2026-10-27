import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutreachService } from '../server/outreach-service.mjs';

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
      generate: async ({ candidate, campaign }) => ({
        subject: `Window products for ${candidate.companyName}`,
        bodyText: `Hello,\n\n${campaign.outreachClaims.find((claim) => claim.productId === candidate.productId).text}`,
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
    outreachClaims: products.map((product) => ({
      productId: product.id,
      productVersion: product.version,
      text: `Example supplies ${product.englishName} to window furnishing businesses.`,
    })),
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

async function enableProduction(h) {
  await internalTest(h);
  for (const row of h.service
    .deliveries()
    .filter((row) => row.mode === 'internal_test' && row.status === 'accepted'))
    h.service.confirmInternalReceipt(row.id);
  h.service.approveReview(true);
  h.state.clock += 31000;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
  assert.equal(h.service.review().productionApproved, false);
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

test('正式发送要求内部测试、人工共同检查和当前计划样稿审核全部完成', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const campaign = await prepare(h);
  assert.equal(h.service.detail(campaign.id).campaign.stats.draft, 1);
  assert.throws(() => h.service.approveReview(true), { status: 409 });
  assert.throws(() => h.service.activate(campaign.id, campaign.revision), { status: 409 });
  h.service.approve(campaign.id, campaign.revision);
  assert.throws(() => h.service.activate(campaign.id, campaign.revision), { status: 409 });
  await internalTest(h);
  assert.throws(() => h.service.activate(campaign.id, campaign.revision), { status: 409 });
  for (const row of h.service.deliveries().filter((row) => row.mode === 'internal_test'))
    h.service.confirmInternalReceipt(row.id);
  h.service.approveReview(true);
  h.state.clock += 31000;
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
  await enableProduction(h);
  const first = await prepare(h);
  h.service.approve(first.id, first.revision);
  h.service.activate(first.id, first.revision);
  await h.service.tick();
  const second = await prepare(h, { name: 'Second campaign' });
  assert.equal(h.service.detail(second.id).campaign.stats.draft, 0);
  assert.equal(h.service.detail(second.id).campaign.stats.blocked, 1);
  h.state.leads = [buyer('known-contact'), buyer('suppressed-company'), buyer('manual-contact')];
  h.state.business = {
    messages: [{ customerId: 'known-contact', deliveryStatus: 'sent' }],
    customerContexts: [{ customerId: 'manual-contact', doNotContact: true }],
  };
  h.service.suppress({ domain: 'suppressed-company.example.org', reason: 'Do not contact' });
  const third = await prepare(h, { name: 'Known business contact campaign' });
  assert.equal(h.service.detail(third.id).campaign.stats.draft, 0);
  assert.equal(h.service.detail(third.id).campaign.stats.blocked, 3);
  assert.equal(h.deliveries.filter((row) => !row.subject.startsWith('[ShadeFlow-Test:')).length, 1);
});

test('重启后发送中的记录转为待核实，保留企业占用且不自动重发', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'outreach-restart-'));
  const h = harness({ path: join(directory, 'outreach.sqlite') });
  let reopened;
  try {
    await enableProduction(h);
    const campaign = await prepare(h);
    h.service.approve(campaign.id, campaign.revision);
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
  await enableProduction(h);
  const campaign = await prepare(h);
  h.service.approve(campaign.id, campaign.revision);
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
  await enableProduction(h);
  const campaign = await prepare(h);
  h.service.approve(campaign.id, campaign.revision);
  h.boxes[0].paused = true;
  h.service.activate(campaign.id, campaign.revision);
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
  await enableProduction(h);
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
    h.service.deliveries(second.id).find((row) => row.customerId === 'fourth-buyer').status,
    'blocked',
  );
  // Website metadata and priority do not change an already prepared sender.
  h.boxes[0].priority = 999;
  h.boxes[0].website = 'https://legacy.example.org';
  h.service.approve(first.id, first.revision);
  h.service.activate(first.id, first.revision);
  await h.service.tick();
  assert.equal(h.service.deliveries(first.id)[0].status, 'accepted');
  assert.equal(h.service.deliveries(first.id)[0].mailboxId, 'brand-a');
  h.service.approve(second.id, second.revision);
  h.service.activate(second.id, second.revision);
  await h.service.tick();
  assert.equal(
    h.service.deliveries(second.id).filter((row) => row.status === 'accepted').length,
    2,
  );
});

test('计划品类筛选与邮箱产品范围共同决定首封资格', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.products[0].category = 'ventilation';
  h.products[1].category = 'indoor';
  h.state.leads = [buyer('shutter'), buyer('roller', 'roller blinds')];
  const campaign = await prepare(h, { filters: { categories: ['indoor'] } });
  assert.deepEqual(campaign.filters.categories, ['indoor']);
  const drafts = h.service.deliveries(campaign.id).filter((row) => row.status === 'draft');
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].customerId, 'roller');
  assert.equal(drafts[0].mailboxId, 'brand-a');
});

test('已审核草稿的产品范围被撤回时停止发送，不切换到其他邮箱', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  await enableProduction(h);
  const campaign = await prepare(h);
  h.service.approve(campaign.id, campaign.revision);
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
  await enableProduction(h);
  const campaign = await prepare(h, { targetCount: 3, continuous: true });
  h.service.approve(campaign.id, campaign.revision);
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

test('客户证据补齐后重新准备样稿，旧待处理记录不再占用当前待处理计数', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  const contact = h.state.leads[0].contactEvidence;
  h.state.leads[0].contactEvidence = [];
  const campaign = await prepare(h);
  assert.equal(h.service.detail(campaign.id).campaign.stats.blocked, 1);
  h.state.leads[0].contactEvidence = contact;
  h.service.prepare(campaign.id);
  await h.service.preparing.get(campaign.id);
  const detail = h.service.detail(campaign.id);
  assert.equal(detail.campaign.stats.blocked, 0);
  assert.equal(detail.campaign.stats.draft, 1);
  assert.equal(detail.deliveries.filter((row) => row.status === 'cancelled').length, 1);
});

test('发送前异步核对期间修改邮箱身份或计划，旧草稿不能继续发送', async (t) => {
  for (const mutation of ['mailbox', 'campaign']) {
    const h = harness();
    t.after(() => h.service.close());
    await enableProduction(h);
    const campaign = await prepare(h);
    h.service.approve(campaign.id, campaign.revision);
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
  await enableProduction(h);
  const campaign = await prepare(h);
  h.service.approve(campaign.id, campaign.revision);
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

test('内部测试没有覆盖暂停邮箱时，恢复该邮箱需要补做测试后才能正式发送', async (t) => {
  const h = harness();
  t.after(() => h.service.close());
  h.boxes[2].paused = true;
  await internalTest(h);
  for (const row of h.service.deliveries().filter((row) => row.mode === 'internal_test'))
    h.service.confirmInternalReceipt(row.id);
  h.service.approveReview(true);
  h.boxes[2].paused = false;
  assert.equal(h.service.review().productionApproved, false);
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
    () => h.service.approve(campaign.id, cancelled.campaign.revision),
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
  h.state.leads[0].contactEvidence = [];
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
    await enableProduction(h);
    const campaign = await prepare(h);
    h.service.approve(campaign.id, campaign.revision);
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
    await enableProduction(h);
    h.state.leads = [buyer('first'), buyer('second')];
    const campaign = await prepare(h);
    h.service.approve(campaign.id, campaign.revision);
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
