import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { OutreachService } from '../server/outreach-service.mjs';
const root = resolve('.codex-tmp');
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, 'coverage-browser-'));
const env = {
  OUTREACH_DB_PATH: join(dir, 'outreach.sqlite'),
  CONNECTIONS_PATH: join(dir, 'connections.json'),
  BRANDING_CACHE_PATH: join(dir, 'branding'),
};
const products = [
  { id: 'curtain', name: '布艺帘', status: 'approved', sourceUrl: 'https://honeybadgerblinds.com' },
  { id: 'track', name: '轨道', status: 'approved', sourceUrl: 'https://honeybadgerblinds.com' },
  {
    id: 'blind',
    name: '横百叶',
    status: 'approved',
    sourceUrl: 'https://shutterblindssolutions.com',
  },
  { id: 'outdoor', name: '户外对照', status: 'approved' },
  { id: 'draft', name: '未审核对照', status: 'draft', sourceUrl: 'https://honeybadgerblinds.com' },
];
const boxes = new OutreachMailboxes({
  path: join(dir, 'mailboxes.json'),
  seedPath: null,
  protect: async () => ({ credential: 'test', credentialProtection: 'aes-256-gcm-local-key' }),
});
const a = await boxes.save({
  email: 'a@honeybadgerblinds.com',
  displayName: 'Alice',
  productIds: ['curtain'],
  clientPassword: 'synthetic',
});
const b = await boxes.save({
  email: 'b@shutterblindssolutions.com',
  displayName: 'Bob',
  productIds: ['blind'],
  clientPassword: 'synthetic',
});
const empty = await boxes.save({
  email: 'c@shuangshengshutter.com',
  displayName: 'Empty',
  productIds: [],
  clientPassword: 'synthetic',
});
const service = new OutreachService({
  path: env.OUTREACH_DB_PATH,
  mailboxes: boxes,
  products: () => products,
});
service.saveCampaign({
  name: '原手动范围',
  mailboxIds: [a.id],
  filters: { products: ['curtain'] },
});
const app = createApp({
  env,
  outreachServiceFactory: () => service,
  fetchImpl: async () => {
    throw Error('禁止外部服务');
  },
});
await new Promise((r) => app.listen(0, '127.0.0.1', r));
env.PORT = String(app.address().port);
const base = 'http://127.0.0.1:' + app.address().port;
const executablePath = [
  process.env.MAIL_BROWSER_PATH,
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const open = async (box) => {
    await page.goto(base + '/inbox?tab=mailboxes');
    await page
      .locator('.outreach-mailbox-card')
      .filter({ hasText: box.email })
      .getByRole('button', { name: '配置', exact: true })
      .click();
  };
  await open(a);
  await page.getByRole('checkbox', { name: '轨道', exact: true }).check();
  await page.getByRole('checkbox', { name: '布艺帘', exact: true }).uncheck();
  assert.equal(await page.getByRole('checkbox', { name: '横百叶', exact: true }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: '户外对照', exact: true }).count(), 0);
  assert.equal(await page.getByRole('checkbox', { name: '未审核对照', exact: true }).count(), 0);
  await page.getByRole('button', { name: '保存邮箱', exact: true }).click();
  await page.getByRole('heading', { name: '确认负责范围影响' }).waitFor();
  assert.deepEqual(boxes.get(a.id).productIds, ['curtain']);
  await page
    .getByText('原手动范围：撤销 布艺帘；手动计划保持原产品集合', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: '确认影响并保存邮箱', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(boxes.get(a.id).productIds, ['track']);
  await open(a);
  assert.equal(await page.getByRole('checkbox', { name: '轨道', exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await open(b);
  await page.getByRole('checkbox', { name: '横百叶', exact: true }).uncheck();
  await page.getByRole('button', { name: '保存邮箱', exact: true }).click();
  await page.getByRole('button', { name: '确认影响并保存邮箱', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.deepEqual(boxes.get(b.id).productIds, []);
  await open(empty);
  await page.getByText('当前品牌没有可选的已审核产品。', { exact: true }).waitFor();
  assert.deepEqual(boxes.get(empty.id).productIds, []);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  // Two users read the same revision; the later save must not overwrite the first.
  await open(a);
  await page.getByRole('checkbox', { name: '布艺帘', exact: true }).check();
  await page.getByRole('button', { name: '保存邮箱', exact: true }).click();
  const current = boxes.get(a.id);
  await fetch(base + '/api/v1/outreach/mailboxes/' + a.id, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: current.revision, productIds: [] }),
  });
  await page.getByRole('button', { name: '确认影响并保存邮箱', exact: true }).click();
  await page.getByText('邮箱配置已被其他使用者修改，请刷新后重新确认', { exact: true }).waitFor();
  assert.deepEqual(boxes.get(a.id).productIds, []);
  await page.reload();
  await page
    .locator('.outreach-mailbox-card')
    .filter({ hasText: a.email })
    .getByRole('button', { name: '配置', exact: true })
    .click();
  assert.equal(await page.getByRole('checkbox', { name: '轨道', exact: true }).isChecked(), false);
  assert.deepEqual(errors, []);
  const reopened = new OutreachMailboxes({ path: join(dir, 'mailboxes.json'), seedPath: null });
  assert.deepEqual(
    [a, b, empty].map((box) => reopened.get(box.id).productIds),
    [[], [], []],
  );
  console.log('通过：双邮箱、空覆盖对照、增减影响确认、并发冲突、刷新和持久化回读');
  await boxes.save({ id: a.id, productIds: ['curtain'] });
  await boxes.save({ id: b.id, productIds: ['blind'] });
  for (let index = 0; index < 40; index++)
    service.saveCampaign({
      name: '性能样本' + index,
      mailboxIds: [index % 2 ? a.id : b.id],
      filters: { products: [index % 2 ? 'curtain' : 'blind'] },
    });
  const campaign = service.campaigns()[0];
  for (let index = 0; index < 1203; index++)
    service.putDelivery({
      id: 'performance' + index,
      campaignId: campaign.id,
      status: 'accepted',
      bodyText: 'x'.repeat(64000),
    });
  const durations = [];
  let responseBytes = 0;
  for (let index = 0; index < 11; index++) {
    const start = performance.now();
    const response = await fetch(
      base + '/api/v1/outreach/mailboxes/' + a.id + '/coverage-preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: boxes.get(a.id).revision, productIds: ['track'] }),
      },
    );
    const body = await response.text();
    durations.push(performance.now() - start);
    responseBytes = Buffer.byteLength(body);
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(body).campaigns.length, 21);
  }
  console.log(
    JSON.stringify({
      plans: 41,
      records: 1203,
      recordBodyBytes: 64000,
      affectedPlans: 21,
      coldMs: durations[0],
      hotMedianMs: durations.slice(1).sort((a, b) => a - b)[5],
      maxMs: Math.max(...durations),
      responseBytes,
    }),
  );
  console.log(
    service.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT data FROM outreach_campaigns WHERE json_extract(data,'$.mode')='production' AND json_extract(data,'$.deleteRequestedAt') IS NULL AND EXISTS (SELECT 1 FROM json_each(data,'$.mailboxIds') WHERE value=?) ORDER BY rowid DESC`,
      )
      .all(a.id),
  );
} finally {
  await browser?.close();
  await new Promise((r) => app.close(r));
  await service.close();
  await rm(dir, { recursive: true, force: true });
}
