// Run after npm run build. Isolated createApp HTTP + real browser; no external mail/model.
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { AcquisitionSchedules } from '../server/acquisition-schedules.mjs';
import { OutreachService } from '../server/outreach-service.mjs';
import { acquisitionOutreachSources } from '../server/acquisition-outreach.mjs';
import { feishuEnv, withFeishuAuth } from '../tests/helpers/feishu.mjs';
const dir = mkdtempSync(join(tmpdir(), 'source-browser-'));
const env = {
  ...feishuEnv,
  TAVILY_API_KEY: 'fixture',
  DEEPSEEK_API_KEY: 'fixture',
  BATCH_DB_PATH: join(dir, 'jobs.sqlite'),
  SCHEDULE_DB_PATH: join(dir, 'plans.sqlite'),
  CONNECTIONS_PATH: join(dir, 'connections.json'),
  OUTREACH_DATA_DIR: dir,
};
const scope = createHash('sha256')
  .update(JSON.stringify([env.FEISHU_APP_TOKEN, env.FEISHU_TABLE_ID]))
  .digest('hex');
const jobs = new BatchJobs({ path: env.BATCH_DB_PATH, schedule: false, scope });
const plans = new AcquisitionSchedules({
  path: env.SCHEDULE_DB_PATH,
  jobs: () => jobs,
  ready: () => true,
  available: () => true,
  scope,
});
const input = {
  country: 'United States',
  region: '',
  product: 'zip screens',
  search_query: 'zip screens',
  target_count: 3,
  acquisition_channel: 'tavily_web',
  auto_first_touch: true,
};
const a = jobs.create(input, 'browser-source-a');
jobs.pause(a.id);
const seeded = jobs.get(a.id);
seeded.status = 'completed';
jobs.save(seeded);
const pb = plans.create(
  {
    name: '来源B',
    input: { ...input, country: 'Canada' },
    timing: { repeat: 'once', startDate: '2030-01-01', times: ['09:00'] },
  },
  'browser-plan-b',
);
const b = jobs.create({ ...input, country: 'Canada' }, 'browser-source-b', { scheduleId: pb.id });
jobs.pause(b.id);
seeded.status = 'paused';
jobs.save(seeded);
const sent = [];
const service = new OutreachService({
  path: join(dir, 'mail.sqlite'),
  getScope: () => scope,
  mailboxes: { list: () => [], send: async (...args) => sent.push(args) },
  acquisitionSources: () =>
    acquisitionOutreachSources(
      { outreachJobs: () => jobs.list().filter((j) => j.input.auto_first_touch) },
      plans,
    ),
  pauseAcquisitionSource: (id, c) => plans.pauseSourceForOutreach(id, c),
});
service.syncAcquisition();
const old = 'acquisition-' + a.id;
service.putCampaign({
  id: 'manual',
  name: '独立手动对照',
  mode: 'production',
  status: 'draft',
  revision: 1,
});
let release;
const gate = new Promise((r) => (release = r));
const app = createApp({
  env,
  outreachServiceFactory: () => service,
  fetchImpl: withFeishuAuth(async () =>
    Response.json({ code: 0, data: { items: [], has_more: false } }),
  ),
  nativeImpl: {
    discover: async () => {
      await gate;
      return { candidates: [] };
    },
    decorateLeads: (v) => v,
    close() {
      release();
    },
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
  const page = await browser.newPage();
  page.on('response', async (r) => {
    if (r.status() >= 400) console.log(r.status(), r.url(), await r.text());
  });
  await page.goto(base + '/inbox?tab=campaigns&campaignId=' + old);
  await page.getByRole('button', { name: '删除计划', exact: true }).last().click();
  await page
    .getByRole('dialog', { name: '删除触达计划', exact: true })
    .getByText(/来源及定时安排的获客后自动首发将关闭/)
    .waitFor();
  await page.getByRole('button', { name: '确认删除计划', exact: true }).click();
  await page
    .getByRole('dialog', { name: '删除触达计划', exact: true })
    .waitFor({ state: 'hidden' });
  assert.ok(service.campaign(old).deletedAt);
  assert.equal(jobs.get(a.id).input.auto_first_touch, false);
  assert.equal(jobs.get(b.id).input.auto_first_touch, true);
  await page.goto(base + '/automation?tab=runs&job=' + a.id);
  const card = page.locator('#acquisition-record-' + a.id);
  await card
    .getByText(/关联触达计划已删除/)
    .first()
    .waitFor();
  assert.equal(
    await card.getByRole('checkbox', { name: '获客后自动首发', exact: true }).isChecked(),
    false,
  );
  await card.getByRole('button', { name: '继续获客', exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(jobs.get(a.id).input.auto_first_touch, false);
  service.syncAcquisition();
  assert.equal(service.campaigns().length, 3);
  assert.equal(sent.length, 0);
  await card.getByRole('button', { name: '暂停并保留进度', exact: true }).click();
  await card.getByRole('checkbox', { name: '获客后自动首发', exact: true }).check();
  await card.getByRole('button', { name: '保存自动首发设置', exact: true }).click();
  await page.waitForTimeout(300);
  service.syncAcquisition();
  const fresh = 'acquisition-' + a.id + '-g1';
  assert.equal(service.campaign(fresh).status, 'paused');
  assert.ok(service.campaign(old).deletedAt);
  assert.equal(sent.length, 0);
  release();
  await page.waitForTimeout(500);
  // Complete the single job at the fixture boundary, then exercise the real rerun form.
  const completed = jobs.get(a.id);
  completed.status = 'completed';
  completed.manualPaused = false;
  jobs.save(completed);
  const other = jobs.get(b.id);
  other.status = 'completed';
  jobs.save(other);
  await page.reload();
  await card.getByRole('checkbox', { name: '获客后自动首发', exact: true }).uncheck();
  await card.getByRole('button', { name: '保存自动首发设置', exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(jobs.get(a.id).input.auto_first_touch, false);
  await card.getByRole('link', { name: '重新执行', exact: true }).click();
  await page.waitForURL(/rerun=/);
  await page.reload();
  const submit = page.getByRole('button', { name: /开始获客/ });
  await submit.click();
  await page.waitForURL(/tab=runs.*job=/);
  const nextId = new URL(page.url()).searchParams.get('job');
  assert.notEqual(nextId, a.id);
  const next = await (await fetch(base + '/api/v1/acquisition/jobs/' + nextId)).json();
  assert.equal(next.input.auto_first_touch, false);
  console.log(
    JSON.stringify({
      old,
      newPlan: fresh,
      rerunJob: nextId,
      otherSourceUntouched: jobs.get(b.id).input.auto_first_touch,
      smtpSubmissions: sent.length,
    }),
  );
} finally {
  release();
  await browser?.close();
  await new Promise((r) => app.close(r));
  await service.close();
  await jobs.close();
  plans.close();
  await rm(dir, { recursive: true, force: true });
}
