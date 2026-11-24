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
      const match = output.match(/(http:\/\/127\.0\.0\.1:\d+)\/demo/);
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
  await page.goto(base + '/inbox?tab=sequences');
  await button('编辑邮件模板').click();
  const fields = page.locator('fieldset');
  const preview = (i) => fields.nth(i).getByRole('button', { name: '预览示例邮件' });
  await preview(0).click();
  await fields
    .nth(0)
    .getByText(/May I send our one-page roller blinds product card/)
    .last()
    .waitFor();
  const body =
    'I saw that your window furnishings range includes roller blinds for customers who are comparing products.';
  const closing = 'Would the roller blinds product card help your team?';
  const follow = 'Would you like to review the roller blinds card together?';
  await page.getByLabel('首封主题与正文写作要求').fill(body);
  await page.getByLabel('首封结尾写作要求').fill(closing);
  await page.getByLabel('跟进 1 写作要求').fill(follow);
  for (const [i, needle] of [closing, follow].entries()) {
    await preview(i).click();
    const article = fields.nth(i).locator('article');
    await article.waitFor();
    assert.ok((await article.textContent()).includes(needle));
  }
  await button('保存序列').click();
  await page.getByText('序列已保存').waitFor();
  await page.reload();
  await button('编辑邮件模板').click();
  for (const [label, value] of [
    ['首封主题与正文写作要求', body],
    ['首封结尾写作要求', closing],
    ['跟进 1 写作要求', follow],
  ])
    assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), value);
  await page.setViewportSize({ width: 390, height: 844 });
  await preview(1).click();
  await fields.nth(1).locator('article').waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(
    await page
      .locator('.sequence-form-body')
      .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  );
  await button('取消').click();
  await page.goto(base + '/demo');
  await button('用已保存模板生成并模拟发送').click();
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
  assert.ok((await page.getByRole('dialog').textContent()).includes(closing));
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
