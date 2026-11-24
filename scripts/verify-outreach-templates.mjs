import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright-core';

// Check a fresh sandbox, leaving the presenter's policies and sample groups intact.
const child = spawn(process.execPath, ['scripts/demo-outreach-templates.mjs', '0'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
let browser;
try {
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(Error('演示启动超时')), 25000);
    child.stdout.on('data', (buf) => {
      output += buf;
      const match = output.match(/(http:\/\/127\.0\.0\.1:\d+)\/inbox/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(Error('演示退出 ' + code));
    });
    child.once('error', reject);
  });
  const path = [
    process.env.MAIL_BROWSER_PATH,
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find((p) => p && existsSync(p));
  browser = await chromium.launch({ executablePath: path, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.goto(base + '/demo');
  assert.equal(page.url(), base + '/inbox?tab=sequences');
  const policy = page.getByRole('region', { name: '未回复跟进规则' });
  await policy.getByText('负责邮箱发出首封后开始计时。').waitFor();
  for (const label of ['起点', '首封后第 3 天', '首封后第 7 天'])
    await policy.getByText(label, { exact: true }).waitFor();
  await button('编辑序列').click();
  const dialogEditor = page.getByRole('dialog', { name: '编辑跟进序列' });
  const first = dialogEditor.locator('details').filter({ hasText: '首封开发信模板' });
  const step = (n) => dialogEditor.getByRole('group', { name: '跟进 ' + n, exact: true });
  const preview = (group) => group.getByRole('button', { name: '预览示例邮件' });
  assert.equal(await first.getAttribute('open'), null);
  await first.locator('summary').click();
  await preview(first).click();
  await first
    .locator('article')
    .filter({ hasText: 'Would a brief product overview be useful to your team?' })
    .waitFor();
  const body =
    'I saw that your window furnishings range includes roller blinds for customers who are comparing products.';
  const closing = 'Would the roller blinds product card help your team?';
  const follow = 'Would you like to review the roller blinds card together?';
  await page.getByLabel('首封主题与正文写作要求').fill(body);
  await page.getByLabel('首封结尾写作要求').fill(closing);
  await page.getByLabel('跟进 1 写作要求').fill(follow);
  for (const [group, needle] of [
    [first, closing],
    [step(1), follow],
  ]) {
    await preview(group).click();
    const article = group.locator('article');
    await article.waitFor();
    assert.ok((await article.textContent()).includes(needle));
  }
  // A step moved ahead of a sibling must preview at its new chronological position.
  await button('添加步骤').click();
  await page.getByLabel('跟进 3 天数').fill('1');
  await page.getByLabel('跟进 3 写作要求').fill(follow);
  const previewRequest = page.waitForRequest((r) => r.url().endsWith('/sequence-policy/preview'));
  await preview(step(3)).click();
  assert.equal((await previewRequest).postDataJSON().step, 1);
  await step(3).locator('article').waitFor();
  await button('删除跟进 3').click();
  await button('保存序列').click();
  await page.getByText('序列已保存').waitFor();
  await page.reload();
  await button('编辑序列').click();
  await first.locator('summary').click();
  for (const [label, value] of [
    ['首封主题与正文写作要求', body],
    ['首封结尾写作要求', closing],
    ['跟进 1 写作要求', follow],
  ])
    assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), value);
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(step(1)).click();
  await step(1).locator('article').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(
    await page
      .locator('.sequence-form-body')
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  const footer = await button('保存序列').boundingBox();
  const dialog = await page.getByRole('dialog').boundingBox();
  assert.ok(footer.y >= dialog.y && footer.y + footer.height <= dialog.y + dialog.height);
  await button('取消').click();
  await page.goto(base + '/demo/records');
  const response = page.waitForResponse(
    (r) => r.url() === base + '/demo/run' && r.request().method() === 'POST',
  );
  await button('用已保存模板生成并模拟发送').click();
  const submitted = await response;
  assert.equal(submitted.status(), 303, submitted.status() === 303 ? '' : await submitted.text());
  const section = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: '模板试演 1' }) });
  await section.locator('summary').click();
  const record = await section.textContent();
  for (const needle of [body, closing, follow, 'accepted'])
    assert.ok(record.includes(needle), record);
  await section.getByRole('link').click();
  await page.getByRole('heading', { name: '模板试演 1' }).waitFor();
  await button('查看首封').click();
  await page.getByRole('heading', { name: '首封实发邮件' }).waitFor();
  await page
    .getByRole('dialog')
    .frameLocator('iframe')
    .getByText(closing, { exact: false })
    .first()
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    '1440px / 390px: preview, save, reload, generate, day-3 dispatch, historical delivery readback passed.',
  );
} finally {
  await browser?.close();
  if (child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'exit');
    child.kill();
    await done;
  }
}
