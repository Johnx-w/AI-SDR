import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchJobs, validateAutoFirstTouch } from '../server/batch-jobs.mjs';
import { AcquisitionSchedules } from '../server/acquisition-schedules.mjs';
import { acquisitionOutreachSources } from '../server/acquisition-outreach.mjs';
import { saveSequencePolicy } from '../server/outreach-sequence-policy.mjs';
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
function harness(path = ':memory:', sourceDir) {
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
    path: sourceDir ? join(sourceDir, 'jobs.sqlite') : ':memory:',
    schedule: false,
    scope: 'local',
    now: () => state.now,
    readLeads: async () => state.leads,
  });
  const plans = new AcquisitionSchedules({
    path: sourceDir ? join(sourceDir, 'schedules.sqlite') : ':memory:',
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
    pauseAcquisitionSource: (id, context) => plans.pauseSourceForOutreach(id, context),
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
      send: async (id, mail, options) => {
        options?.beforeSend?.();
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

for (const action of ['单次暂停', '单次取消', '计划暂停', '关闭首发', '关闭计划']) {
  test(`A06 SMTP连接准备期间${action}，尚未提交的邮件必须停止`, { timeout: 5000 }, async (t) => {
    const h = await smtpHarness(t);
    const plan = ['单次暂停', '单次取消'].includes(action) ? null : h.plan();
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
      if (action === '单次取消') h.jobs.cancelOutreach(job.id, true);
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
    assert.equal(h.state.sent.length, ['单次取消', '关闭计划'].includes(action) ? 0 : 1);
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

test('首封在 SMTP 提交边界冻结跟进策略，准备连接及等待应答时发布的版本分别生效', async (t) => {
  const h = await smtpHarness(t);
  const job = h.create({ auto_follow_up: true });
  await h.capture(job.id, buyer('policy-boundary'));
  h.state.beforeTransport = () => {
    h.state.beforeTransport = null;
    saveSequencePolicy(h.service, {
      revision: 1,
      name: '提交前生效',
      steps: [{ day: 2, instruction: '询问应用场景' }],
    });
  };
  h.state.afterSubmit = () => {
    h.state.afterSubmit = null;
    saveSequencePolicy(h.service, { revision: 2, name: '下一封首信生效', steps: [] });
  };
  await h.pump();
  const [first] = h.service.deliveries(undefined, ['accepted']);
  assert.equal(h.state.sent.length, 1);
  assert.equal(first.sequencePolicyRevision, 2);
  assert.equal(h.service.followUps.policy().revision, 3);
  assert.deepEqual(
    h.service.followUps.all().map(({ day, policyRevision }) => ({ day, policyRevision })),
    [{ day: 2, policyRevision: 2 }],
  );
});

for (const direction of ['inbound', 'outbound']) {
  const action = direction === 'inbound' ? '客户回信' : '业务员手动回信';
  test(`首封已交 SMTP、成功应答前收到同线程${action}，到期也不会自动追信`, async (t) => {
    const h = await smtpHarness(t);
    const job = h.create({ auto_follow_up: true });
    await h.capture(job.id, buyer('acknowledgement-race'));
    h.service.generator.generateFollowUp = async () => 'Would you consider this model?';
    h.state.afterSubmit = () => {
      h.state.afterSubmit = null;
      const [mail] = h.state.sent;
      const mailbox = h.mailboxes.get('box');
      h.state.now += 5000;
      const at = new Date(h.state.now).toISOString();
      h.service.conversations.putMessage(mailbox, {
        identity: 'earlier-than-acknowledgement',
        messageId: '<reply-before-acknowledgement@example.org>',
        inReplyTo: mail.messageId,
        references: [mail.messageId],
        direction,
        from: direction === 'inbound' ? mail.to : mailbox.email,
        to: direction === 'inbound' ? mailbox.email : mail.to,
        subject: 'Re: ' + mail.subject,
        bodyText:
          direction === 'inbound'
            ? 'Please send the specifications.'
            : 'I will send the specifications.',
        classification: 'normal',
        source: 'imap',
        deliveryStatus: direction === 'inbound' ? 'received' : 'sent',
        occurredAt: at,
        receivedAt: at,
      });
      h.state.now += 5000;
    };
    await h.pump();
    const [first] = h.service.deliveries(undefined, ['accepted']);
    assert.equal(h.state.sent.length, 1);
    assert.equal(h.state.now, h.state.sent[0].submittedAt + 10000);
    for (const day of [3, 7]) {
      h.state.now = Date.parse(first.sentAt) + day * 86400000;
      await h.pump(0);
      assert.equal(h.state.sent.length, 1);
    }
    assert.equal(h.service.followUps.pending().length, 0);
  });
}

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
    assert.ok(
      h.service
        .deliveries(undefined, [change === '已回复' || change === '勿联系' ? 'skipped' : 'blocked'])
        .some((row) => row.reason),
    );
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

test('无邮箱客户本轮跳过，补齐及同轮更新不恢复，新轮可首发；处理超过200家', async () => {
  const h = harness();
  try {
    const job = h.create();
    for (let index = 0; index < 205; index++)
      await h.capture(job.id, { ...buyer(`missing-${index}`), email: '' });
    h.jobs.finish(h.jobs.get(job.id), 'research_limit');
    await h.pump();
    const campaign = h.service.campaigns()[0];
    assert.equal(campaign.customerIds.length, 205);
    assert.equal(h.service.deliveries(campaign.id, ['skipped']).length, 205);
    assert.ok(
      h.service.deliveries(campaign.id, ['skipped']).every((row) => row.reason && row.skippedAt),
    );
    assert.equal(campaign.deliveryGroups.attention, 0);
    assert.equal(campaign.lastError, '');
    assert.equal(h.state.generated.length, 0);
    h.state.leads[204].email = 'info@missing-204.example.org';
    await h.capture(job.id, h.state.leads[204], true);
    await h.pump();
    assert.equal(h.state.sent.length, 0);
    assert.equal(h.service.deliveries(campaign.id).length, 205);
    const next = h.create();
    await h.capture(next.id, h.state.leads[204], true);
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

test('同轮新增产品与邮箱只接纳新客户，已跳过客户不恢复；已准备首封保持原身份', async () => {
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
    assert.equal(
      h.state.sent.some((mail) => mail.to === 'info@waiting.example.org'),
      false,
    );
    assert.equal(
      h.service.deliveries(undefined, ['skipped']).some((row) => row.customerId === 'waiting'),
      true,
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
    assert.ok(h.service.deliveries().some((row) => row.status === 'skipped'));
    h.plans.control(plan.id, 'close');
    await h.pump();
    assert.equal(h.service.campaigns()[0].status, 'cancelled');
    assert.equal(h.service.deliveries(undefined, ['queued']).length, 0);
  } finally {
    await h.close();
  }
});

test('关闭获客计划恢复后重新核对未发客户，不重复首发或恢复永久取消的单次首发', async () => {
  const h = harness();
  try {
    const plan = h.plan();
    const first = h.create({}, plan.id);
    await h.capture(first.id, buyer('already-sent'));
    await h.pump();
    assert.equal(h.state.sent.length, 1);
    h.jobs.finish(h.jobs.get(first.id), 'target_reached');
    const pending = h.create({}, plan.id);
    await h.capture(pending.id, buyer('still-eligible'));
    await h.capture(pending.id, buyer('now-replied'));
    await h.service.tick();
    await Promise.all([...h.service.preparing.values()]);
    h.plans.control(plan.id, 'close');
    await h.pump();
    assert.equal(h.state.sent.length, 1, '关闭期间没有提交待发邮件');
    h.state.leads.find((lead) => lead.id === 'now-replied').status = '已回复';
    h.plans.control(plan.id, 'resume');
    await h.pump();
    await h.pump();
    assert.deepEqual(h.state.sent.map((mail) => mail.to).sort(), [
      'info@already-sent.example.org',
      'info@still-eligible.example.org',
    ]);
    h.jobs.finish(h.jobs.get(pending.id), 'target_reached');
    const cancelled = h.create();
    await h.capture(cancelled.id, buyer('permanently-cancelled'));
    h.jobs.cancelOutreach(cancelled.id, true);
    h.plans.control(plan.id, 'close');
    h.plans.control(plan.id, 'resume');
    await h.pump();
    assert.equal(h.state.sent.length, 2, '计划恢复不撤销轮次的永久取消');
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

test('历史单次获客可永久取消自动首发，保留已发送记录且不能恢复', async () => {
  const h = harness();
  try {
    const job = h.create({ auto_follow_up: true });
    await h.capture(job.id, buyer('already-sent'));
    await h.capture(job.id, { ...buyer('missing-email'), email: '' });
    h.jobs.finish(h.jobs.get(job.id), 'target_reached');
    await h.pump();
    assert.equal(h.service.deliveries(undefined, ['accepted']).length, 1);
    assert.equal(h.service.deliveries(undefined, ['skipped']).length, 1);
    assert.equal(h.service.followUps.pending().length, 2);

    const stale = h.jobs.get(job.id);
    assert.throws(() => h.jobs.cancelOutreach(job.id, false), { status: 400 });
    h.jobs.cancelOutreach(job.id, true);
    h.jobs.save(stale);
    assert.equal(h.jobs.get(job.id).autoFirstTouchCancelled, true);
    assert.throws(() => h.jobs.controlOutreach(job.id, true), { status: 409 });
    h.service.syncAcquisition();
    assert.equal(h.service.campaign(`acquisition-${job.id}`).status, 'cancelled');
    assert.equal(h.service.deliveries(undefined, ['accepted']).length, 1);
    assert.equal(h.service.deliveries(undefined, ['cancelled']).length, 0);
    assert.equal(h.service.deliveries(undefined, ['skipped']).length, 1);
    await h.pump();
    assert.equal(h.state.sent.length, 1);
    assert.equal(h.service.followUps.pending().length, 0);
    assert.equal(h.service.followUps.all().filter((row) => row.status === 'cancelled').length, 2);
  } finally {
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
        assert.equal((await post(`/jobs/${job.id}/auto-first-touch/cancel`, {})).status, 400);
        const cancelled = await post(`/jobs/${job.id}/auto-first-touch/cancel`, {
          confirmed: true,
        });
        assert.equal((await cancelled.json()).autoFirstTouchCancelled, true);
        const ended = await (await fetch(`${base}/api/v1/outreach/campaigns/${campaignId}`)).json();
        assert.equal(ended.campaign.status, 'cancelled');
        assert.equal(
          (await post(`/jobs/${job.id}/auto-first-touch`, { enabled: true })).status,
          409,
        );
        assert.equal(
          (await post(`/jobs/${job.id}/auto-first-touch/cancel`, { confirmed: true })).status,
          200,
        );
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
    assert.equal(old.status, 'completed');
    assert.equal(old.acquisitionSource.roundId, first.id);
    assert.equal(current.status, 'active');
    assert.equal(h.service.deliveries(undefined, ['accepted']).length, 1);
  } finally {
    await h.close();
  }
});

test('自动获客首发与跟进只在当前步骤需要 AI 时调用，真人回复停止追信', async (t) => {
  const h = await smtpHarness(t);
  delete h.service.generator;
  const calls = [];
  let configured = false;
  h.service.getEnv = () =>
    configured
      ? {
          RESEARCH_MODEL_PROVIDER: 'openai_compatible',
          RESEARCH_MODEL_BASE_URL: 'https://fixture.invalid/v1',
          RESEARCH_MODEL_API_KEY: 'fixture',
          RESEARCH_MODEL_MODEL: 'fixture',
        }
      : {};
  h.service.fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://fixture.invalid/v1/chat/completions');
    const request = JSON.parse(init.body);
    const context = JSON.parse(request.messages[1].content);
    calls.push(context);
    assert.equal(context.day, 7);
    assert.deepEqual(request.response_format.json_schema.schema.required, ['subject']);
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              subject: 'Update for ' + context.company,
            }),
          },
        },
      ],
    });
  };
  saveSequencePolicy(h.service, {
    ...h.service.followUps.policy(),
    firstTemplate: {
      subject: 'Introduction | {{company}}',
      body: 'At {{brand}}, we supply {{product}}.',
    },
    steps: [
      { day: 3, instruction: '', template: { subject: '', body: 'Following up on {{product}}.' } },
      {
        day: 7,
        instruction: 'Write a short subject.',
        template: {
          subject: '{{ai_subject}}',
          body: 'Would more information about {{product}} help?',
        },
      },
    ],
  });
  const job = h.create({ auto_follow_up: true });
  for (const id of ['alpine', 'bay', 'cedar']) {
    await h.capture(job.id, buyer(id));
    await h.pump();
  }
  assert.equal(h.state.sent.length, 3);
  assert.equal(calls.length, 0);
  const first = new Map(
    h.service.deliveries(undefined, ['accepted']).map((m) => [m.customerId, m]),
  );
  for (const [id, m] of first) {
    assert.equal(m.subject, 'Introduction | Company ' + id);
    assert(m.bodyText.includes('At Brand, we supply PVC shutters.'));
  }
  for (const [id, classification, bodyText] of [
    [
      'alpine',
      'auto_reply',
      'I am out of the office until Monday.\nFor urgent matters, contact Jordan Lee at jordan@alpine.example.',
    ],
    ['cedar', 'normal', 'Please send a quote for 120 units.'],
  ]) {
    const m = first.get(id),
      mailbox = h.mailboxes.get('box');
    const at = new Date(h.state.now).toISOString();
    h.service.conversations.putMessage(mailbox, {
      identity: 'reply-' + id,
      messageId: '<reply-' + id + '@example.org>',
      inReplyTo: m.messageId,
      references: [m.messageId],
      direction: 'inbound',
      from: m.to,
      to: m.from,
      subject: 'Re: ' + m.subject,
      bodyText,
      classification,
      source: 'imap',
      deliveryStatus: 'received',
      occurredAt: at,
      receivedAt: at,
    });
  }
  for (const day of [3, 7]) {
    if (day === 7) configured = true;
    h.state.now =
      Math.max(...[...first.values()].map((m) => Date.parse(m.sentAt))) + day * 86400000;
    await h.pump(0);
    await h.pump(10);
    const sent = h.state.sent.slice(day === 3 ? 3 : 5);
    assert.deepEqual(
      sent.map((m) => m.to).sort(),
      [first.get('alpine').to, first.get('bay').to].sort(),
    );
    for (const m of sent) {
      const original = [...first.values()].find((item) => item.to === m.to);
      assert.equal(m.inReplyTo, original.messageId);
      assert.equal(
        m.subject,
        day === 3 ? 'Re: ' + original.subject : 'Update for ' + original.companyName,
      );
      assert(
        m.text.includes(
          day === 3
            ? 'Following up on PVC shutters.'
            : 'Would more information about PVC shutters help?',
        ),
      );
    }
    assert.equal(calls.length, day === 3 ? 0 : 2);
  }
  await h.pump(60);
  assert.equal(h.state.sent.length, 7);
  assert.equal(calls.length, 2);
});

test('定时获客自然换轮仍按原首封的自定义日期同线程跟进，定时计划暂停时暂缓', async () => {
  const h = harness();
  try {
    const plan = h.plan();
    h.plans.save({ ...h.plans.get(plan.id), input: { ...input, auto_follow_up: true } });
    const rule = saveSequencePolicy(h.service, {
      ...h.service.followUps.policy(),
      steps: [{ day: 2, instruction: '确认采购需求' }],
    });
    const first = h.create({}, plan.id);
    await h.capture(first.id, buyer('retained'));
    h.options.mailboxes.readMailbox = async () => ({ folders: [], hasMore: false });
    h.service.generator.generateFollowUp = async ({ instruction }) => {
      assert.equal(instruction, rule.steps[0].instruction);
      return 'Would you consider this model?';
    };
    await h.pump();
    const sent = h.service.deliveries(undefined, ['accepted'])[0];
    assert.ok(sent);
    h.jobs.finish(h.jobs.get(first.id), 'target_reached');
    h.create({}, plan.id);
    h.service.syncAcquisition();
    h.plans.control(plan.id, 'pause');
    h.state.now = Date.parse(sent.sentAt) + 2 * 86400000;
    await h.pump(0);
    assert.equal(h.state.sent.length, 1);
    assert.equal(h.service.followUps.pending().length, 1);
    h.plans.control(plan.id, 'resume');
    await h.pump(60);
    assert.equal(h.state.sent.length, 2, JSON.stringify(h.service.followUps.all()));
    assert.equal(h.state.sent[1].inReplyTo, sent.messageId);
    assert.equal(h.service.followUps.all()[0].policyRevision, rule.revision);
  } finally {
    await h.close();
  }
});

test('获客计划开启自动首发后按邮箱主体入队，重复调度保留同一记录', async (t) => {
  const h = await smtpHarness(t);
  const plan = h.plan();
  const job = h.create({}, plan.id);
  const platform = { ...buyer('radio-customer'), email: 'support@radio.example' };
  const own = { ...buyer('shutter-customer'), email: 'info@partner.example' };
  own.contactEvidence = [
    {
      kind: 'email',
      value: own.email,
      source_url: own.website + '/contact',
      quote: 'Contact us at ' + own.email,
    },
  ];
  await h.capture(job.id, platform);
  await h.capture(job.id, own);
  await h.service.tick();
  await Promise.all([...h.service.preparing.values()]);
  assert.deepEqual(
    h.service.deliveries(undefined, ['queued']).map((row) => row.to),
    [own.email],
  );
  assert.equal(h.service.deliveries(undefined, ['skipped'])[0].reasonCode, 'contact_unverified');
  await h.pump();
  await h.pump();
  assert.deepEqual(
    h.state.sent.map((row) => row.to),
    [own.email],
  );
});

test('旧版本已排队的同域首封在重启后按原地址发送一次', async (t) => {
  const h = await smtpHarness(t);
  const job = h.create();
  const lead = buyer('queued-before-upgrade');
  await h.capture(job.id, lead);
  await h.service.tick();
  await Promise.all([...h.service.preparing.values()]);
  const [queued] = h.service.deliveries(undefined, ['queued']);
  delete queued.candidate.leadSnapshot.contactIssues;
  h.service.putDelivery(queued);
  await h.service.close();
  h.service = new OutreachService(h.options);
  await h.pump();
  await h.pump();
  assert.deepEqual(
    h.state.sent.map((mail) => mail.to),
    [lead.email],
  );
  assert.equal(h.service.delivery(queued.id).status, 'accepted');
});

test('删除后直接恢复零新安排；重新保存授权只建立一个新安排，旧计划不复活', async () => {
  const h = harness();
  try {
    const job = h.create();
    await h.capture(job.id, buyer('fresh-authorization'));
    h.service.syncAcquisition();
    const oldId = `acquisition-${job.id}`;
    h.service.deleteCampaign(oldId, h.service.campaign(oldId).revision, true);
    await h.jobs.resume(job.id, {
      sourceControlRevision: h.jobs.get(job.id).sourceControlRevision || 0,
    });
    h.service.syncAcquisition();
    assert.equal(h.jobs.get(job.id).input.auto_first_touch, false);
    assert.equal(h.service.campaigns().length, 1);
    assert.equal(h.state.sent.length, 0);
    h.jobs.pause(job.id);
    const revision = h.jobs.get(job.id).sourceControlRevision;
    const enabled = h.jobs.controlOutreach(job.id, true, { sourceControlRevision: revision });
    h.jobs.controlOutreach(job.id, true, { sourceControlRevision: revision });
    h.service.syncAcquisition();
    const newId = `acquisition-${job.id}-g1`;
    assert.equal(enabled.manualPaused, true);
    assert.equal(h.service.campaign(newId).status, 'paused');
    assert.equal(h.service.campaign(oldId).deletedAt != null, true);
    assert.equal(h.service.campaigns().length, 2);
    await h.jobs.resume(job.id, {
      sourceControlRevision: h.jobs.get(job.id).sourceControlRevision || 0,
    });
    await h.pump();
    assert.equal(h.state.sent.length, 1);
    h.jobs.pause(job.id, { outreachPlanId: newId, disableFirstTouch: true });
    assert.throws(() => h.jobs.controlOutreach(job.id, true, { sourceControlRevision: revision }), {
      status: 409,
    });
  } finally {
    await h.close();
  }
});

test('定时来源重新授权保留暂停，重复保存唯一且过期编辑不能重新开启', async () => {
  const h = harness();
  try {
    const plan = h.plan();
    const job = h.create({}, plan.id);
    h.service.syncAcquisition();
    const oldId = `acquisition-${job.id}`;
    h.service.deleteCampaign(oldId, 1, true);
    const paused = h.plans.get(plan.id);
    const enabled = h.plans.controlOutreach(plan.id, true, {
      sourceControlRevision: paused.sourceControlRevision,
    });
    h.plans.controlOutreach(plan.id, true, { sourceControlRevision: paused.sourceControlRevision });
    h.service.syncAcquisition();
    assert.equal(enabled.status, 'paused');
    assert.equal(h.service.campaigns().length, 2);
    assert.equal(h.service.campaign(`acquisition-${job.id}-g1`).status, 'paused');
    h.plans.pauseSourceForOutreach(job.id, { outreachPlanId: `acquisition-${job.id}-g1` });
    assert.throws(
      () =>
        h.plans.update(plan.id, {
          ...enabled,
          sourceControlRevision: paused.sourceControlRevision,
        }),
      { status: 409 },
    );
    assert.equal(h.plans.get(plan.id).input.auto_first_touch, false);
  } finally {
    await h.close();
  }
});

test('同轮重新授权不重试已跳过客户；重启只处理此前未尝试客户', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reauthorization-'));
  const h = harness(join(dir, 'outreach.sqlite'));
  try {
    const job = h.create();
    await h.capture(job.id, { ...buyer('skipped-before'), email: '' });
    await h.pump();
    assert.equal(h.service.deliveries(`acquisition-${job.id}`)[0].status, 'skipped');
    const oldId = `acquisition-${job.id}`;
    h.service.deleteCampaign(oldId, h.service.campaign(oldId).revision, true);
    h.state.leads[0] = buyer('skipped-before');
    await h.capture(job.id, buyer('untouched-after'));
    await h.capture(job.id, { ...buyer('no-mail-control'), email: '' });
    const revision = h.jobs.get(job.id).sourceControlRevision;
    h.jobs.controlOutreach(job.id, true, { sourceControlRevision: revision });
    await h.jobs.resume(job.id, {
      sourceControlRevision: h.jobs.get(job.id).sourceControlRevision || 0,
    });
    await h.service.close();
    h.service = new OutreachService(h.options);
    await h.pump();
    assert.deepEqual(
      h.state.sent.map((mail) => mail.to),
      ['info@untouched-after.example.org'],
    );
    assert.equal(h.service.campaigns().length, 2);
    assert.equal(h.service.campaign(oldId).deletedAt != null, true);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const name of ['legacy-alpha', 'legacy-beta', 'current-control', 'changed-identity']) {
  test('升级前排队摘要受控迁移 ' + name, async () => {
    const h = harness();
    try {
      const job = h.create();
      await h.capture(job.id, buyer(name));
      await h.service.tick();
      await Promise.all([...h.service.preparing.values()]);
      const [queued] = h.service.deliveries(undefined, ['queued']);
      if (name !== 'current-control') {
        const m = h.boxes[0];
        queued.senderVersion = createHash('sha256')
          .update(
            JSON.stringify([
              m.id,
              m.email,
              m.displayName,
              m.signature,
              ...(m.signatureDesign ? [m.signatureDesign] : []),
              [...m.productIds].sort(),
            ]),
          )
          .digest('hex');
        h.service.putDelivery(queued);
      }
      if (name === 'changed-identity') h.boxes[0].displayName = 'Changed';
      await h.pump();
      assert.equal(
        h.service.delivery(queued.id).status,
        name === 'changed-identity' ? 'blocked' : 'accepted',
      );
      assert.equal(h.state.sent.length, name === 'changed-identity' ? 0 : 1);
    } finally {
      await h.close();
    }
  });
}

for (const failure of ['schedule', 'job']) {
  test('定时重新授权写入失败无新安排 ' + failure, async () => {
    const h = harness();
    try {
      const plan = h.plan(),
        job = h.create({}, plan.id);
      h.service.syncAcquisition();
      h.service.deleteCampaign('acquisition-' + job.id, 1, true);
      const paused = h.plans.get(plan.id);
      h.jobs.onOutreachChange = () => h.service.syncAcquisition();
      const db = failure === 'schedule' ? h.plans.db : h.jobs.db;
      const table = failure === 'schedule' ? 'schedules' : 'jobs';
      db.exec(
        `CREATE TRIGGER fail_authorization BEFORE UPDATE ON ${table} WHEN json_extract(NEW.data,'$.input.auto_first_touch')=1 BEGIN SELECT RAISE(ABORT,'write failed'); END`,
      );
      assert.throws(
        () =>
          h.plans.update(plan.id, {
            ...paused,
            input: { ...paused.input, auto_first_touch: true },
          }),
        /write failed/,
      );
      assert.equal(h.jobs.get(job.id).input.auto_first_touch, false);
      assert.equal(h.jobs.get(job.id).outreachGeneration || 0, 0);
      assert.equal(h.plans.get(plan.id).input.auto_first_touch, false);
      h.service.syncAcquisition();
      assert.equal(h.service.campaigns().length, 1);
      assert.equal(h.state.sent.length, 0);
      db.exec('DROP TRIGGER fail_authorization');
      h.plans.update(plan.id, { ...paused, input: { ...paused.input, auto_first_touch: true } });
      h.plans.controlOutreach(plan.id, true, {
        sourceControlRevision: paused.sourceControlRevision,
      });
      h.service.syncAcquisition();
      assert.equal(h.jobs.get(job.id).outreachGeneration, 1);
      assert.equal(h.service.campaigns().length, 2);
    } finally {
      await h.close();
    }
  });
}

test('旧页面恢复不能撤销较新删除暂停', async () => {
  const h = harness();
  try {
    const plan = h.plan(),
      job = h.create({}, plan.id);
    h.service.syncAcquisition();
    h.service.deleteCampaign('acquisition-' + job.id, 1, true);
    const oldJob = h.jobs.get(job.id),
      oldPlan = h.plans.get(plan.id);
    h.plans.controlOutreach(plan.id, true, {
      sourceControlRevision: oldPlan.sourceControlRevision,
    });
    h.service.syncAcquisition();
    h.service.deleteCampaign('acquisition-' + job.id + '-g1', 1, true);
    await assert.rejects(
      h.jobs.resume(job.id, { sourceControlRevision: oldJob.sourceControlRevision }),
      { status: 409 },
    );
    assert.throws(
      () =>
        h.plans.control(plan.id, 'resume', {
          sourceControlRevision: oldPlan.sourceControlRevision,
        }),
      { status: 409 },
    );
    assert.equal(h.jobs.get(job.id).manualPaused, true);
    assert.equal(h.plans.get(plan.id).status, 'paused');
  } finally {
    await h.close();
  }
});

test('失败授权恢复只回滚控制字段，保留收尾进度及较新决定，重启不发布授权', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'authorization-journal-'));
  const h = harness(join(dir, 'outreach.sqlite'), dir);
  let restartedJobs, restartedPlans;
  try {
    const plan = h.plan(),
      job = h.create({}, plan.id);
    h.service.syncAcquisition();
    h.service.deleteCampaign('acquisition-' + job.id, 1, true);
    const paused = h.plans.get(plan.id);
    h.plans.db.exec(
      "CREATE TRIGGER fail_all BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT,'write failed'); END",
    );
    assert.throws(
      () =>
        h.plans.controlOutreach(plan.id, true, {
          sourceControlRevision: paused.sourceControlRevision,
        }),
      /write failed/,
    );
    const checkpoint = h.jobs.get(job.id);
    checkpoint.rows.push({ record_id: 'saved-during-failure', stored: true });
    checkpoint.inserted = 1;
    checkpoint.cursor = 7;
    h.jobs.save(checkpoint);
    h.plans.db.exec('DROP TRIGGER fail_all');
    const recovered = h.plans.get(plan.id);
    assert.equal(recovered.input.auto_first_touch, false);
    assert.equal(h.jobs.get(job.id).input.auto_first_touch, false);
    assert.equal(h.jobs.get(job.id).cursor, 7);
    assert.equal(h.jobs.get(job.id).inserted, 1);
    assert.equal(h.jobs.get(job.id).rows.at(-1).record_id, 'saved-during-failure');
    const resumed = h.plans.control(plan.id, 'resume', {
      sourceControlRevision: recovered.sourceControlRevision,
    });
    h.plans.control(plan.id, 'resume', { sourceControlRevision: recovered.sourceControlRevision });
    h.plans.control(plan.id, 'delete');
    await h.close();
    restartedJobs = new BatchJobs({
      path: join(dir, 'jobs.sqlite'),
      scope: 'local',
      schedule: false,
    });
    restartedPlans = new AcquisitionSchedules({
      path: join(dir, 'schedules.sqlite'),
      jobs: () => restartedJobs,
    });
    assert.equal(restartedPlans.get(plan.id).sourceDeletedAt != null, true);
    assert.ok(restartedPlans.get(plan.id).sourceControlRevision > resumed.sourceControlRevision);
    assert.equal(restartedJobs.get(job.id).input.auto_first_touch, false);
    assert.equal(restartedJobs.get(job.id).cursor, 7);
    assert.equal(restartedJobs.get(job.id).rows.at(-1).record_id, 'saved-during-failure');
  } finally {
    if (restartedPlans) {
      restartedPlans.close();
      restartedJobs.close();
    } else await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const newer of [false, true]) {
  test('未完成授权跨重启恢复并保留较新控制 ' + newer, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'authorization-crash-'));
    const h = harness(join(dir, 'outreach.sqlite'), dir);
    let jobs, plans;
    try {
      const plan = h.plan(),
        job = h.create({}, plan.id);
      h.service.syncAcquisition();
      h.service.deleteCampaign('acquisition-' + job.id, 1, true);
      const paused = h.plans.get(plan.id);
      h.plans.db.exec(
        "CREATE TRIGGER fail_all BEFORE UPDATE ON schedules BEGIN SELECT RAISE(ABORT,'write failed'); END",
      );
      assert.throws(
        () =>
          h.plans.controlOutreach(plan.id, true, {
            sourceControlRevision: paused.sourceControlRevision,
          }),
        /write failed/,
      );
      if (newer) {
        h.jobs.pause(job.id, { outreachPlanId: 'newer-deletion', disableFirstTouch: true });
        h.jobs.pause(job.id);
      }
      const revision = h.jobs.get(job.id).sourceControlRevision;
      h.plans.db.exec('DROP TRIGGER fail_all');
      await h.close();
      jobs = new BatchJobs({ path: join(dir, 'jobs.sqlite'), schedule: false, scope: 'local' });
      plans = new AcquisitionSchedules({ path: join(dir, 'schedules.sqlite'), jobs: () => jobs });
      assert.equal(plans.get(plan.id).input.auto_first_touch, false);
      assert.equal(jobs.get(job.id).input.auto_first_touch, false);
      assert.equal(jobs.get(job.id).outreachGeneration || 0, 0);
      if (newer) assert.equal(jobs.get(job.id).sourceControlRevision, revision);
      assert.equal(acquisitionOutreachSources(jobs, plans).length, 0);
    } finally {
      if (plans) {
        plans.close();
        jobs.close();
      } else await h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
