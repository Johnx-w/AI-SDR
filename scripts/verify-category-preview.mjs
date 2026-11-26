import { createApp } from '../server/app.mjs';
import { categoryPreviewFixture } from '../tests/fixtures/category-preview.mjs';
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
const h = categoryPreviewFixture();
const app = createApp({
  env: { PORT: '14419' },
  localMailInspection: { sync: async () => [] },
  outreachServiceFactory: () => h.service,
});
await new Promise((r) => app.listen(14419, '127.0.0.1', r));
const browser = await chromium.launch({
  headless: true,
  executablePath: [
    process.env.MAIL_BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find((p) => p && existsSync(p)),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const requests = [];
page.on('request', (r) => {
  if (r.method() !== 'GET') requests.push({ url: r.url(), method: r.method() });
});
try {
  await page.goto('http://127.0.0.1:14419/inbox?tab=sequences');
  await page.getByRole('button', { name: '编辑序列', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const boxes = page.getByLabel('预览发件邮箱'),
    category = page.getByLabel('预览客户大类');
  await boxes.locator('option').nth(2).waitFor({ state: 'attached' });
  const times = [];
  for (const box of h.boxes) {
    await boxes.selectOption(box.id);
    for (const role of ['manufacturer', 'distributor']) {
      const start = performance.now();
      await category.selectOption(role);
      const sample = dialog.getByRole('region', { name: '代表客户' });
      await sample
        .getByText(new RegExp(box.brandName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .waitFor();
      times.push({ box: box.id, role, ms: performance.now() - start });
      const old = await sample.locator('strong').innerText();
      await page.getByRole('button', { name: '更换同类样本' }).click();
      await page.waitForFunction(
        (old) =>
          document.querySelector('[aria-label="代表客户"] strong')?.textContent !== old &&
          !!document.querySelector('[aria-label="代表客户"] strong'),
        old,
      );
      for (const name of ['首封开发信', '第 3 天跟进', '第 7 天跟进']) {
        await page.getByRole('button', { name, exact: true }).click();
        await page.getByRole('button', { name: /^(生成预览|刷新预览)$/ }).click();
        const article = dialog.locator('.preview-paper article');
        await article.waitFor();
        const text = await article.innerText();
        assert.ok(text.includes(box.signature));
        assert.ok(!text.includes('{{'));
        assert.ok(!text.includes('Example'));
      }
    }
    await category.selectOption('contractor');
    await dialog.getByRole('alert').filter({ hasText: '没有合格样本' }).waitFor();
    assert.equal(await dialog.locator('.preview-paper article').count(), 0);
  }
  // Editing a template must invalidate previous AI results; stale responses cannot restore them.
  await boxes.selectOption('box-0');
  await category.selectOption('distributor');
  await page.getByRole('button', { name: '首封开发信', exact: true }).click();
  await page.getByRole('button', { name: /^(生成预览|刷新预览)$/ }).click();
  await dialog.locator('article').waitFor();
  await page.getByLabel('邮件正文模板').fill('A note for {{company}}. {{ai_body}}');
  assert.equal(await dialog.locator('.preview-paper article').count(), 0);
  await page.getByRole('button', { name: '生成预览', exact: true }).click();
  await dialog
    .locator('.preview-paper article')
    .getByText(/A note for/)
    .waitFor();
  // Run a deferred insertion caret callback exactly while a later paste is replacing all text.
  await page.getByLabel('邮件正文模板').fill('Original sentence.');
  await page
    .locator('.compose-tools')
    .getByRole('button', { name: '插入变量', exact: true })
    .click();
  await page.evaluate(() => {
    const original = window.requestAnimationFrame;
    const frames = [];
    window.requestAnimationFrame = (callback) => {
      frames.push(callback);
      return 0;
    };
    document.querySelector('[aria-label="邮件正文模板"]').addEventListener(
      'beforeinput',
      () => {
        window.requestAnimationFrame = original;
        frames.forEach((callback) => callback(performance.now()));
      },
      { once: true },
    );
  });
  await page
    .locator('.variable-list')
    .getByRole('button', { name: /客户公司/ })
    .click();
  await page.getByLabel('邮件正文模板').fill('Replacement for {{company}}.');
  assert.equal(await page.getByLabel('邮件正文模板').inputValue(), 'Replacement for {{company}}.');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  mkdirSync('outputs', { recursive: true });
  await page.screenshot({ path: 'outputs/category-preview.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '第 3 天跟进', exact: true }).click();
  await page.getByRole('button', { name: '整封邮件', exact: true }).click();
  let release;
  let seen;
  const arrived = new Promise((r) => (seen = r)),
    gate = new Promise((r) => (release = r));
  await page.route('**/sequence-policy/assist', async (route) => {
    seen();
    await gate;
    await route.fulfill({ json: { subject: '', text: 'Late previous step' } });
  });
  await page.getByRole('button', { name: '生成建议', exact: true }).click();
  await arrived;
  await page.getByRole('button', { name: '第 7 天跟进', exact: true }).click();
  await page.getByRole('button', { name: '整封邮件', exact: true }).click();
  const finished = page.waitForResponse((r) => r.url().endsWith('/sequence-policy/assist'));
  release();
  await finished;
  await page.getByRole('button', { name: '生成建议', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '采用建议', exact: true }).count(), 0);
  const apiTimes = [];
  for (const path of [
    '/sequence-policy/preview-options',
    '/sequence-policy/sample?category=manufacturer&mailboxId=box-0',
    '/sequence-policy/sample?category=distributor&mailboxId=box-1',
    '/sequence-policy/sample?category=contractor&mailboxId=box-2',
  ]) {
    const durations = [];
    let size;
    for (let i = 0; i < 11; i++) {
      const start = performance.now();
      const r = await page.request.get('http://127.0.0.1:14419/api/v1/outreach' + path);
      const body = await r.body();
      durations.push(performance.now() - start);
      size = body.length;
      assert.equal(r.status(), path.includes('contractor') ? 409 : 200);
    }
    const warm = durations.slice(1).sort((a, b) => a - b);
    apiTimes.push({ path, coldMs: durations[0], p50Ms: warm[5], maxMs: warm.at(-1), bytes: size });
  }
  console.log(
    JSON.stringify({
      apiTimes,
      plan: h.library.db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT record_id FROM lead_library_customers WHERE scope=? AND record_id>? ORDER BY record_id LIMIT 50',
        )
        .all('preview-qa', ''),
    }),
  );
  // Exhausting alternatives must keep the one real sample instead of calling the category empty.
  h.library.db
    .prepare('DELETE FROM lead_library_customers WHERE record_id!=?')
    .run('z0-distributor-0');
  await category.selectOption('contractor');
  await dialog.getByRole('alert').filter({ hasText: '没有合格样本' }).waitFor();
  await page.getByRole('button', { name: '首封开发信', exact: true }).click();
  await category.selectOption('distributor');
  const only = dialog.getByRole('region', { name: '代表客户' });
  await only.locator('strong').getByText('QA z0-dealer-0', { exact: true }).waitFor();
  await page.getByRole('button', { name: '更换同类样本', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '其他合格样本' }).waitFor();
  assert.equal(await only.locator('strong').innerText(), 'QA z0-dealer-0');
  assert.ok(await page.getByRole('button', { name: /^(生成预览|刷新预览)$/ }).isEnabled());
  assert.deepEqual(errors, []);
  assert.ok(requests.every((r) => /\/sequence-policy\/(preview|assist)$/.test(r.url)));
  assert.equal(h.sends, 0);
  console.log(
    JSON.stringify({
      dossiers: h.leads.length,
      sampleTimes: times,
      previewRequests: requests.length,
      uiErrors: errors,
    }),
  );
} finally {
  await browser.close();
  await new Promise((r) => app.close(r));
  await h.close();
}
