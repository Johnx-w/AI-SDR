import test from 'node:test';
import assert from 'node:assert/strict';
import { OutreachService } from '../server/outreach-service.mjs';
import { handleOutreach } from '../server/outreach-api.mjs';
import { siteAllowsProduct } from '../src/domain/mail-site.mjs';
import { defaultTemplate } from '../src/domain/sequence-email.mjs';
import { outreachProductScope } from '../server/outreach-content.mjs';
const sequencePath = '/sequence-policy?mailboxId=box';
const sampleProduct = { id: 'sample', status: 'approved', englishName: 'Roller blinds' };
function api(t) {
  const mailbox = {
    id: 'box',
    website: 'https://dealer.test',
    brandName: 'Dealer',
    email: 'sales@dealer.test',
    configured: true,
    smtpStatus: 'connected',
    displayName: 'Dealer',
    signature: 'Dealer sales',
    productIds: ['sample'],
  };
  const service = new OutreachService({
    mailboxes: { list: () => [mailbox], get: (id) => (id === mailbox.id ? mailbox : undefined) },
    products: () => [sampleProduct],
  });
  t.after(() => service.close());
  const call = (path, method = 'GET', body) =>
    handleOutreach({
      request: { method },
      url: new URL('/api/v1/outreach' + path, 'http://localhost'),
      service,
      readJson: async () => body,
    });
  return { service, call, mailbox };
}
test('邮箱标签批量增删可重试，合并保留关联，冲突整批回滚', async (t) => {
  const { call } = api(t);
  const a = (await call('/mailbox-tags', 'POST', { name: 'Europe' })).tags[0];
  await assert.rejects(call('/mailbox-tags', 'POST', { name: ' europe ' }), { status: 409 });
  const b = (await call('/mailbox-tags', 'POST', { name: '项目' })).tags.find((x) => x.id !== a.id);
  const assign = { mailboxIds: ['box'], tagIds: [a.id, b.id], action: 'add' };
  for (let i = 0; i < 2; i++)
    assert.equal((await call('/mailbox-tags/assign', 'POST', assign)).assignments.length, 2);
  await assert.rejects(
    call('/mailbox-tags/assign', 'POST', {
      ...assign,
      mailboxIds: ['box', 'removed'],
      action: 'remove',
    }),
    { status: 404 },
  );
  assert.equal((await call('/mailbox-tags')).assignments.length, 2);
  const merged = await call('/mailbox-tags/' + a.id + '/merge', 'POST', { targetId: b.id });
  assert.deepEqual(
    merged.assignments.map((x) => [x.mailboxId, x.tagId]),
    [['box', b.id]],
  );
  await call('/mailbox-tags/' + b.id, 'PATCH', { name: '北美' });
  assert.equal((await call('/mailbox-tags')).tags[0].name, '北美');
  const empty = await call('/mailbox-tags/' + b.id, 'DELETE');
  assert.equal(empty.tags.length + empty.assignments.length, 0);
});

test('预览选项只读本地配置且不返回联系人清单', async (t) => {
  const { service, call } = api(t);
  service.fetchImpl = () => assert.fail('不应读取外部服务');
  const result = await call('/sequence-policy/preview-options');
  assert.equal(result.mailboxes.length, 1);
  assert.equal(result.categories.length, 12);
  assert.equal(result.items, undefined);
});

test('保存、重读及重试均保留模板和自定义变量，步骤之间独立', async (t) => {
  const { call } = api(t);
  const initial = await call(sequencePath);
  const custom = {
    key: 'custom_Opening',
    label: 'Opening',
    instruction: 'Describe the public product range.',
  };
  const input = {
    ...initial,
    firstTemplate: { subject: '{{company}}', body: '{{custom_Opening}}', variables: [custom] },
    steps: [
      { day: 2, instruction: '', template: { subject: '', body: '{{product}} for {{company}}?' } },
      { day: 5, instruction: 'Ask one new question.' },
    ],
  };
  const saved = await call(sequencePath, 'PUT', input);
  assert.deepEqual(saved.steps, input.steps);
  assert.deepEqual((await call(sequencePath)).firstTemplate, input.firstTemplate);
  assert.deepEqual(await call(sequencePath, 'PUT', input), saved);
  await assert.rejects(
    call(sequencePath, 'PUT', {
      ...saved,
      firstTemplate: { subject: '{{unknown}}', body: 'Draft' },
    }),
    { status: 400 },
  );
});
test('跟进序列分页读取正式首封与该客户的两次跟进，不取正文或混入测试计划', async (t) => {
  const { service, call } = api(t);
  service.putCampaign({
    id: 'plan',
    name: '客户开发',
    mode: 'production',
    status: 'active',
    followUpEnabled: true,
    mailboxIds: ['box'],
  });
  service.putCampaign({ id: 'internal', name: '内部验证', mode: 'test', status: 'active' });
  for (let i = 0; i < 24; i++) {
    const d = {
      id: 'mail' + i,
      mailboxId: 'box',
      from: 'sales@dealer.test',
      campaignId: 'plan',
      mode: 'production',
      companyName: 'Company ' + i,
      status: i === 23 ? 'failed' : 'accepted',
      sentAt: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString(),
      bodyText: 'private long body',
    };
    service.putDelivery(d);
    service.followUps.schedule(d, service.campaign('plan'));
  }
  const list = await call('/sequences');
  assert.equal(list.total, 1);
  assert.equal(list.items[0].firstCount, 23);
  assert.equal(list.items[0].pendingCount, 46);
  const page = await call('/sequences/plan?page=3&pageSize=10');
  assert.equal(page.total, 23);
  assert.equal(page.page, 3);
  assert.equal(page.items.length, 3);
  assert.equal(page.items[0].firstId, 'mail2');
  assert.equal(page.items[0].followUps.length, 2);
  assert.deepEqual(
    page.steps.map((x) => x.offsetHours),
    [0, 72, 168],
  );
  assert.ok(!JSON.stringify(page).includes('private long body'));
  await assert.rejects(call('/sequences/internal'), { status: 404 });
});

test('工作区无计划时可发布跟进策略，重复保存幂等，并发过期写入不会覆盖', async (t) => {
  const { call } = api(t),
    initial = await call(sequencePath);
  assert.deepEqual(
    initial.steps.map((s) => s.day),
    [3, 7],
  );
  assert.equal((await call('/sequences')).total, 0);
  const input = {
    revision: initial.revision,
    name: '展会跟进',
    steps: [
      { day: 6, instruction: '询问测试进展' },
      { day: 1, instruction: '确认选型' },
    ],
  };
  const changed = await call(sequencePath, 'PUT', input);
  assert.deepEqual(
    changed.steps.map((s) => s.day),
    [1, 6],
  );
  assert.deepEqual(await call(sequencePath, 'PUT', input), changed);
  for (const steps of [
    [{ day: 0, instruction: 'x' }],
    [{ day: 366, instruction: 'x' }],
    [{ day: 1, template: { subject: '', body: ' ' } }],
    [changed.steps[0], changed.steps[0]],
  ])
    await assert.rejects(call(sequencePath, 'PUT', { ...changed, steps }), { status: 400 });
  const writes = await Promise.allSettled(
    ['A', 'B'].map((name) => call(sequencePath, 'PUT', { ...changed, name })),
  );
  assert.equal(writes.filter((w) => w.status === 'fulfilled').length, 1);
  assert.equal(writes.find((w) => w.status === 'rejected').reason.status, 409);
});

test('同一计划的不同首封沿用各自版本，零步和旧格式记录均不会因重新排程而变化', async (t) => {
  const { service, call } = api(t);
  const plan = {
    id: 'plan',
    name: '采购团队',
    scope: service.getScope(),
    mailboxIds: ['box'],
    filters: { products: [sampleProduct.id] },
    productScopes: [outreachProductScope(sampleProduct)],
    revision: 1,
    approvedRevision: 1,
    mode: 'production',
    status: 'active',
    followUpEnabled: true,
  };
  service.putCampaign(plan);
  const enroll = (id) => {
    const d = {
      id,
      mailboxId: 'box',
      from: 'sales@dealer.test',
      campaignId: plan.id,
      mode: 'production',
      status: 'accepted',
      sentAt: '2026-01-01T00:00:00Z',
    };
    service.putDelivery(d);
    service.followUps.schedule(d, plan);
    return d;
  };
  const prior = enroll('old');
  service.db.exec(
    "UPDATE outreach_followups SET data=json_remove(data,'$.day','$.instruction','$.policyRevision','$.policyName'); UPDATE outreach_deliveries SET data=json_remove(data,'$.sequencePolicyRevision')",
  );
  const initial = await call(sequencePath);
  const update = async (steps) =>
    call(sequencePath, 'PUT', { ...(await call(sequencePath)), name: '新版', steps });
  const custom = await update([
    { day: 2, instruction: '核对用途', template: defaultTemplate(false) },
    { day: 8, instruction: '询问联系人', template: defaultTemplate(false) },
    { day: 12, instruction: '请求确认', template: defaultTemplate(false) },
  ]);
  enroll('custom');
  await update([]);
  const empty = enroll('empty');
  await update(custom.steps);
  service.followUps.schedule(empty, plan);
  service.followUps.schedule(prior, plan);
  const detail = await call('/sequences/plan');
  assert.deepEqual(
    detail.steps.map((s) => s.day),
    [0, 2, 3, 7, 8, 12],
  );
  assert.deepEqual(detail.items.find((s) => s.firstId === 'empty').followUps, []);
  const old = detail.items.find((s) => s.firstId === 'old').followUps;
  assert.deepEqual(
    old.map((s) => s.day),
    [3, 7],
  );
  assert.ok(
    old.every((s) => s.policyRevision === initial.revision && s.policyName === initial.name),
  );
  assert.deepEqual(
    detail.items
      .find((s) => s.firstId === 'custom')
      .followUps.map((s) => [s.day, s.instruction, s.policyRevision]),
    custom.steps.map((s) => [s.day, s.instruction, custom.revision]),
  );
});
test('独立素材可以作为本站回复资料，不进入可推产品', (t) => {
  const { mailbox } = api(t),
    file = { sourceUrl: 'https://dealer.test', brands: ['Dealer'], materialOnly: true };
  assert.equal(siteAllowsProduct(file, mailbox, true), true);
  assert.equal(siteAllowsProduct(file, mailbox, false), false);
});

test('收件箱可翻过第两百段会话，正文搜索及来信筛选使用同一范围', async (t) => {
  const { service, call, mailbox } = api(t);
  for (let i = 0; i < 227; i++) {
    const from = 'client' + i + '@customer.test';
    service.conversations.putMessage(mailbox, {
      identity: 'imap:' + i,
      source: 'imap',
      messageId: '<message' + i + '@customer.test>',
      from,
      to: mailbox.email,
      direction: 'inbound',
      subject: 'Question ' + i,
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      bodyText: 'A'.repeat(240) + (i === 2 ? ' CAFÉ blinds' : ''),
    });
  }
  const first = await call('/conversations?inboundOnly=1&pageSize=25&page=1'),
    last = await call('/conversations?inboundOnly=1&pageSize=25&page=10');
  assert.equal(first.total, 227);
  assert.equal(first.items.length, 25);
  assert.equal(last.page, 10);
  assert.equal(last.items.length, 2);
  assert.equal(last.items[1].subject, 'Question 0');
  assert.equal(last.hasMore, false);
  const match = await call('/conversations?q=' + encodeURIComponent('café'));
  assert.equal(match.total, 1);
  assert.equal(match.items[0].subject, 'Question 2');
});

test('首封模板经保存后可读回，旧客户端编辑跟进时保留首封模板', async (t) => {
  const { call } = api(t);
  const base = await call(sequencePath);
  const firstInstruction = 'Would a one-page product list be helpful?';
  const next = await call(sequencePath, 'PUT', { ...base, firstInstruction });
  assert.equal(next.revision, base.revision + 1);
  assert.equal((await call(sequencePath)).firstInstruction, firstInstruction);
  const legacyEdit = await call(sequencePath, 'PUT', {
    name: '仅首封',
    revision: next.revision,
    steps: [],
  });
  assert.equal(legacyEdit.firstInstruction, firstInstruction);
});

test('首封和各跟进独立保存写法，旧格式更新保留选择，显式清空恢复默认', async (t) => {
  const { call } = api(t);
  const base = await call(sequencePath);
  const input = {
    ...base,
    firstWriting: { tone: 'warm' },
    steps: [
      {
        day: 3,
        instruction: '',
        writing: { angle: 'installation' },
        template: defaultTemplate(false),
      },
      { day: 8, instruction: '确认采购方式', writing: { reply: 'sourcing' } },
      { day: 10, instruction: '确认是否方便联系' },
    ],
  };
  const saved = await call(sequencePath, 'PUT', input);
  assert.deepEqual((await call(sequencePath)).steps, input.steps);
  assert.deepEqual(saved.firstWriting, input.firstWriting);
  const oldClient = await call(sequencePath, 'PUT', {
    revision: saved.revision,
    name: '新版',
    steps: input.steps.map(({ day, instruction }) => ({ day, instruction })),
  });
  assert.deepEqual(oldClient.steps, saved.steps);
  await assert.rejects(
    call(sequencePath, 'PUT', { ...oldClient, firstWriting: { tone: 'unrecognized' } }),
    { status: 400 },
  );
  const cleared = await call(sequencePath, 'PUT', {
    ...oldClient,
    firstWriting: {},
    steps: oldClient.steps.map((s, i) => (i === 1 ? { ...s, writing: {} } : s)),
  });
  assert.equal(cleared.firstWriting, undefined);
  assert.equal(cleared.steps[1].writing, undefined);
  assert.deepEqual(cleared.steps[0], saved.steps[0]);
});
