import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// Relative imports work after copying this script into the repository scripts directory.
const repo = resolve(
  process.env.OUTREACH_QA_REPO || resolve(dirname(fileURLToPath(import.meta.url)), '..'),
);
const output = resolve(process.env.OUTREACH_QA_OUTPUT || '.codex-tmp/outreach-plan-controls');
const { createApp } = await import(pathToFileURL(resolve(repo, 'server/app.mjs')));
const { OutreachService } = await import(
  pathToFileURL(resolve(repo, 'server/outreach-service.mjs'))
);
const { chromium } = await import(
  process.env.OUTREACH_QA_PLAYWRIGHT
    ? pathToFileURL(process.env.OUTREACH_QA_PLAYWRIGHT)
    : 'playwright-core'
);
mkdirSync(output, { recursive: true });
// Independent business inputs: never derive expected sets from the application filter.
const products = [
  {
    id: 'hb-curtain',
    name: '布艺帘成品',
    category: 'indoor',
    direction: 'finished',
    sourceUrl: 'https://honeybadgerblinds.com',
  },
  {
    id: 'hb-track',
    name: '轨道',
    category: 'indoor',
    direction: 'materials',
    sourceUrl: 'https://honeybadgerblinds.com',
  },
  {
    id: 'hb-accessory',
    name: '配件',
    category: 'indoor',
    direction: 'materials',
    sourceUrl: 'https://honeybadgerblinds.com',
  },
  {
    id: 'sbs-curtain',
    name: '室内帘',
    category: 'indoor',
    direction: 'finished',
    sourceUrl: 'https://shutterblindssolutions.com',
  },
  {
    id: 'sbs-horizontal',
    name: '横百叶',
    category: 'shutters',
    direction: 'finished',
    sourceUrl: 'https://shutterblindssolutions.com',
  },
  {
    id: 'ss-vent',
    name: '透气窗',
    category: 'ventilation',
    direction: 'finished',
    sourceUrl: 'https://shuangshengshutter.com',
  },
  {
    id: 'outdoor',
    name: '户外基础记录',
    category: 'outdoor',
    direction: 'finished',
    sourceUrl: 'https://honeybadgerblinds.com',
  },
  {
    id: 'qa-other',
    name: 'QA其他供货',
    category: 'other',
    direction: 'materials',
  },
  { id: 'qa-missing', name: 'QA未分类供货', direction: 'finished' },
  {
    id: 'qa-material',
    name: 'QA其他供货',
    category: 'other',
    direction: 'materials',
    materialOnly: true,
  },
].map((p) => ({ status: 'approved', version: 1, ...p }));
const boxes = [
  {
    id: 'hb',
    email: 'sales@honeybadgerblinds.com',
    website: 'https://honeybadgerblinds.com',
    productIds: ['hb-curtain', 'hb-track', 'hb-accessory'],
  },
  {
    id: 'sbs',
    email: 'sales@shutterblindssolutions.com',
    website: 'https://shutterblindssolutions.com',
    productIds: ['sbs-curtain', 'sbs-horizontal'],
  },
  {
    id: 'ss',
    email: 'sales@shuangshengshutter.com',
    website: 'https://shuangshengshutter.com',
    productIds: ['ss-vent'],
  },
  {
    id: 'qa',
    email: 'sales@isolated-qa.example.org',
    website: 'https://isolated-qa.example.org',
    productIds: ['qa-other', 'qa-missing', 'qa-material'],
  },
].map((b) => ({
  ...b,
  configured: true,
  smtpStatus: 'connected',
  dailyLimit: 200,
  displayName: 'QA ' + b.id,
  signature: 'QA',
  paused: false,
}));
let sends = 0;
const service = new OutreachService({
  mailboxes: {
    list: () => structuredClone(boxes),
    get: (id) => structuredClone(boxes.find((b) => b.id === id)),
    send: () => {
      sends++;
      throw Error('Unexpected SMTP');
    },
  },
  products: () => structuredClone(products),
  getScope: () => 'plan-control-qa',
});
const app = createApp({
  env: { PORT: '14425' },
  dist: resolve(repo, 'dist'),
  outreachServiceFactory: () => service,
});
await new Promise((r) => app.listen(14425, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + app.address().port;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.MAIL_BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.setDefaultTimeout(12000);
const productBugs = [];
const errors = [],
  evidence = {
    repo,
    scope:
      'Isolated synthetic inputs; three brand sets plus separate QA mailbox and uncovered outdoor control',
    checks: [],
    productBugs,
    uiErrors: errors,
  };
page.on('pageerror', (e) => errors.push(e.message));
const check = (name, data) => evidence.checks.push({ name, ...data });
const api = async (path, method = 'GET', data) => {
  const r = await page.request.fetch(base + '/api/v1/outreach' + path, {
    method,
    data,
    headers: { origin: base },
  });
  return { status: r.status(), body: await r.json() };
};
const dialog = () => page.getByRole('dialog');
const shot = async (name) =>
  page.screenshot({ path: resolve(output, name + '.png'), fullPage: true });
const setBoxes = async (ids) => {
  for (const b of boxes)
    await dialog()
      .locator('.outreach-mailbox-options')
      .getByRole('checkbox', {
        name: new RegExp(b.email.replaceAll('.', '\\.')),
      })
      .setChecked(ids.includes(b.id));
};
const productLabels = () =>
  dialog()
    .locator('.outreach-field-label')
    .filter({ hasText: '供货产品' })
    .locator('xpath=following-sibling::div[1]')
    .locator('label');
const names = async () => productLabels().allTextContents();
const expectNames = async (expected) =>
  assert.deepEqual(
    (await names()).map((n) => n.trim().split(' · ')[0]).sort(),
    [...expected].sort(),
  );
const pick = (name) =>
  productLabels()
    .filter({ hasText: new RegExp('^' + name + ' ·') })
    .getByRole('checkbox');
const expectGroups = async (sample, expected) => {
  const actual = (await dialog().getByRole('button').allTextContents())
    .map((s) => s.trim())
    .filter((s) => /^(透气窗|百叶窗|室内窗饰|户外遮阳|其他|未分类)（[0-9]+）$/.test(s));
  try {
    assert.deepEqual(actual, expected);
  } catch {
    productBugs.push({
      name: 'Actual available product groups only',
      sample,
      expected,
      actual,
    });
  }
};
const count = async (n) =>
  assert.match(await dialog().innerText(), new RegExp('供货产品 · 已选择 ' + n + ' 项'));
try {
  await page.goto(base + '/inbox?tab=campaigns');
  await page.getByRole('button', { name: '新建计划', exact: true }).click();
  await dialog().getByLabel('计划名称', { exact: true }).fill('QA explicit product plan');
  await setBoxes(['hb']);
  await expectNames(['布艺帘成品', '轨道', '配件']);
  await expectGroups('Honey Badger', ['室内窗饰（3）']);
  for (const label of await names()) {
    assert.ok(label.includes('sales@honeybadgerblinds.com'));
    assert.ok(label.includes(label.startsWith('布艺') ? '成品' : '材料配件'));
  }
  await shot('01-honey-badger');
  await setBoxes(['sbs']);
  await expectNames(['室内帘', '横百叶']);
  await expectGroups('SBS', ['百叶窗（1）', '室内窗饰（1）']);
  await shot('02-sbs');
  await setBoxes(['hb', 'sbs', 'ss']);
  await expectNames(['布艺帘成品', '轨道', '配件', '室内帘', '横百叶', '透气窗']);
  assert.ok((await dialog().getByRole('button', { name: '全部（6）', exact: true }).count()) === 1);
  check('AC01 independent three-brand exact sets', {
    expected: {
      hb: ['hb-curtain', 'hb-track', 'hb-accessory'],
      sbs: ['sbs-curtain', 'sbs-horizontal'],
      all: ['hb-curtain', 'hb-track', 'hb-accessory', 'sbs-curtain', 'sbs-horizontal', 'ss-vent'],
    },
  });
  await shot('03-three-brand-union');
  await dialog().getByRole('button', { name: '保存计划草稿' }).click();
  assert.match(await dialog().innerText(), /请至少选择一个供货产品/);
  await pick('轨道').check();
  await pick('轨道').uncheck();
  await dialog().getByRole('button', { name: '保存计划草稿' }).click();
  await count(0);
  assert.equal(service.campaigns().length, 0);
  const input = {
    name: 'API invalid',
    mode: 'production',
    mailboxIds: ['hb'],
    targetCount: 2,
    intervalSeconds: 30,
    filters: { products: [] },
  };
  const empty = await api('/campaigns', 'POST', input);
  assert.equal(empty.status, 400);
  const outdoor = await api('/campaigns', 'POST', {
    ...input,
    filters: { products: ['outdoor'] },
  });
  assert.equal(outdoor.status, 400);
  assert.equal(service.campaigns().length, 0);
  assert.equal(service.deliveryCounts().total, 0);
  check('AC02/03 empty selection and uncovered control', {
    emptyStatus: empty.status,
    outdoorStatus: outdoor.status,
    campaigns: 0,
    deliveries: 0,
  });
  await setBoxes(['hb']);
  await pick('轨道').check();
  await setBoxes(['sbs']);
  await count(1);
  assert.match(await dialog().innerText(), /轨道：超出所选邮箱负责范围或品牌许可/);
  await dialog().getByRole('button', { name: '百叶窗（1）', exact: true }).click();
  await count(1);
  await dialog().getByRole('button', { name: '保存计划草稿' }).click();
  assert.match(await dialog().innerText(), /请先移除不可用产品/);
  await shot('04-retained-invalid');
  await setBoxes(['hb', 'sbs']);
  await count(1);
  assert.equal(
    await dialog().getByText('有 1 项产品已不在当前可用范围内。', { exact: true }).count(),
    0,
  );
  await pick('横百叶').check();
  await count(2);
  await dialog().getByRole('button', { name: '室内窗饰（4）', exact: true }).click();
  await count(2);
  assert.ok(await pick('轨道').isChecked());
  await dialog().getByRole('button', { name: '保存计划草稿' }).click();
  await dialog().waitFor({ state: 'hidden' });
  const saved = service.campaigns().find((c) => c.name === 'QA explicit product plan');
  assert.deepEqual(saved.filters.products, ['hb-track', 'sbs-horizontal']);
  assert.deepEqual([...saved.mailboxIds].sort(), ['hb', 'sbs']);
  await page.reload();
  const row = page.getByRole('row').filter({ hasText: 'QA explicit product plan' });
  await row.locator('summary').click();
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await count(2);
  assert.ok(await pick('轨道').isChecked());
  assert.ok(await pick('横百叶').isChecked());
  await pick('轨道').uncheck();
  await pick('横百叶').uncheck();
  await dialog().getByRole('button', { name: '保存计划草稿' }).click();
  assert.deepEqual(service.campaign(saved.id).filters.products, ['hb-track', 'sbs-horizontal']);
  await shot('05-reloaded-edit-empty-blocked');
  check('AC04/05 retained invalid, group selection, save-refresh-edit', {
    id: saved.id,
    products: saved.filters.products,
    mailboxes: saved.mailboxIds,
  });
  await dialog().getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '新建计划', exact: true }).click();
  await setBoxes(['qa']);
  await expectNames(['QA其他供货', 'QA未分类供货']);
  await expectGroups('QA other/missing', ['其他（1）', '未分类（1）']);
  await dialog().getByRole('button', { name: '其他（1）', exact: true }).click();
  await expectNames(['QA其他供货']);
  await dialog()
    .getByRole('button', { name: '其他（1）', exact: true })
    .locator('..')
    .getByRole('button', { name: '选择本组', exact: true })
    .click();
  await dialog().getByRole('button', { name: '未分类（1）', exact: true }).click();
  await expectNames(['QA未分类供货']);
  await pick('QA未分类供货').check();
  await count(2);
  await dialog().getByLabel('计划名称', { exact: true }).fill('QA other missing categories');
  await dialog().getByRole('button', { name: '保存计划草稿' }).click();
  await dialog().waitFor({ state: 'hidden' });
  const qaSaved = service.campaigns().find((c) => c.name === 'QA other missing categories');
  assert.deepEqual(qaSaved.filters.products, ['qa-other', 'qa-missing']);
  check('AC06 other/missing visible; same-name materialOnly excluded', {
    products: qaSaved.filters.products,
    excluded: 'qa-material',
  });
  // Seed independent raw history states, then exercise deletion through normal list/detail UI.
  for (const status of ['draft', 'active', 'paused', 'completed', 'cancelled']) {
    service.putCampaign({
      id: 'delete-' + status,
      name: 'QA delete ' + status,
      mode: 'production',
      status,
      revision: 1,
      targetCount: 2,
      mailboxIds: ['hb'],
      filters: {
        products: ['hb-track'],
        markets: [],
        grades: [],
        categories: [],
      },
      followUpEnabled: true,
      createdAt: '2026-11-27T00:00:00.000Z',
    });
    service.putDelivery({
      id: 'pending-' + status,
      campaignId: 'delete-' + status,
      status: 'queued',
    });
    service.putDelivery({
      id: 'sent-' + status,
      campaignId: 'delete-' + status,
      status: 'accepted',
      subject: 'Original ' + status,
      bodyHtml: '<p>Original history</p>',
    });
    service.followUps.put({
      id: 'follow-' + status,
      campaignId: 'delete-' + status,
      status: 'pending',
    });
  }
  await page.reload();
  for (const status of ['draft', 'active', 'paused', 'completed', 'cancelled']) {
    await page
      .getByRole('button', {
        name: ['completed', 'cancelled'].includes(status) ? '历史计划' : '当前计划',
        exact: true,
      })
      .click();
    const row = page.getByRole('row').filter({ hasText: 'QA delete ' + status });
    await row.waitFor();
    if (status === 'completed') {
      await row.getByRole('button', { name: '执行详情', exact: true }).click();
      await dialog().getByRole('button', { name: '删除计划', exact: true }).click();
    } else await row.getByRole('button', { name: '删除计划', exact: true }).click();
    const confirm = page.getByRole('dialog').filter({ hasText: '确认删除' });
    await confirm.waitFor();
    await confirm.getByText('待首发 1 · 待追信 1 · 待核实 0', { exact: true }).waitFor();
    assert.match(await confirm.innerText(), /待首发 1 · 待追信 1 · 待核实 0/);
    await shot('delete-confirm-' + status);
    await confirm.getByRole('button', { name: '确认删除计划', exact: true }).click();
    await confirm.waitFor({ state: 'hidden' });
    const detail = (await api('/campaigns/delete-' + status)).body;
    assert.ok(detail.campaign.deletedAt);
    assert.equal(service.followUps.get('follow-' + status).status, 'cancelled');
    assert.equal(service.delivery('pending-' + status).status, 'cancelled');
    assert.equal(service.delivery('sent-' + status).status, 'accepted');
    check('AC11 delete ' + status, {
      id: detail.campaign.id,
      deletedAt: detail.campaign.deletedAt,
      pending: 'cancelled',
      followUp: 'cancelled',
      sent: 'accepted',
    });
    if (await page.getByRole('dialog').count())
      await page.getByRole('dialog').getByRole('button', { name: '关闭弹窗', exact: true }).click();
  }
  await page.getByRole('button', { name: '已删除', exact: true }).click();
  await page.getByLabel('搜索计划名称').fill('QA delete');
  await page.getByRole('row').filter({ hasText: 'QA delete completed' }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 5);
  await shot('06-deleted-results');
  const deleted = (await api('/state?view=deleted&q=QA%20delete')).body;
  assert.equal(deleted.filtered, 5);
  assert.deepEqual(deleted.campaigns.map((c) => c.id).sort(), [
    'delete-active',
    'delete-cancelled',
    'delete-completed',
    'delete-draft',
    'delete-paused',
  ]);
  await page
    .getByRole('row')
    .filter({ hasText: 'QA delete completed' })
    .getByRole('button', { name: '执行详情', exact: true })
    .click();
  await dialog().getByText('Original completed', { exact: true }).first().waitFor();
  assert.match(await dialog().innerText(), /Original completed/);
  await shot('07-deleted-detail');
  check('AC22 partial deleted list and preserved detail', {
    count: 5,
    ids: deleted.campaigns.map((c) => c.id),
    notCovered: ['customer-history navigation', 'customer conversation/reconciliation history'],
  });
  await dialog().getByRole('button', { name: '关闭弹窗', exact: true }).click();
  for (let i = 0; i < 25; i++) {
    service.putCampaign({
      id: 'page-' + i,
      name: 'QA pagination ' + String(i).padStart(2, '0'),
      mode: 'production',
      status: i % 2 ? 'completed' : 'paused',
      revision: 1,
      targetCount: 1,
      mailboxIds: ['hb'],
      filters: {
        products: ['hb-track'],
        markets: [],
        grades: [],
        categories: [],
      },
      createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString(),
    });
    service.deleteCampaign('page-' + i, 1, true);
  }
  await page.reload();
  await page.getByRole('button', { name: '已删除', exact: true }).click();
  await page.getByLabel('搜索计划名称').fill('QA pagination');
  await page.getByText('共 25 个计划', { exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 20);
  const first = await page.locator('tbody .outreach-campaign-name strong').allTextContents();
  await shot('08-deleted-page-one');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByText('2 / 2', { exact: false }).waitFor();
  const second = await page.locator('tbody .outreach-campaign-name strong').allTextContents();
  assert.equal(second.length, 5);
  assert.deepEqual(
    [...first, ...second],
    Array.from({ length: 25 }, (_, i) => 'QA pagination ' + String(24 - i).padStart(2, '0')),
  );
  await shot('09-deleted-page-two');
  await page.getByLabel('按计划状态筛选').selectOption('paused');
  await page.getByText('共 13 个计划', { exact: true }).waitFor();
  assert.deepEqual(
    await page.locator('tbody .outreach-campaign-name strong').allTextContents(),
    Array.from({ length: 13 }, (_, i) => 'QA pagination ' + String(24 - 2 * i).padStart(2, '0')),
  );
  check('AC22 browser deleted pagination and status filtering', {
    total: 25,
    firstPage: 20,
    secondPage: 5,
    paused: 13,
    expectedNames: 'QA pagination 24..00 descending, paused even indices',
    notCovered: ['customer-history navigation'],
  });
  assert.equal(sends, 0);
  assert.deepEqual(errors, []);
  evidence.result = productBugs.length ? 'failed-known-product-bug' : 'passed';
} catch (e) {
  evidence.result = 'failed';
  evidence.failure = e.stack;
  await shot('failure');
  throw e;
} finally {
  evidence.sends = sends;
  writeFileSync(resolve(output, 'browser-evidence.json'), JSON.stringify(evidence, null, 2));
  await browser.close();
  await new Promise((r) => app.close(r));
  await service.close();
}
console.log(JSON.stringify(evidence, null, 2));
if (productBugs.length) process.exitCode = 1;
