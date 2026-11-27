import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

// Run from repository root; this script can also be copied into scripts/.
const repo = resolve(process.env.HISTORY_QA_REPO || '.');
const output = resolve(process.env.HISTORY_QA_OUTPUT || '.codex-tmp/customer-history');
mkdirSync(output, { recursive: true });
const dir = mkdtempSync(join(output, 'fixture-'));
const load = (file) => import(pathToFileURL(resolve(repo, file)).href);
const [
  { createApp },
  { CustomerBusiness },
  { LeadLibrary },
  { OutreachService },
  { recordOutreachInBusiness },
  { recordMailConversation },
  { recordFollowUpTask },
] = await Promise.all([
  load('server/app.mjs'),
  load('server/customer-business.mjs'),
  load('server/lead-library.mjs'),
  load('server/outreach-service.mjs'),
  load('server/outreach-business.mjs'),
  load('server/mail-conversation-business.mjs'),
  load('server/outreach-follow-ups.mjs'),
]);
const { chromium } = createRequire(resolve(repo, 'package.json'))('playwright-core');
const env = Object.fromEntries(
  [
    'LEAD_LIBRARY_DB_PATH',
    'CUSTOMER_BUSINESS_DB_PATH',
    'OUTREACH_DB_PATH',
    'PRODUCT_KNOWLEDGE_DB_PATH',
    'BATCH_DB_PATH',
    'PRODUCT_DB_PATH',
    'SCHEDULE_DB_PATH',
    'BUSINESS_MIRROR_JOURNAL_PATH',
  ].map((key) => [key, join(dir, key + '.sqlite')]),
);
env.CONNECTIONS_PATH = join(dir, 'connections.json');
env.BRANDING_CACHE_PATH = join(dir, 'branding');
const scope = createHash('sha256')
  .update(JSON.stringify(['native', '', '', '', '']))
  .digest('hex');
const library = new LeadLibrary({ path: env.LEAD_LIBRARY_DB_PATH, scope });
const leads = ['north', 'south', 'quiet'].map((id) => ({
  id,
  name: 'History QA ' + id,
  domain: id + '.example',
  website: '',
  email: id + '@client.example',
  market: 'US',
  type: 'dealer',
  grade: 'A',
  product: 'Track',
  facts: [],
  contactEvidence: [],
  fields: {},
  developmentEligible: true,
}));
for (const lead of leads) library.upsert(lead);
const store = new CustomerBusiness({
  path: env.CUSTOMER_BUSINESS_DB_PATH,
  scope: '/',
  customer: async (id) => (leads.some((l) => l.id === id) ? { record_id: id } : null),
});
const box = {
  id: 'qa-sales',
  email: 'sales@qa.example',
  configured: true,
  smtpStatus: 'connected',
  website: 'https://qa.example',
  productIds: ['qa-track'],
  dailyLimit: 200,
};
let sends = 0;
const service = new OutreachService({
  path: env.OUTREACH_DB_PATH,
  getScope: () => 'history-qa',
  mailboxes: {
    list: () => [box],
    get: () => box,
    send: async () => {
      sends++;
      throw Error('No SMTP is allowed in history QA');
    },
  },
  customers: () => leads,
  products: () => [
    {
      id: 'qa-track',
      name: 'QA track',
      status: 'approved',
      direction: 'materials',
      sourceUrl: box.website,
    },
  ],
  businessState: () => store.view(),
  recordAccepted: (delivery) => recordOutreachInBusiness({ store, delivery }),
  recordCommunication: (detail) => recordMailConversation({ store, ...detail }),
  recordFollowUp: (action, first) => recordFollowUpTask(store, action, first),
});
const expected = {};
for (const id of ['north', 'south']) {
  const campaignId = 'history-plan-' + id;
  service.putCampaign({
    id: campaignId,
    name: 'History QA plan ' + id,
    scope: 'history-qa',
    mode: 'production',
    status: 'paused',
    revision: 1,
    mailboxIds: [box.id],
    filters: {
      products: ['qa-track'],
      markets: [],
      grades: [],
      categories: [],
    },
    followUpEnabled: true,
    targetCount: 1,
    createdAt: '2026-11-20T02:00:00.000Z',
  });
  const first = {
    id: 'first-' + id,
    campaignId,
    customerId: id,
    mailboxId: box.id,
    mode: 'production',
    status: 'unknown',
    from: box.email,
    to: id + '@client.example',
    messageId: '<first-' + id + '@qa.example>',
    subject: 'Original first ' + id,
    bodyText: 'Original first body ' + id + '\nUnique first evidence ' + id,
    bodyHtml: '<p>Original first body ' + id + '</p><p>Unique first evidence ' + id + '</p>',
    attemptedAt: '2026-11-20T02:00:00.000Z',
    candidate: {
      customerId: id,
      companyDomain: id + '.example',
      to: id + '@client.example',
    },
  };
  service.putDelivery(first);
  await service.resolveDelivery(first.id, {
    outcome: 'accepted',
    evidence: 'Isolated provider log confirms ' + first.messageId,
    operator: 'History QA ' + id,
  });
  assert.equal(service.delivery(first.id).recordError, '');
  const follow = {
    id: 'follow-sent-' + id,
    firstId: first.id,
    campaignId,
    customerId: id,
    mailboxId: box.id,
    from: box.email,
    to: first.to,
    status: 'accepted',
    step: 1,
    day: 3,
    dueAt: '2026-11-23T02:00:00.000Z',
    sentAt: '2026-11-23T02:00:00.000Z',
    subject: 'Original follow ' + id,
    bodyText: 'Original follow body ' + id + '\nUnique follow evidence ' + id,
    bodyHtml: '<p>Original follow body ' + id + '</p><p>Unique follow evidence ' + id + '</p>',
    messageId: '<follow-' + id + '@qa.example>',
    createdAt: '2026-11-20T02:00:00.000Z',
  };
  service.followUps.put(follow);
  const message = service.conversations.putMessage(box, {
    ...follow,
    id: undefined,
    direction: 'outbound',
    source: 'automatic',
    occurredAt: follow.sentAt,
    deliveryStatus: 'sent',
    inReplyTo: first.messageId,
    references: [first.messageId],
  });
  const thread = service.conversations.list({ customerId: id }).items[0];
  await recordMailConversation({
    store,
    ...service.conversations.detail(thread.id),
  });
  const pending = {
    ...follow,
    id: 'follow-pending-' + id,
    status: 'pending',
    step: 2,
    day: 7,
    dueAt: '2026-12-20T02:00:00.000Z',
    sentAt: null,
    subject: '',
    bodyText: '',
    bodyHtml: '',
    messageId: '',
  };
  service.followUps.put(pending);
  recordFollowUpTask(store, service.followUps.get(follow.id), service.delivery(first.id));
  recordFollowUpTask(store, service.followUps.get(pending.id), service.delivery(first.id));
  expected[id] = {
    first: service.delivery(first.id),
    follow: service.followUps.get(follow.id),
    pendingId: pending.id,
    threadId: thread.id,
    crmMessageIds: store.all('messages', id).map((m) => m.id),
    mailboxMessageId: message?.id,
  };
}
const outboundRequests = [];
const app = createApp({
  env,
  dist: resolve(repo, 'dist'),
  outreachServiceFactory: () => service,
  fetchImpl: async (url) => {
    outboundRequests.push(String(url));
    throw Error('External network disabled for history QA');
  },
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
env.PORT = String(app.address().port);
const base = 'http://127.0.0.1:' + app.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.MAIL_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
});
const page = await browser.newPage({
  viewport: { width: 1440, height: 1100 },
  locale: 'zh-CN',
});
page.setDefaultTimeout(15000);
const evidence = {
  repo,
  dir,
  expected,
  scope:
    'Two isolated synthetic manual production plans/customers plus one no-data customer; customer-history normal UI before/after deletion; no production access',
  checks: [],
  errors: [],
  network: [],
};
page.on('pageerror', (e) => evidence.errors.push(e.message));
page.on('response', (r) => {
  if (
    r.url().includes('/api/v1/business/timeline/') ||
    r.url().includes('/deliveries/') ||
    r.url().includes('/campaigns/')
  )
    evidence.network.push({
      status: r.status(),
      url: r.url().replace(base, ''),
    });
});
await page.route('**/*', (route) =>
  route.request().url().startsWith(base) ? route.continue() : route.abort(),
);
const shot = (name) => page.screenshot({ path: join(output, name + '.png'), fullPage: true });
const read = async (path) => {
  const r = await page.request.get(base + path);
  assert.equal(r.status(), 200, path);
  return r.json();
};
const close = async () =>
  page.getByRole('dialog').last().getByRole('button', { name: '关闭弹窗', exact: true }).click();
// Background mirroring may add its completion timestamp; original facts still compare in full.
const snapshot = () => ({
  deliveries: ['north', 'south'].map((id) => service.delivery('first-' + id)),
  sentFollowups: ['north', 'south'].map((id) => {
    const { mirroredAt, ...record } = service.followUps.get('follow-sent-' + id);
    return record;
  }),
  messages: store.all('messages').sort((a, b) => a.id.localeCompare(b.id)),
  conversations: store.all('conversations').sort((a, b) => a.id.localeCompare(b.id)),
});
async function history(id, phase) {
  await page.goto(base + '/leads');
  await page
    .getByRole('row')
    .filter({ hasText: 'History QA ' + id })
    .click();
  await page.getByRole('button', { name: '沟通与跟进', exact: true }).click();
  const timeline = page.locator('.customer-business-summary');
  await timeline.getByRole('heading', { name: /沟通与任务时间线/ }).waitFor();
  const data = await read('/api/v1/business/timeline/' + id);
  if (id === 'quiet') {
    assert.equal(data.total, 0);
    await timeline.getByText('暂无已发送邮件记录', { exact: true }).waitFor();
    assert.equal(await timeline.locator('li').count(), 0);
    await shot(phase + '-' + id);
    return data;
  }
  assert.equal(data.total, 4);
  assert.equal(data.sentCount, 2);
  assert.deepEqual(
    data.items
      .filter((r) => r.kind === 'mail')
      .map((r) => r.title)
      .sort(),
    ['Original first ' + id, 'Original follow ' + id].sort(),
  );
  assert.deepEqual(
    data.items
      .filter((r) => r.kind === 'auto')
      .map((r) => [r.id, r.state])
      .sort(),
    [
      ['task_follow-pending-' + id, phase === 'before' ? 'pending' : 'cancelled'],
      ['task_follow-sent-' + id, 'accepted'],
    ].sort(),
  );
  assert.equal(
    data.items
      .filter((r) => r.kind === 'mail')
      .some((r) => r.title.includes(id === 'north' ? 'south' : 'north')),
    false,
  );
  await timeline.getByText('Original first ' + id, { exact: true }).waitFor();
  await shot(phase + '-' + id + '-timeline');
  for (const type of ['first', 'follow']) {
    if (type === 'follow') {
      await page.goto(base + '/leads');
      await page
        .getByRole('row')
        .filter({ hasText: 'History QA ' + id })
        .click();
      await page.getByRole('button', { name: '沟通与跟进', exact: true }).click();
    }
    const input = expected[id][type];
    const event = data.items.find((r) => r.kind === 'mail' && r.title === input.subject);
    await page
      .locator('.customer-business-summary')
      .getByRole(event.thread ? 'link' : 'button', {
        name: input.subject,
        exact: true,
      })
      .click();
    if (event.thread) {
      const mail = page.locator('details.inbox-message').filter({
        has: page.locator('.inbox-snippet', { hasText: input.subject }),
      });
      await mail.waitFor();
      if (!((await mail.getAttribute('open')) !== null))
        await mail.locator('summary').first().click();
      await mail.getByRole('button', { name: '纯文本', exact: true }).click();
      await mail.getByText('Unique ' + type + ' evidence ' + id, { exact: false }).waitFor();
      assert.equal(
        await mail.getByText('Unique ' + type + ' evidence ' + id, { exact: false }).textContent(),
        input.bodyText,
      );
      assert.ok(page.url().includes('customerId=' + id));
      assert.ok(page.url().includes('thread=' + event.thread));
    } else {
      await page
        .getByRole('dialog')
        .last()
        .getByText('Unique ' + type + ' evidence ' + id, { exact: false })
        .waitFor();
    }
    await shot(phase + '-' + id + '-' + type + '-original');
    if (!event.thread) await close();
  }
  await page.goto(base + '/leads');
  await page
    .getByRole('row')
    .filter({ hasText: 'History QA ' + id })
    .click();
  await page.getByRole('button', { name: '沟通与跟进', exact: true }).click();
  await page
    .locator('.customer-business-summary')
    .getByRole('link', { name: '首封未回复 · 第 2 次追信', exact: true })
    .click();
  const detail = page.getByRole('dialog');
  await detail
    .getByText('Original first ' + id, { exact: false })
    .first()
    .waitFor();
  await detail
    .getByText('Isolated provider log confirms <first-' + id + '@qa.example>', {
      exact: false,
    })
    .waitFor();
  if (phase === 'after') await detail.getByText('已删除', { exact: false }).first().waitFor();
  await shot(phase + '-' + id + '-resolution-followup-plan');
  await detail
    .getByText('Isolated provider log confirms <first-' + id + '@qa.example>', { exact: false })
    .scrollIntoViewIfNeeded();
  await shot(phase + '-' + id + '-resolution-evidence');
  return data;
}
try {
  evidence.beforeRecords = snapshot();
  evidence.before = {};
  for (const id of ['north', 'south', 'quiet']) evidence.before[id] = await history(id, 'before');
  for (const id of ['north', 'south']) {
    await page.goto(base + '/inbox?tab=campaigns');
    const row = page.getByRole('row').filter({ hasText: 'History QA plan ' + id });
    await row.getByRole('button', { name: '删除计划', exact: true }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: '确认删除' });
    await confirm.getByText('待首发 0 · 待追信 1 · 待核实 0', { exact: false }).waitFor();
    await confirm.getByRole('button', { name: '确认删除计划', exact: true }).click();
    await confirm.waitFor({ state: 'hidden' });
    assert.ok(service.campaign('history-plan-' + id).deletedAt);
  }
  evidence.afterRecords = snapshot();
  assert.deepEqual(
    evidence.afterRecords,
    evidence.beforeRecords,
    'Original delivery, accepted followup, CRM IDs/body and conversations must be unchanged',
  );
  evidence.after = {};
  for (const id of ['north', 'south', 'quiet']) evidence.after[id] = await history(id, 'after');
  for (const id of ['north', 'south']) {
    assert.deepEqual(
      evidence.after[id].items.map((r) => r.id).sort(),
      evidence.before[id].items.map((r) => r.id).sort(),
    );
    const messages = store.all('messages', id);
    for (const type of ['first', 'follow'])
      assert.equal(
        messages.find((m) => m.externalId === expected[id][type].messageId)?.body,
        expected[id][type].bodyText,
      );
    evidence.checks.push({
      customerId: id,
      campaignId: 'history-plan-' + id,
      total: 4,
      sent: 2,
      pendingFollowup: 'cancelled',
      originalIdsAndBodiesUnchanged: true,
      deletedPlanNavigation: true,
      manualResolutionEvidenceUnchanged: true,
    });
  }
  assert.equal(sends, 0);
  assert.deepEqual(outboundRequests, []);
  assert.deepEqual(evidence.errors, []);
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed';
  evidence.failure = error.stack;
  await shot('failure');
  process.exitCode = 1;
} finally {
  evidence.sends = sends;
  evidence.externalRequests = outboundRequests;
  writeFileSync(join(output, 'customer-history.json'), JSON.stringify(evidence, null, 2));
  await browser.close();
  await new Promise((r) => app.close(r));
  await service.close();
  store.close();
  library.close();
}
console.log(
  JSON.stringify(
    {
      result: evidence.result,
      failure: evidence.failure,
      checks: evidence.checks,
      output,
    },
    null,
    2,
  ),
);
