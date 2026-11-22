import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { OutreachService } from '../server/outreach-service.mjs';

const directory = mkdtempSync(join(tmpdir(), 'shadeflow-communication-'));
const boxes = new OutreachMailboxes({
  env: {},
  path: join(directory, 'mailboxes.json'),
  seedPath: null,
});
const customer = { id: 'test-buyer', name: 'QA buyer', email: 'buyer@dealer.example' };
const service = new OutreachService({
  path: join(directory, 'outreach.sqlite'),
  mailboxes: boxes,
  customers: () => [customer],
  now: () => Date.parse('2026-01-01T12:00:00Z'),
});
const env = {
  CONNECTIONS_PATH: join(directory, 'connections.json'),
  BRANDING_CACHE_PATH: join(directory, 'brands.json'),
};
const app = createApp({ env, outreachServiceFactory: () => service });
let browser;
try {
  const mailboxes = await boxes.import(
    ['one', 'two'].map((prefix) => ({ email: prefix + '@brand.example', owner: 'QA' })),
  );
  const box = mailboxes[0];
  while (!app.listening) {
    try {
      await new Promise((resolve, reject) => {
        app.once('error', reject);
        app.listen(randomInt(30000, 50000), '127.0.0.1', () => {
          app.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  env.PORT = String(app.address().port);
  const base = 'http://127.0.0.1:' + env.PORT;
  const executablePath = [
    process.env.MAIL_BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find((path) => path && existsSync(path));
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const failures = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
  );
  page.setDefaultTimeout(10000);
  const tab = (name) => page.getByRole('tab', { name: new RegExp(name) });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const close = () => button('关闭弹窗').click();
  const label = (name) => page.getByLabel(name, { exact: true });
  await page.goto(base + '/inbox');
  await page.getByRole('heading', { name: box.email, exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 4);
  await tab('跟进序列').click();
  const rules = page.getByRole('region', { name: '未回复跟进规则' });
  await rules.getByText('已进入序列的客户 0').waitFor();
  assert.equal(await rules.locator('ol li').count(), 3);
  const campaign = service.saveCampaign({
    name: 'QA follow-up sequence',
    mailboxIds: [box.id],
    followUpEnabled: true,
  });
  service.putCampaign({ ...campaign, status: 'completed' });
  const first = service.putDelivery({
    id: 'fixture-first',
    campaignId: campaign.id,
    mode: 'production',
    status: 'accepted',
    from: box.email,
    to: customer.email,
    customerId: customer.id,
    companyName: customer.name,
    mailboxId: box.id,
    subject: 'QA accepted first email',
    bodyText: 'Original text saved for QA',
    createdAt: '2026-01-01T00:00:00Z',
    sentAt: '2026-01-01T00:00:00Z',
    messageId: '<qa-first@brand.example>',
  });
  service.followUps.schedule(first, campaign);
  await tab('邮箱管理').click();
  await button('添加邮箱').first().click();
  await label('发件邮箱').waitFor();
  await close();
  await button('邮箱标签').click();
  async function createTag(name) {
    await label('新标签').fill(name);
    await button('新增标签').click();
    await button('改名').waitFor();
    const tag = page.getByRole('dialog').getByText(name, { exact: true }).last();
    await tag.waitFor();
  }
  await createTag('Region North');
  await label('选择全部邮箱').check();
  await button('添加所选标签').click();
  await page.getByRole('button', { name: 'Region North 2' }).waitFor();
  await button('改名').click();
  await label('修改名称').fill('North');
  await button('保存名称').click();
  await page.getByRole('button', { name: 'North 2' }).waitFor();
  await createTag('Distributors');
  await page.getByRole('button', { name: 'North 2' }).click();
  await button('合并').click();
  await label('合并到').selectOption({ label: 'Distributors' });
  await button('确认合并').click();
  await page.getByRole('button', { name: 'Distributors 2' }).waitFor();
  await close();
  await label('邮箱标签').selectOption({ label: 'Distributors' });
  assert.equal(await page.locator('.outreach-mailbox-card').count(), 2);
  await page.reload();
  await label('邮箱标签').selectOption({ label: 'Distributors' });
  await button('邮箱标签').click();
  await page.getByRole('button', { name: 'Distributors 2' }).click();
  await label('选择 ' + box.email).check();
  await button('移除所选标签').click();
  await page.getByRole('button', { name: 'Distributors 1' }).waitFor();
  await close();
  await label('邮箱标签').selectOption({ label: 'Distributors' });
  assert.equal(await page.locator('.outreach-mailbox-card').count(), 1);
  await button('邮箱标签').click();
  await page.getByRole('button', { name: 'Distributors 1' }).click();
  await button('删除').click();
  await button('确认删除').click();
  await page.getByRole('button', { name: 'Distributors 1' }).waitFor({ state: 'hidden' });
  await close();
  await page
    .locator('.outreach-mailbox-card')
    .filter({ hasText: box.email })
    .getByRole('button', { name: '查看邮件' })
    .click();
  assert.equal(await label('筛选会话邮箱').inputValue(), box.id);
  await button('未读').click();
  assert.equal(await label('筛选会话邮箱').inputValue(), box.id);
  await button('全部').click();
  await page.getByRole('button', { name: /QA accepted first email/ }).click();
  await page
    .getByRole('region', { name: '邮件会话详情' })
    .getByText(first.bodyText, { exact: true })
    .waitFor();
  await page.getByRole('button', { name: /QA accepted first email/ }).click();
  await button('刷新').click();
  await page
    .getByRole('region', { name: '邮件会话详情' })
    .getByText(first.bodyText, { exact: true })
    .waitFor();
  await page.getByRole('link', { name: '邮箱设置' }).click();
  await label('发件邮箱').waitFor();
  assert.equal(await label('发件邮箱').inputValue(), box.email);
  await close();
  assert.equal(new URL(page.url()).searchParams.has('mailboxId'), false);
  await tab('触达计划').click();
  await button('新建计划').click();
  await close();
  await tab('跟进序列').click();
  await button(campaign.name).click();
  await button('暂停跟进').click();
  await button('恢复跟进').click();
  await button('暂停跟进').waitFor();
  await page.getByRole('button', { name: /首封发出后第 3 天/ }).waitFor();
  await page.getByRole('button', { name: /首封发出后第 7 天/ }).click();
  await page.getByRole('cell', { name: /待跟进/ }).waitFor();
  const inboxLink = page.getByRole('table').getByRole('link', { name: '收件箱' });
  const linkedThread = new URL(await inboxLink.getAttribute('href'), base).searchParams;
  assert.equal(linkedThread.get('mailboxId'), box.id);
  assert.equal(
    linkedThread.get('thread'),
    service.conversations.list({ mailboxId: box.id }).items[0].id,
  );
  await button('查看首封').click();
  await page.getByRole('dialog').getByText(first.bodyText, { exact: true }).waitFor();
  await close();
  await page.getByRole('link', { name: '所属计划' }).click();
  await page.getByRole('dialog').getByText(campaign.name, { exact: true }).first().waitFor();
  await close();
  await page.setViewportSize({ width: 390, height: 844 });
  await tab('收件箱').click();
  await page.getByRole('button', { name: /QA accepted first email/ }).click();
  await page
    .getByRole('region', { name: '邮件会话详情' })
    .getByText(first.bodyText, { exact: true })
    .waitFor();
  await button('返回会话列表').click();
  await page.getByRole('button', { name: /QA accepted first email/ }).waitFor();
  const firstThreadId = linkedThread.get('thread');
  service.transaction(() => {
    for (let i = 0; i < 31; i++) {
      service.conversations.putMessage(box, {
        identity: 'page-fixture-' + i,
        messageId: '<page-' + i + '@dealer.example>',
        direction: 'inbound',
        source: 'imap',
        deliveryStatus: 'received',
        from: 'contact' + i + '@dealer.example',
        to: box.email,
        occurredAt: new Date(Date.UTC(2026, 0, 2, 0, i)).toISOString(),
        subject: 'Fixture enquiry ' + i,
        bodyText: 'Enquiry body ' + i,
        unread: true,
      });
    }
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(
    base +
      '/inbox?' +
      new URLSearchParams({ tab: 'inbox', thread: firstThreadId, mailboxId: box.id }),
  );
  const pager = page.getByRole('navigation', { name: '会话分页' });
  await pager.getByText('共 32 段 · 1 / 2').waitFor();
  assert.equal(await page.locator('.mail-conversation-row').count(), 25);
  const messageBody = page.getByRole('region', { name: '邮件会话详情' });
  await messageBody.getByText(first.bodyText, { exact: true }).waitFor();
  await page
    .getByRole('region', { name: '回复邮件' })
    .getByRole('button', { name: '回复', exact: true })
    .click();
  const editor = label('回复正文');
  const draftBody = 'Draft retained while paging';
  await editor.fill(draftBody);
  await pager.getByRole('button', { name: '下一页' }).click();
  await pager.getByText('共 32 段 · 2 / 2').waitFor();
  assert.equal(await page.locator('.mail-conversation-row').count(), 7);
  assert.equal(await editor.innerText(), draftBody);
  await button('刷新').click();
  await pager.getByText('共 32 段 · 2 / 2').waitFor();
  assert.equal(await editor.innerText(), draftBody);
  await pager.getByRole('button', { name: '上一页' }).click();
  await pager.getByText('共 32 段 · 1 / 2').waitFor();
  await pager.getByRole('button', { name: '下一页' }).click();
  await pager.getByText('共 32 段 · 2 / 2').waitFor();
  await page.getByText('草稿已保存', { exact: true }).waitFor();
  await label('搜索邮件会话').fill('Fixture enquiry 30');
  await pager.getByText('共 1 段 · 1 / 1').waitFor();
  assert.equal(await page.locator('.mail-conversation-row').count(), 1);
  assert.equal(service.replies.draft(firstThreadId).bodyText, draftBody);
  assert.deepEqual(failures, []);
  console.log(
    'PASS 沟通中心四栏、邮箱配置、标签持久化与批量操作、筛选与刷新、三步序列、首封原文、所属计划、窄屏邮件往返及会话翻页保留深链和草稿',
  );
} finally {
  await browser?.close();
  if (app.listening) await new Promise((resolve) => app.close(resolve));
  if (!service.closed) await service.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
