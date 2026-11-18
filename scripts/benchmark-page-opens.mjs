import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../server/app.mjs';
import { LeadLibrary } from '../server/lead-library.mjs';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { OutreachService } from '../server/outreach-service.mjs';

const folder = await mkdtemp(join(tmpdir(), 'shadeflow-page-opens-'));
const env = {
  LEAD_LIBRARY_DB_PATH: join(folder, 'leads.sqlite'),
  CUSTOMER_BUSINESS_DB_PATH: join(folder, 'business.sqlite'),
  BRANDING_CACHE_PATH: join(folder, 'branding'),
};
const scope = createHash('sha256')
  .update(JSON.stringify(['native', '', '', '', '']))
  .digest('hex');
const offline = () => {
  throw new Error('Unexpected external service call');
};
const leads = new LeadLibrary({ path: env.LEAD_LIBRARY_DB_PATH, scope, readLeads: offline });
const service = new OutreachService({
  mailboxes: { list: () => [] },
  customers: offline,
  acquisitionSources: offline,
});
let app, browser;
const samples = (times) => {
  const sorted = times.slice(1).sort((left, right) => left - right);
  return {
    firstMs: Math.round(times[0]),
    medianMs: Math.round(sorted[Math.floor(sorted.length / 2)]),
    maxMs: Math.ceil(Math.max(...times)),
  };
};
try {
  for (let index = 0; index < 1111; index++)
    leads.upsert({
      id: `buyer-${index}`,
      name: `Buyer ${index}`,
      market: 'Australia',
      grade: 'B',
      product: 'roller blinds',
      status: '待开发',
      createdAt: index,
      facts: [],
      contactEvidence: [],
      fields: { evidence: 'x'.repeat(20000) },
      source: '',
      email: '',
      domain: '',
      website: '',
    });
  leads.close();
  const graph = new CustomerBusiness({ path: env.CUSTOMER_BUSINESS_DB_PATH, scope: '/' });
  for (let index = 0; index < 1203; index++)
    graph.put('messages', {
      id: `msg-${index}`,
      customerId: `buyer-${index % 1111}`,
      classification: 'normal',
      actualConfirmed: true,
      direction: 'outbound',
      deliveryStatus: 'accepted',
      body: 'x'.repeat(8000),
    });
  graph.close();
  for (let index = 0; index < 41; index++)
    service.putCampaign({
      id: `plan-${index}`,
      name: `Plan ${index}`,
      status: index % 3 ? 'paused' : 'completed',
      mode: 'production',
      customerIds: Array.from({ length: 120 }, (_, number) => `buyer-${number}`),
      productScopes: [{ evidence: 'x'.repeat(2000) }],
      createdAt: '2026-01-01T00:00:00Z',
    });
  for (let index = 0; index < 1203; index++)
    service.putDelivery({
      id: `mail-${index}`,
      campaignId: `plan-${index % 41}`,
      companyName: `Buyer ${index}`,
      to: `buyer${index}@example.test`,
      subject: 'Product enquiry',
      status: index % 7 ? 'accepted' : 'failed',
      candidate: { evidence: 'x'.repeat(10000) },
      bodyHtml: 'x'.repeat(index % 20 ? 5000 : 200000),
    });
  app = createApp({ env, fetchImpl: offline, outreachServiceFactory: () => service });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const legacy = process.argv.includes('--legacy');
  for (const [name, path, check] of [
    [
      '客户库',
      `/leads/real/list${legacy ? '' : '?page=1'}`,
      (data) => data.total === 1111 && data.leads.length === (legacy ? 1111 : 8),
    ],
    [
      '客户筛选翻页',
      '/leads/real/list?page=2&product=Indoor+Window+Coverings（室内成品帘）&q=buyer+1',
      (data) => legacy || (data.filteredTotal > 8 && data.page === 2),
    ],
    ['客户详情', '/leads/real/buyer-111?local=1', (data) => data.lead.id === 'buyer-111'],
    [
      '触达计划',
      `/outreach/state${legacy ? '' : '?view=current&page=1'}`,
      (data) => data.campaigns.length === (legacy ? 41 : 20),
    ],
    [
      '历史计划翻页',
      '/outreach/state?view=history&page=2&pageSize=10',
      (data) => legacy || (data.page === 2 && data.filtered === 14),
    ],
    [
      '发送记录',
      '/outreach/deliveries?page=1',
      (data) => data.total === 1203 && data.items.length === 20,
    ],
    [
      '发送记录筛选翻页',
      '/outreach/deliveries?page=2&q=buyer&group=failed',
      (data) => data.page === 2 && data.items.length === 20,
    ],
  ]) {
    const times = [];
    let bytes;
    for (let iteration = 0; iteration < 7; iteration++) {
      const start = performance.now(),
        response = await fetch(base + '/api/v1' + path),
        raw = await response.text();
      assert.equal(response.status, 200, name);
      assert.ok(check(JSON.parse(raw)), name);
      times.push(performance.now() - start);
      bytes = Buffer.byteLength(raw);
    }
    console.log(name, JSON.stringify({ ...samples(times), bytes }));
  }
  if (process.env.PLAYWRIGHT_MODULE) {
    const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    await session.send('Network.enable');
    await session.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 40,
      downloadThroughput: 1250000,
      uploadThroughput: 1250000,
    });
    const cases = [
      ['客户库', '/leads', '.reference-lead-table tbody tr'],
      ['客户详情', '/leads?lead=buyer-111', '.prospect-title h2'],
      ['触达计划', '/inbox?tab=campaigns', '.outreach-campaign-table tbody tr'],
      ['发送记录', '/inbox?tab=deliveries', '#outreach-panel-deliveries tbody tr'],
    ];
    if (!legacy) {
      const plain = await browser.newContext({ javaScriptEnabled: false });
      const view = await plain.newPage();
      for (const [, path, selector] of cases) {
        const response = await view.goto(base + path);
        assert.match(response.headers()['cache-control'], /no-store/);
        assert.ok(
          await view.locator(selector).first().isVisible(),
          '首屏不依赖交互组件下载：' + path,
        );
      }
      await plain.close();
    }
    let worst = 0;
    for (const [label, path, selector] of cases) {
      const times = [];
      for (let iteration = 0; iteration < 6; iteration++) {
        if (!iteration) await session.send('Network.clearBrowserCache');
        await page.goto(base + path, { waitUntil: 'commit' });
        const elapsed = await page.evaluate(async (selector) => {
          while (!document.querySelector(selector)?.getClientRects().length) {
            if (performance.now() > 10000) throw new Error('Page did not display ' + selector);
            await new Promise(requestAnimationFrame);
          }
          await new Promise(requestAnimationFrame);
          return performance.now();
        }, selector);
        times.push(elapsed);
        if (elapsed > 700)
          console.log(
            'slow navigation',
            await page.evaluate(() =>
              performance
                .getEntriesByType('resource')
                .map(({ name, startTime, duration, transferSize }) => [
                  new URL(name).pathname,
                  Math.round(startTime),
                  Math.round(duration),
                  transferSize,
                ]),
            ),
          );
      }
      const stats = samples(times);
      worst = Math.max(worst, stats.maxMs);
      console.log('浏览器 ' + label, JSON.stringify(stats));
    }
    const clicks = [
      ['客户库', 'a[href="/leads"]', '.reference-lead-table tbody tr'],
      ['客户详情', '.reference-lead-table tbody tr', '.prospect-title h2'],
      ['触达计划', 'a[href="/inbox"]', '.outreach-campaign-table tbody tr'],
      ['发送记录', '#outreach-tab-deliveries', '#outreach-panel-deliveries tbody tr'],
    ];
    const timings = clicks.map(() => []);
    if (!legacy) await page.locator('#root[data-interactive]').waitFor({ state: 'attached' });
    for (let iteration = 0; iteration < 6; iteration++) {
      if (!legacy && iteration === 1) {
        await page.route('**/api/v1/outreach/{state,deliveries}?*', async (route) => {
          await new Promise((resolve) => setTimeout(resolve, 900));
          await route.continue();
        });
      }
      for (const [index, [label, button, selector]] of clicks.entries()) {
        const elapsed = await page.evaluate(
          async ({ button, selector, label }) => {
            const before = performance.now();
            document.querySelector(button).click();
            while (!document.querySelector(selector)?.getClientRects().length) {
              if (performance.now() - before > 10000) throw new Error('Could not open ' + label);
              await new Promise(requestAnimationFrame);
            }
            await new Promise(requestAnimationFrame);
            return performance.now() - before;
          },
          { button, selector, label },
        );
        timings[index].push(elapsed);
        if (label === '客户详情') {
          await page.keyboard.press('Escape');
          await page.locator('.prospect-title h2').waitFor({ state: 'detached' });
        }
      }
    }
    for (const [index, [label]] of clicks.entries()) {
      const stats = samples(timings[index]);
      console.log('点击 ' + label, JSON.stringify(stats));
      worst = Math.max(worst, stats.maxMs);
    }
    if (!legacy) assert.ok(worst <= 700, `页面有效内容最慢 ${worst} ms（目标 700 ms）`);
  }
} finally {
  await browser?.close();
  if (app) await new Promise((resolve) => app.close(resolve));
  else {
    leads.close();
    await service.close();
  }
  await rm(folder, { recursive: true, force: true });
}
