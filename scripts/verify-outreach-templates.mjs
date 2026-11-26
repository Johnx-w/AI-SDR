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
  await page.goto(base + '/demo/followups');
  await button('客户跟进').waitFor();
  await page.getByRole('heading', { name: '已发送的客户', exact: true }).waitFor();
  const clientScript = await page.locator('script[type="module"][src]').getAttribute('src');
  const scriptResponse = await page.request.get(base + clientScript);
  assert.equal(scriptResponse.status(), 200);
  assert.match(scriptResponse.headers()['content-type'], /javascript/);
  await button('计划概况').click();
  await page.getByText('本次计划的客户范围与产品内容', { exact: true }).waitFor();
  await page.goto(base + '/demo');
  assert.equal(page.url(), base + '/inbox?tab=sequences');
  const policy = page.getByRole('region', { name: '未回复跟进规则' });

  for (const label of ['起点', '首封后第 3 天', '首封后第 7 天'])
    await policy.getByText(label, { exact: true }).waitFor();
  await button('编辑序列').click();
  const dialogEditor = page.getByRole('dialog', { name: '编辑跟进序列' });
  const preview = () => page.getByRole('button', { name: /^(生成预览|刷新预览)$/ }).click();
  const settings = () => page.getByRole('button', { name: /个性化设置/ }).click();
  const article = dialogEditor.locator('article');
  await preview();
  await article.getByText(/Would a brief product overview/).waitFor();
  const recipient = page.getByLabel('预览客户大类');
  const emailBody = page.getByLabel('邮件正文模板');
  const longBody = Array(18).fill('A product note for {{company}}.').join('\n\n');
  await emailBody.fill(longBody + '\n\nWould this detail help?');
  await preview();
  await article.getByText(/Would this detail help/).waitFor();
  await page.setViewportSize({ width: 1100, height: 713 });
  const endVisible = await dialogEditor.locator('.sequence-form-body').evaluate((area) => {
    area.scrollTop = area.scrollHeight;
    const bottom = area.getBoundingClientRect().bottom;
    const end = area.querySelector('.preview-paper article p').getBoundingClientRect().bottom;
    return area.scrollTop > 0 && end <= bottom + 1 && end > area.getBoundingClientRect().top;
  });
  assert.ok(endVisible, '长正文的签名应可滚动至弹窗可视范围');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await emailBody.fill('{{ai_body}}');
  await recipient.selectOption('');
  assert.ok(await button('生成预览').isDisabled());
  await recipient.selectOption('distributor');
  await preview();
  await article.waitFor();
  assert.ok(!(await article.innerText()).includes('Example Dealer'));
  await recipient.selectOption('distributor');
  await button('整封邮件').click();
  await button('生成建议').click();
  await button('采用建议').waitFor();
  assert.equal(await emailBody.inputValue(), '{{ai_body}}');
  await button('采用建议').click();
  assert.ok((await emailBody.inputValue()).includes('{{brand}}'));
  await emailBody.fill('Can I send the short overview?');
  await emailBody.focus();
  await emailBody.press('Control+a');
  await button('改写选区').click();
  await button('缩短').click();
  await button('生成建议').click();
  await button('采用建议').click();
  assert.equal(await emailBody.inputValue(), 'Would a brief overview help?');
  await page.getByRole('button', { name: /邮件主题.*单独起草/ }).click();
  await button('生成建议').click();
  await button('采用建议').click();
  assert.equal(
    await page.getByLabel('主题', { exact: true }).inputValue(),
    '{{product}} for {{company}}',
  );
  assert.equal(await emailBody.inputValue(), 'Would a brief overview help?');
  for (const [action, expected] of [
    ['开场白', '{{ai_opener}}'],
    ['附言（P.S.）', 'P.S. {{ai_question}}'],
  ]) {
    await button(action).click();
    await button('生成建议').click();
    await button('采用建议').click();
    assert.ok((await emailBody.inputValue()).includes(expected));
  }
  await emailBody.fill('');
  await page.getByRole('button', { name: /自定义 AI 变量/ }).click();
  await page.getByLabel('变量名称').fill('买家产品');
  await page.getByLabel('变量写作指引').fill('Describe the public product range in one sentence.');
  await page
    .locator('.compose-assistant')
    .getByRole('button', { name: '插入变量', exact: true })
    .click();
  assert.equal(await emailBody.inputValue(), '{{custom_买家产品}}');
  await preview();
  await article.getByText(/Your range includes roller blinds/).waitFor();
  await recipient.selectOption('manufacturer');
  await preview();
  await article.getByText(/Your workshop assembles roller blinds/).waitFor();
  await recipient.selectOption('distributor');
  await emailBody.fill('{{ai_body}}');
  await button('返回 AI 工具').click();
  await settings();
  await page.getByLabel('希望客户回什么').selectOption('sourcing');
  await preview();
  await article.getByText(/source roller blinds from external suppliers/).waitFor();
  await page.getByLabel('预览客户大类').selectOption('manufacturer');
  assert.equal(await article.count(), 0);
  await preview();
  await article.getByText(/Do you ever source finished units/).waitFor();
  const body =
    'I saw that your window furnishings range includes roller blinds for customers who are comparing products.';
  const closing = 'Would the roller blinds product card help your team?';
  const follow = 'Would you like to review the roller blinds card together?';
  await page.getByLabel('首封主题与正文写作要求').fill(body);
  await page.getByLabel('首封结尾写作要求').fill(closing);
  await emailBody.fill('For {{company}},\n\n{{custom_买家产品}}\n\n{{ai_body}}');
  await preview();
  await article.getByText(new RegExp(closing.slice(0, -1))).waitFor();
  await button('第 3 天跟进').click();
  await settings();
  await page.getByLabel('这次补充什么').selectOption('installation');
  await page.getByLabel('跟进 1 写作要求').fill(follow);
  await emailBody.fill('{{ai_opener}}{{ai_body}}{{ai_body}}');
  await preview();
  await article.waitFor();
  await dialogEditor.getByRole('status').filter({ hasText: '2 个问题' }).waitFor();
  assert.equal((await article.innerText()).split(follow).length - 1, 2);
  await emailBody.fill('A product note for {{company}}. {{ai_question}}');
  await dialogEditor.getByText(/2 个问题/).waitFor({ state: 'hidden' });
  await preview();
  await article.getByText(new RegExp(follow.slice(0, -1))).waitFor();
  await emailBody.press('Home');
  await page
    .locator('.compose-tools')
    .getByRole('button', { name: '插入变量', exact: true })
    .click();
  await page
    .locator('.variable-list')
    .getByRole('button', { name: '买家产品', exact: true })
    .click();
  assert.ok((await emailBody.inputValue()).includes('{{custom_买家产品}}'));
  await emailBody.fill('{{custom_买家产品}}\n\nA product note for {{company}}. {{ai_question}}');
  assert.equal(
    await emailBody.inputValue(),
    '{{custom_买家产品}}\n\nA product note for {{company}}. {{ai_question}}',
  );
  await preview();
  await article.getByText(new RegExp(follow.slice(0, -1))).waitFor();
  await button('第 7 天跟进').click();
  await settings();
  assert.equal(await page.getByLabel('这次补充什么').inputValue(), '');
  // A step moved ahead of a sibling must preview at its new chronological position.
  await button('添加步骤').click();
  await settings();
  await page.getByLabel('跟进 3 天数').fill('1');
  await page.getByLabel('跟进 3 写作要求').fill(follow);
  const previewRequest = page.waitForRequest((r) => r.url().endsWith('/sequence-policy/preview'));
  await preview();
  assert.equal((await previewRequest).postDataJSON().step, 1);
  await article.waitFor();
  await button('删除跟进 3').click();
  await button('第 3 天跟进').click();
  assert.equal(
    await emailBody.inputValue(),
    '{{custom_买家产品}}\n\nA product note for {{company}}. {{ai_question}}',
  );
  await button('保存序列').click();
  await page.getByText('序列已保存').waitFor();
  await page.reload();
  await button('编辑序列').click();
  await settings();
  assert.equal(await page.getByLabel('希望客户回什么').inputValue(), 'sourcing');
  for (const [label, value] of [
    ['首封主题与正文写作要求', body],
    ['首封结尾写作要求', closing],
  ])
    assert.equal(await page.getByLabel(label, { exact: true }).inputValue(), value);
  await page.setViewportSize({ width: 390, height: 844 });
  await button('第 3 天跟进').click();
  await settings();
  assert.equal(await page.getByLabel('这次补充什么').inputValue(), 'installation');
  assert.equal(await page.getByLabel('跟进 1 写作要求').inputValue(), follow);
  await preview();
  await article.waitFor();
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
  for (const needle of [
    body,
    closing,
    follow,
    'A product note for Dealer practice-1.',
    'For Dealer practice-1,',
    'Your range includes roller blinds.',
    'accepted',
  ])
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
