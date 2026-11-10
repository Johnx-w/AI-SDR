import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchJobs, validateAutoFirstTouch } from '../server/batch-jobs.mjs';
import { AcquisitionSchedules } from '../server/acquisition-schedules.mjs';
import { acquisitionOutreachSources } from '../server/acquisition-outreach.mjs';
import { OutreachService } from '../server/outreach-service.mjs';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { withApp } from './helpers/http.mjs';
import { feishuEnv, withFeishuAuth } from './helpers/feishu.mjs';

const input = {
  country: 'Australia',
  region: '',
  product: 'roller blinds',
  query_mode: 'auto',
  acquisition_channel: 'web',
  target_count: 200,
  auto_first_touch: true,
};
const buyer = (id, product = 'PVC shutters') => ({
  id,
  name: `Company ${id}`,
  website: `https://${id}.example.org`,
  market: '',
  grade: 'B',
  status: '待开发',
  email: `info@${id}.example.org`,
  type: '经销商',
  product,
  facts: [
    {
      field: 'entity_type',
      value: 'business',
      quote: 'We are a window furnishing business.',
      source_url: `https://${id}.example.org/about`,
    },
    {
      field: 'products',
      value: product,
      quote: `Our product range includes ${product}.`,
      source_url: `https://${id}.example.org/products`,
    },
  ],
});
function harness(path = ':memory:') {
  const state = {
    now: Date.parse('2026-11-05T00:00:00Z'),
    leads: [],
    gate: null,
    error: null,
    sent: [],
    generated: [],
  };
  const products = [
    {
      id: 'pvc',
      name: 'PVC 透气窗',
      englishName: 'PVC shutters',
      status: 'approved',
      version: 1,
      direction: 'finished',
      markets: [],
    },
  ];
  const boxes = [
    {
      id: 'box',
      email: 'sales@brand.example.org',
      website: 'https://brand.example.org',
      brandName: 'Brand',
      displayName: 'Brand',
      signature: 'Brand sales',
      productIds: ['pvc'],
      configured: true,
      smtpStatus: 'connected',
      paused: false,
      dailyLimit: 1000,
      intervalSeconds: 5,
    },
  ];
  const jobs = new BatchJobs({
    schedule: false,
    scope: 'local',
    now: () => state.now,
    readLeads: async () => state.leads,
  });
  const plans = new AcquisitionSchedules({
    jobs: () => jobs,
    now: () => state.now,
    scope: 'local',
    ready: () => true,
    available: () => true,
  });
  const options = {
    path,
    now: () => state.now,
    tickMs: 3600000,
    acquisitionSources: () => acquisitionOutreachSources(jobs, plans),
    loadLeads: async () => structuredClone(state.leads),
    products: () => structuredClone(products),
    mailboxes: {
      list: () => structuredClone(boxes),
      get: (id) => structuredClone(boxes.find((box) => box.id === id)),
      save: async (value) =>
        Object.assign(
          boxes.find((box) => box.id === value.id),
          value,
        ),
      send: async (id, mail) => {
        state.sent.push({ id, ...mail });
        if (state.error) throw state.error;
        return { accepted: [mail.to], messageId: mail.messageId };
      },
    },
    generator: {
      configured: true,
      generate: async ({ candidate }) => {
        state.generated.push(candidate);
        if (state.gate) await state.gate;
        return {
          subject: 'Product supply',
          bodyText: 'We supply window products.',
          sourceIds: candidate.evidence.map((e) => e.id),
        };
      },
    },
  };
  const h = { state, products, boxes, jobs, plans, options, service: new OutreachService(options) };
  h.create = (overrides = {}, scheduleId) => {
    const job = jobs.create({ ...input, ...overrides }, `run-${crypto.randomUUID()}`, {
      scheduleId,
    });
    if (scheduleId) plans.save({ ...plans.get(scheduleId), lastJobId: job.id });
    return job;
  };
  h.capture = async (jobId, lead, updated = false) => {
    if (!state.leads.some((row) => row.id === lead.id)) state.leads.push(lead);
    const job = jobs.get(jobId);
    job.current = {
      domain: new URL(lead.website).hostname,
      source_url: lead.website,
      operation_id: crypto.randomUUID(),
    };
    jobs.save(job);
    await jobs.accept(job, {
      新增: updated ? 0 : 1,
      更新: updated ? 1 : 0,
      明细: [
        { record_id: lead.id, source_url: lead.website, result: updated ? 'updated' : 'inserted' },
      ],
    });
  };
  h.pump = async (seconds = 65) => {
    state.now += seconds * 1000;
    await h.service.tick();
    await Promise.all([...h.service.preparing.values()]);
    await h.service.tick();
  };
  h.plan = () =>
    plans.create(
      {
        name: '定时获客',
        input,
        timing: {
          repeat: 'weekly',
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startDate: '2026-11-05',
          times: ['09:00'],
          timezone: 'Asia/Shanghai',
        },
      },
      crypto.randomUUID(),
    );
  h.close = async () => {
    await h.service.close();
    plans.close();
    jobs.close();
  };
  return h;
}

async function smtpHarness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'automatic-first-touch-smtp-'));
  const h = harness(join(dir, 'outreach.sqlite'));
  await h.service.close();
  t.after(async () => {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  });
  h.mailboxes = new OutreachMailboxes({
    env: {},
    path: join(dir, 'mailboxes.json'),
    seedPath: null,
    mailboxReaderFactory: async () => ({ read: async () => ({ folders: [], hasMore: false }) }),
    protect: async (value) => ({
      credentialProtection: 'windows-dpapi-current-user',
      credential: Buffer.from(value).toString('base64'),
    }),
    unprotect: async (value) => Buffer.from(value, 'base64').toString('utf8'),
    transportFactory: async (config) => {
      assert.equal(config.auth.pass, 'synthetic-password');
      await h.state.beforeTransport?.();
      return {
        verify: async () => true,
        sendMail: async (mail) => {
          h.state.sent.push({ ...mail, submittedAt: h.state.now });
          await h.state.afterSubmit?.();
          if (h.state.error) throw h.state.error;
          return h.state.smtpResult || { accepted: [mail.to], rejected: [] };
        },
        close() {},
      };
    },
  });
  await h.mailboxes.save({
    id: 'box',
    email: 'sales@brand.example.org',
    website: 'https://brand.example.org',
    brandName: 'Brand',
    displayName: 'Brand',
    signature: 'Brand sales',
    productIds: ['pvc'],
    paused: false,
    dailyLimit: 50,
    intervalSeconds: 5,
    clientPassword: 'synthetic-password',
  });
  await h.mailboxes.verify('box');
  h.options.mailboxes = h.mailboxes;
  h.service = new OutreachService(h.options);
  h.jobs.onOutreachChange = h.plans.onOutreachChange = () => h.service.syncAcquisition();
  return h;
}

for (const action of ['单次暂停', '计划暂停', '关闭首发', '关闭计划']) {
  test(`A06 SMTP连接准备期间${action}，尚未提交的邮件必须停止`, { timeout: 5000 }, async (t) => {
    const h = await smtpHarness(t);
    const plan = action === '单次暂停' ? null : h.plan();
    const job = h.create({}, plan?.id);
    await h.capture(job.id, buyer('before-smtp'));
    await h.service.tick();
    await Promise.all([...h.service.preparing.values()]);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    h.state.beforeTransport = async () => {
      entered.resolve();
      await release.promise;
    };
    const sending = h.service.tick();
    try {
      await entered.promise;
      if (action === '单次暂停') h.jobs.controlOutreach(job.id, false);
      if (action === '计划暂停') h.plans.control(plan.id, 'pause');
      if (action === '关闭首发') h.plans.controlOutreach(plan.id, false);
      if (action === '关闭计划') h.plans.control(plan.id, 'close');
    } finally {
      release.resolve();
      await sending;
    }
    assert.equal(h.state.sent.length, 0);
    assert.equal(h.service.deliveries(undefined, ['accepted', 'unknown']).length, 0);
    assert.equal(h.mailboxes.get('box').paused, false, '获客暂停不是邮箱故障');
    h.state.beforeTransport = null;
    if (action === '单次暂停') h.jobs.controlOutreach(job.id, true);
    if (action === '计划暂停') h.plans.control(plan.id, 'resume');
    if (action === '关闭首发') h.plans.controlOutreach(plan.id, true);
    await h.pump();
    assert.equal(h.state.sent.length, action === '关闭计划' ? 0 : 1);
  });
}

test('A07 已提交SMTP后关闭获客计划，保留首封结果并停止下一封', { timeout: 5000 }, async (t) => {
  const h = await smtpHarness(t);
  const plan = h.plan();
  const job = h.create({}, plan.id);
  await h.capture(job.id, buyer('in-flight'));
  await h.capture(job.id, buyer('still-queued'));
  await h.service.tick();
  await Promise.all([...h.service.preparing.values()]);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  h.state.afterSubmit = async () => {
    entered.resolve();
    await release.promise;
  };
  const sending = h.service.tick();
  try {
    await entered.promise;
    h.plans.control(plan.id, 'close');
  } finally {
    release.resolve();
    await sending;
  }
  h.state.afterSubmit = null;
  await h.pump();
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.state.sent[0].to, 'info@in-flight.example.org');
  const accepted = h.service.deliveries(undefined, ['accepted']);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].to, 'info@in-flight.example.org');
  assert.equal(h.service.campaigns()[0].status, 'cancelled');
  assert.equal(h.service.deliveries(undefined, ['queued', 'sending', 'unknown']).length, 0);
});

test('A08 两个获客任务共享邮箱每日2封和30秒间隔，次日继续剩余客户', async (t) => {
  const h = await smtpHarness(t);
  await h.mailboxes.save({ id: 'box', dailyLimit: 2, intervalSeconds: 30 });
  const first = h.create();
  await h.capture(first.id, buyer('quota-one'));
  h.jobs.finish(h.jobs.get(first.id), 'target_reached');
  const second = h.create();
  await h.capture(second.id, buyer('quota-two'));
  await h.capture(second.id, buyer('quota-three'));
  const startedAt = h.state.now;
  await h.pump(0);
  assert.equal(h.state.sent.length, 1, 't=0只发送一封');
  await h.pump(29);
  assert.equal(h.state.sent.length, 1, 't=29仍未达到间隔');
  await h.pump(1);
  assert.equal(h.state.sent.length, 2, 't=30达到间隔');
  assert.deepEqual(
    h.state.sent.map((mail) => mail.submittedAt - startedAt),
    [0, 30000],
  );
  await h.pump(30);
  assert.equal(h.state.sent.length, 2, '当日已用完2封额度');
  h.state.now = Date.parse('2026-11-05T15:59:59Z');
  await h.pump(0);
  assert.equal(h.state.sent.length, 2, '北京时间23:59:59仍属同一天');
  await h.pump(65);
  assert.equal(h.state.sent.length, 3, '北京时间次日的常规待处理复查继续剩余客户');
  assert.equal(new Set(h.state.sent.map((mail) => mail.to)).size, 3);
  for (const mail of h.state.sent) {
    assert.deepEqual(mail.from, { name: 'Brand', address: 'sales@brand.example.org' });
    assert.equal(mail.replyTo, 'sales@brand.example.org');
    assert.deepEqual(mail.envelope, { from: 'sales@brand.example.org', to: [mail.to] });
    assert.equal(mail.cc, undefined);
    assert.equal(mail.bcc, undefined);
    assert.match(mail.text, /Brand sales/);
  }
});

test('A09 跨任务换档案和联系人仍属于同一企业，发送服务重启也不重发', async (t) => {
  const h = await smtpHarness(t);
  const first = h.create();
  const company = buyer('same-company');
  await h.capture(first.id, company);
  h.jobs.finish(h.jobs.get(first.id), 'target_reached');
  const second = h.create();
  await h.capture(second.id, {
    ...company,
    id: 'another-record',
    email: 'buyer@same-company.example.org',
  });
  await h.pump();
  await h.pump();
  assert.equal(h.state.sent.length, 1);
  await h.service.close();
  h.service = new OutreachService(h.options);
  h.jobs.finish(h.jobs.get(second.id), 'target_reached');
  const third = h.create();
  await h.capture(third.id, company, true);
  await h.pump();
  assert.equal(h.state.sent.length, 1);
  assert.equal(h.service.deliveries(undefined, ['accepted']).length, 1);
});

for (const outcome of ['明确拒收', '提交后断线']) {
  test(`A10 SMTP${outcome}不记成功，重复调度和重启不能重复发送`, async (t) => {
    const h = await smtpHarness(t);
    const job = h.create();
    const lead = buyer('smtp-outcome');
    await h.capture(job.id, lead);
    if (outcome === '明确拒收') h.state.smtpResult = { accepted: [], rejected: [lead.email] };
    else h.state.error = new Error('connection closed after SMTP submission');
    await h.pump();
    assert.equal(h.state.sent.length, 1);
    const expected = outcome === '明确拒收' ? 'failed' : 'unknown';
    assert.equal(h.service.deliveries(undefined, [expected]).length, 1);
    assert.equal(h.service.deliveries(undefined, ['accepted']).length, 0);
    h.state.error = null;
    h.state.smtpResult = null;
    await h.mailboxes.save({ id: 'box', paused: false });
    await h.pump();
    await h.service.close();
    h.service = new OutreachService(h.options);
    await h.pump();
    assert.equal(h.state.sent.length, 1);
    assert.equal(h.service.deliveries(undefined, [expected]).length, 1);
  });
}

test('A01 未开启自动首发时，即使已保存合格客户也不能发送', async (t) => {
  const h = await smtpHarness(t);
  const job = h.create({ auto_first_touch: undefined });
  await h.capture(job.id, buyer('not-authorized'));
  await h.pump();
  assert.equal(h.state.sent.length, 0);
  assert.equal(h.service.campaigns().length, 0);
});

for (const readback of ['记录不存在', '域名不一致']) {
  test(`A03 保存后读回${readback}，不得按写入返回值直接首发`, async (t) => {
    const h = await smtpHarness(t);
    const job = h.create();
    const lead = buyer('not-confirmed');
    h.jobs.readLeads = async () =>
      readback === '记录不存在' ? [] : [{ ...lead, website: 'https://wrong-company.example.org' }];
    await assert.rejects(h.capture(job.id, lead), /读回核验失败/);
    await h.pump();
    assert.equal(h.state.sent.length, 0);
    assert.equal(h.service.deliveries().length, 0);
  });
}

for (const change of ['已回复', '勿联系', '产品撤回审核', '发件身份变化', '邮箱产品授权撤回']) {
  test(`A12 已排队后${change}，旧邮件不得提交`, async (t) => {
    const h = await smtpHarness(t);
    const plan = h.plan();
    const job = h.create({}, plan.id);
    const lead = buyer('changed-before-send');
    await h.capture(job.id, lead);
    await h.service.tick();
    await Promise.all([...h.service.preparing.values()]);
    assert.equal(h.service.deliveries(undefined, ['queued']).length, 1);
    if (change === '已回复') h.state.leads[0].status = '已回复';
    if (change === '勿联系')
      h.service.suppress({ customerId: lead.id, reason: '客户明确要求停止联系' });
    if (change === '产品撤回审核') h.products[0].status = 'draft';
    if (change === '发件身份变化') {
      await h.mailboxes.save({
        id: 'box',
        email: 'sales@changed-brand.example.org',
        brandName: 'Changed brand',
        displayName: 'Changed brand',
        website: 'https://changed-brand.example.org',
        clientPassword: 'synthetic-password',
      });
      await h.mailboxes.verify('box');
    }
    if (change === '邮箱产品授权撤回') await h.mailboxes.save({ id: 'box', productIds: [] });
    await h.pump();
    assert.equal(
      h.state.sent.length,
      0,
      JSON.stringify(h.state.sent.map(({ from, to }) => ({ from, to }))),
    );
    assert.equal(h.service.deliveries(undefined, ['accepted', 'unknown']).length, 0);
    assert.ok(h.service.deliveries(undefined, ['blocked']).some((row) => row.reason));
    if (change === '发件身份变化') {
      h.jobs.finish(h.jobs.get(job.id), 'target_reached');
      const next = h.create({}, plan.id);
      await h.capture(next.id, lead, true);
      await h.pump();
      assert.equal(h.state.sent.length, 1, '下一轮可使用新的有效身份处理待发客户');
      assert.equal(h.state.sent[0].from.address, 'sales@changed-brand.example.org');
    }
  });
}

test('默认关闭且拒绝非布尔授权；空名单不扫描全库，新增与更新保存后逐家首发', async () => {
  assert.equal(validateAutoFirstTouch(), false);
  for (const value of ['true', 1, null])
    assert.throws(() => validateAutoFirstTouch(value), { status: 400 });
  const h = harness();
  try {
    const outsider = buyer('outsider');
    h.state.leads.push(outsider);
    const job = h.create();
    await h.pump();
    assert.equal(h.state.sent.length, 0, '空的获客成果不能退化成全库发送');
    await h.capture(job.id, buyer('new-company'));
    await h.pump();
    assert.equal(h.state.sent.length, 1);
    assert.equal(h.jobs.get(job.id).status, 'running', '不等待整轮结束');
    assert.equal(h.state.generated[0].productId, 'pvc', '不限于搜索时的 roller blinds');
    await h.capture(job.id, buyer('updated-company'), true);
    const saved = h.jobs.get(job.id);
    saved.rows.push({ result: 'duplicate', record_id: outsider.id });
    h.jobs.save(saved);
    await h.pump();
    assert.deepEqual(h.state.sent.map((mail) => mail.to).sort(), [
      'info@new-company.example.org',
      'info@updated-company.example.org',
    ]);
    assert.equal(h.service.campaigns()[0].targetCount, null);
  } finally {
    await h.close();
  }
});

test('缺项客户列明原因，后续补齐自动发送；处理超过200家且没有累计发送目标', async () => {
  const h = harness();
  try {
    const job = h.create();
    for (let index = 0; index < 205; index++)
      await h.capture(job.id, { ...buyer(`missing-${index}`), email: '' });
    h.jobs.finish(h.jobs.get(job.id), 'research_limit');
    await h.pump();
    const campaign = h.service.campaigns()[0];
    assert.equal(campaign.customerIds.length, 205);
    assert.equal(h.service.deliveries(campaign.id, ['blocked']).length, 205);
    assert.ok(h.service.deliveries(campaign.id, ['blocked']).every((row) => row.reason));
    h.state.leads[204].email = 'info@missing-204.example.org';
    await h.pump();
    assert.equal(h.state.sent.length, 1);
    assert.equal(h.state.sent[0].to, 'info@missing-204.example.org');
    assert.equal(h.service.campaign(campaign.id).status, 'active');
  } finally {
    await h.close();
  }
});

for (const missing of ['邮箱启用', '产品审核', '邮箱产品授权', '邮箱连接', '固定签名'])
  test(`一次性获客结束后补齐${missing}配置，自动继续首发且不重复发送`, async () => {
    const h = harness();
    try {
      if (missing === '邮箱启用') h.boxes[0].paused = true;
      if (missing === '产品审核') h.products[0].status = 'draft';
      if (missing === '邮箱产品授权') h.boxes[0].productIds = [];
      if (missing === '邮箱连接') h.boxes[0].smtpStatus = 'error';
      if (missing === '固定签名') h.boxes[0].signature = '';
      const job = h.create();
      await h.capture(job.id, buyer('waiting'));
      h.jobs.finish(h.jobs.get(job.id), 'target_reached');
      await h.pump();
      assert.equal(h.state.sent.length, 0);
      h.boxes[0].paused = false;
      h.products[0].status = 'approved';
      h.boxes[0].productIds = ['pvc'];
      h.boxes[0].smtpStatus = 'connected';
      h.boxes[0].signature = 'Brand sales';
      await h.pump();
      await h.pump();
      assert.equal(h.state.sent.length, 1);
      assert.equal(h.state.sent[0].to, 'info@waiting.example.org');
    } finally {
      await h.close();
    }
  });

test('同轮自动纳入新增产品与邮箱，补处理旧缺项客户；已经准备的首封保持原产品和邮箱', async () => {
  const h = harness();
  try {
    const plan = h.plan();
    const first = h.create({}, plan.id);
    await h.capture(first.id, buyer('prepared'));
    await h.capture(first.id, buyer('waiting', 'roller blinds'));
    await h.service.tick();
    await Promise.all([...h.service.preparing.values()]);
    const queued = h.service.deliveries(undefined, ['queued'])[0];
    assert.ok(queued);
    h.products.push(
      { ...h.products[0], id: 'aaa', englishName: 'PVC shutters' },
      { ...h.products[0], id: 'roller', englishName: 'roller blinds' },
    );
    h.boxes.push({
      ...h.boxes[0],
      id: 'new-box',
      email: 'sales@new-brand.example.org',
      productIds: ['aaa', 'roller'],
    });
    await h.capture(first.id, buyer('next-customer', 'roller blinds'));
    await h.pump();
    await h.pump();
    const preserved = h.service.delivery(queued.id);
    assert.equal(preserved.status, 'accepted');
    assert.equal(preserved.mailboxId, 'box');
    assert.equal(preserved.candidate.productId, 'pvc');
    assert.ok(
      h.state.sent.some((mail) => mail.to === 'info@waiting.example.org' && mail.id === 'new-box'),
    );
    assert.ok(
      h.state.sent.some(
        (mail) => mail.to === 'info@next-customer.example.org' && mail.id === 'new-box',
      ),
    );
  } finally {
    await h.close();
  }
});

test('暂停与关闭获客计划阻止待发邮件；恢复时重新检查最新客户状态', async () => {
  const h = harness();
  try {
    const plan = h.plan();
    const job = h.create({}, plan.id);
    await h.capture(job.id, buyer('paused-customer'));
    await h.service.tick();
    await Promise.all([...h.service.preparing.values()]);
    h.plans.control(plan.id, 'pause');
    await h.pump();
    assert.equal(h.state.sent.length, 0);
    h.state.leads[0].status = '已回复';
    h.plans.control(plan.id, 'resume');
    await h.pump();
    assert.equal(h.state.sent.length, 0);
    assert.ok(h.service.deliveries().some((row) => row.status === 'blocked'));
    h.plans.control(plan.id, 'close');
    await h.pump();
    assert.equal(h.service.campaigns()[0].status, 'cancelled');
    assert.equal(h.service.deliveries(undefined, ['queued']).length, 0);
  } finally {
    await h.close();
  }
});

test('生成期间暂停，不提交邮件；单次任务可独立恢复首发', async () => {
  const h = harness();
  let release;
  try {
    const job = h.create();
    await h.capture(job.id, buyer('race-customer'));
    h.state.gate = new Promise((resolve) => {
      release = resolve;
    });
    await h.service.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.state.generated.length, 1);
    const staleCheckpoint = h.jobs.get(job.id);
    h.jobs.controlOutreach(job.id, false);
    h.jobs.save(staleCheckpoint);
    assert.equal(
      h.jobs.get(job.id).autoFirstTouchPaused,
      true,
      '获客异步回写不能撤销刚刚设置的暂停',
    );
    h.service.syncAcquisition();
    release();
    await Promise.all([...h.service.preparing.values()]);
    await h.pump();
    assert.equal(h.state.sent.length, 0);
    h.state.gate = null;
    h.jobs.controlOutreach(job.id, true);
    await h.pump();
    assert.equal(h.state.sent.length, 1);
  } finally {
    release?.();
    await h.close();
  }
});

test('发送前异步读取期间暂停，即使尚未同步触达状态也不提交邮件', async () => {
  const h = harness();
  let release;
  try {
    const job = h.create();
    await h.capture(job.id, buyer('dispatch-race'));
    await h.service.tick();
    await Promise.all([...h.service.preparing.values()]);
    let entered;
    const reading = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    h.service.loadLeads = async () => {
      entered();
      await gate;
      return structuredClone(h.state.leads);
    };
    const sending = h.service.tick();
    await reading;
    h.jobs.controlOutreach(job.id, false);
    release();
    await sending;
    assert.equal(h.state.sent.length, 0);
  } finally {
    release?.();
    await h.close();
  }
});

test('HTTP开关校验、查询及原计划控制贯通，未开启的历史计划不纳入自动首发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'automatic-first-touch-api-'));
  try {
    await withApp(
      {
        env: {
          ...feishuEnv,
          TAVILY_API_KEY: 'fixture',
          DEEPSEEK_API_KEY: 'fixture',
          OUTREACH_DATA_DIR: dir,
          OUTREACH_DB_PATH: ':memory:',
        },
        fetchImpl: withFeishuAuth(async () =>
          Response.json({ code: 0, data: { items: [], has_more: false } }),
        ),
        nativeImpl: {
          discover: async () => ({ candidates: [] }),
          decorateLeads: (value) => value,
          close() {},
        },
      },
      async (base) => {
        const post = (path, body) =>
          fetch(`${base}/api/v1/acquisition${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
            body: JSON.stringify(body),
          });
        const planResponse = await post('/schedules', {
          name: '原有计划',
          input: { ...input, auto_first_touch: false },
          timing: { repeat: 'once', startDate: '2030-01-01', times: ['09:00'] },
        });
        assert.equal(planResponse.status, 201);
        const plan = await planResponse.json();
        assert.equal(plan.input.auto_first_touch, false);
        assert.equal((await post(`/schedules/${plan.id}/auto-first-touch`, {})).status, 400);
        const enabled = await post(`/schedules/${plan.id}/auto-first-touch`, { enabled: true });
        assert.equal((await enabled.json()).input.auto_first_touch, true);
        assert.equal(
          (await (await fetch(`${base}/api/v1/outreach/state`)).json()).campaigns.length,
          0,
          '开启原计划不回扫历史库',
        );
        assert.equal((await post('/jobs', { ...input, auto_first_touch: 'true' })).status, 400);
        const response = await post('/jobs', input);
        assert.equal(response.status, 202);
        let job = await response.json();
        assert.equal(job.input.auto_first_touch, true);
        for (
          let attempt = 0;
          attempt < 100 && ['running', 'stopping'].includes(job.status);
          attempt++
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          job = await (await fetch(`${base}/api/v1/acquisition/jobs/${job.id}`)).json();
        }
        assert.equal(job.status, 'partial');
        const campaignId = `acquisition-${job.id}`;
        const details = await (
          await fetch(`${base}/api/v1/outreach/campaigns/${campaignId}`)
        ).json();
        assert.deepEqual(details.campaign.customerIds, []);
        const pause = await post(`/jobs/${job.id}/auto-first-touch`, { enabled: false });
        assert.equal((await pause.json()).autoFirstTouchPaused, true);
        const paused = await (
          await fetch(`${base}/api/v1/outreach/campaigns/${campaignId}`)
        ).json();
        assert.equal(paused.campaign.status, 'paused');
        const manualStart = await fetch(`${base}/api/v1/outreach/campaigns/${campaignId}/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ revision: 1 }),
        });
        assert.equal(manualStart.status, 409, '不能绕过获客计划单独启动托管的发送');
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重启与跨轮重复发现不重复首发；发送结果未知不自动重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'automatic-first-touch-'));
  const h = harness(join(dir, 'outreach.sqlite'));
  try {
    const first = h.create();
    await h.capture(first.id, buyer('once-only'));
    await h.pump();
    await h.service.close();
    h.service = new OutreachService(h.options);
    h.jobs.finish(h.jobs.get(first.id), 'target_reached');
    const next = h.create();
    await h.capture(next.id, buyer('once-only'), true);
    await h.pump();
    assert.equal(h.state.sent.length, 1);
    await h.capture(next.id, buyer('uncertain'));
    h.state.error = new Error('socket ended after submission');
    await h.pump();
    assert.equal(h.service.deliveries(undefined, ['unknown']).length, 1);
    const attempts = h.state.sent.length;
    h.state.error = null;
    h.boxes[0].paused = false;
    await h.pump();
    assert.equal(h.state.sent.length, attempts);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('定时计划追信开关只用于之后建立的轮次，已有计划不被改写', async () => {
  const h = harness();
  try {
    const plan = h.plan();
    const first = h.create({}, plan.id);
    h.service.syncAcquisition();
    const old = h.service.campaigns().find((c) => c.acquisitionSource.jobId === first.id);
    assert.equal(old.followUpEnabled, false);
    h.plans.save({ ...h.plans.get(plan.id), input: { ...input, auto_follow_up: true } });
    h.service.syncAcquisition();
    assert.equal(h.service.campaign(old.id).followUpEnabled, false);
    h.jobs.save({ ...h.jobs.get(first.id), status: 'completed' });
    const second = h.create({}, plan.id);
    h.service.syncAcquisition();
    const fresh = h.service.campaigns().find((c) => c.acquisitionSource.jobId === second.id);
    assert.equal(fresh.followUpEnabled, true);
    assert.equal(h.service.followUps.all().length, 0, '首封成功前不造任务');
    assert.throws(() => h.create({ auto_follow_up: 'yes' }), { status: 400 });
  } finally {
    await h.close();
  }
});

test('新轮次启动时停止旧轮次待发首封，保留已发送历史', async () => {
  const h = harness();
  try {
    const plan = h.plan();
    const first = h.create({}, plan.id);
    await h.capture(first.id, buyer('first-round'));
    await h.pump();
    assert.equal(h.service.deliveries(undefined, ['accepted']).length, 1);
    h.jobs.finish(h.jobs.get(first.id), 'target_reached');
    const second = h.create({}, plan.id);
    h.service.syncAcquisition();
    const old = h.service.campaign(`acquisition-${first.id}`);
    const current = h.service.campaign(`acquisition-${second.id}`);
    assert.equal(old.status, 'cancelled');
    assert.equal(old.acquisitionSource.roundId, first.id);
    assert.equal(current.status, 'active');
    assert.equal(h.service.deliveries(undefined, ['accepted']).length, 1);
  } finally {
    await h.close();
  }
});
