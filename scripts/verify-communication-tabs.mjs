import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { OutreachService } from '../server/outreach-service.mjs';

// Measure the visible glyphs in the message, including when the HTML body lives in a sandboxed iframe.
function visibleReply(viewer) {
  const frame = viewer.querySelector('iframe');
  const root = frame
    ? frame.contentDocument?.body
    : viewer.querySelector('.mail-conversation-body');
  if (!root) throw new Error('邮件正文未加载');
  const pane = viewer.closest('.inbox-thread-scroll').getBoundingClientRect();
  const bounds = (frame || root).getBoundingClientRect();
  const left = Math.max(0, pane.left, bounds.left),
    right = Math.min(innerWidth, pane.right, bounds.right);
  const top = Math.max(0, pane.top, bounds.top),
    bottom = Math.min(innerHeight, pane.bottom, bounds.bottom);
  const dx = frame ? bounds.left + frame.clientLeft : 0,
    dy = frame ? bounds.top + frame.clientTop : 0;
  const lines = new Set();
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (!text.textContent.trim()) continue;
    const range = doc.createRange();
    range.selectNodeContents(text);
    for (const rect of range.getClientRects()) {
      const l = Math.max(left, rect.left + dx),
        r = Math.min(right, rect.right + dx);
      const y = (rect.top + rect.bottom) / 2 + dy,
        x = (l + r) / 2;
      if (r - l < 3 || rect.top + dy < top - 0.5 || rect.bottom + dy > bottom + 0.5) continue;
      const hit = document.elementFromPoint(x, y);
      if (
        frame
          ? hit === frame && root.contains(doc.elementFromPoint(x - dx, y - dy))
          : root.contains(hit)
      )
        lines.add(Math.round(y));
    }
  }
  return {
    lines: lines.size,
    paneWidth: Math.round(pane.width),
    paneHeight: Math.round(pane.height),
    bodyWidth: Math.round(right - left),
    bodyHeight: Math.round(bottom - top),
  };
}

function completeListRows(list) {
  const bounds = list.getBoundingClientRect();
  return [...list.querySelectorAll('.mail-conversation-row')].filter((row) => {
    const r = row.getBoundingClientRect(),
      x = (r.left + r.right) / 2;
    return (
      r.height > 0 &&
      r.top >= Math.max(bounds.top, 0) - 0.5 &&
      r.bottom <= Math.min(bounds.bottom, innerHeight) + 0.5 &&
      [r.top + 1, r.bottom - 1].every((y) => row.contains(document.elementFromPoint(x, y)))
    );
  }).length;
}

const directory = mkdtempSync(join(tmpdir(), 'shadeflow-communication-'));
let readerFails = false;
const boxes = new OutreachMailboxes({
  env: {},
  path: join(directory, 'mailboxes.json'),
  seedPath: null,
  protect: async () => ({
    credential: 'fixture-handle',
    credentialProtection: 'aes-256-gcm-local-key',
  }),
  unprotect: async () => 'synthetic',
  transportFactory: () => ({ verify: async () => true, sendMail: assert.fail }),
  mailboxReaderFactory: () => ({
    read: async () => {
      if (readerFails) throw new Error('Simulated mailbox connection failure');
      return {
        folders: ['INBOX', 'Sent'].map((path) => ({
          path,
          uidValidity: '1',
          nextUid: 1,
          sent: path === 'Sent',
          messages: [],
        })),
        folderCoverage: { inbox: true, sent: true },
        hasMore: false,
      };
    },
  }),
  imapFactory: assert.fail,
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
const app = createApp({
  env,
  dist: process.env.MAIL_BROWSER_DIST ? resolve(process.env.MAIL_BROWSER_DIST) : undefined,
  outreachServiceFactory: () => service,
});
let browser;
try {
  const mailboxes = await boxes.import(
    ['one', 'two'].map((prefix) => ({
      email: prefix + '@brand.example',
      owner: 'QA',
      signature: 'QA team',
      clientPassword: 'synthetic',
    })),
  );
  const box = mailboxes[0];
  for (const mailbox of mailboxes) await boxes.verify(mailbox.id);
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
  const remoteImageUrl = 'https://mail-image.example/qa.png';
  const remoteImageRequests = [];
  page.on('pageerror', (e) => failures.push(e.message));
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.href === remoteImageUrl) {
      remoteImageRequests.push(url.href);
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
      });
    }
    return url.origin === base ? route.continue() : route.abort();
  });
  page.setDefaultTimeout(10000);
  const tab = (name) => page.getByRole('tab', { name: new RegExp(name) });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const close = () => button('关闭弹窗').click();
  const headingStyle = () =>
    page.locator('.page-heading').evaluate((heading) => {
      const title = heading.querySelector('h1');
      const description = heading.querySelector('p');
      const headingBox = heading.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const descriptionBox = description?.getBoundingClientRect();
      return {
        titleSize: getComputedStyle(title).fontSize,
        titleWeight: getComputedStyle(title).fontWeight,
        titleTop: Math.round(titleBox.top - headingBox.top),
        descriptionTop: descriptionBox ? Math.round(descriptionBox.top - headingBox.top) : null,
        stacked: !!descriptionBox && descriptionBox.top >= titleBox.bottom - 1,
      };
    });
  const label = (name) => page.getByLabel(name, { exact: true });
  await page.goto(base + '/inbox');
  await page.getByRole('heading', { name: box.email, exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 4);
  const mailboxesHeading = await headingStyle();
  await tab('跟进序列').click();
  const rules = page.getByRole('region', { name: '未回复跟进规则' });
  await rules.getByRole('button', { name: '编辑序列' }).waitFor();
  assert.equal(await rules.locator('ol li').count(), 3);
  await button('编辑序列').click();
  await label('序列名称').fill('QA 自定义跟进');
  await button('添加步骤').click();
  await label('跟进 3 天数').fill('7');
  await label('跟进 3 写作要求').fill('询问是否需要样品。');
  await button('保存序列').click();
  await page.getByRole('alert').filter({ hasText: '同一天' }).waitFor();
  await label('跟进 3 天数').fill('11');
  await button('保存序列').click();
  await rules.getByText('首封后第 11 天').waitFor();
  await page.reload();
  await rules.getByRole('heading', { name: 'QA 自定义跟进' }).waitFor();
  await button('编辑序列').click();
  await button('删除跟进 3').click();
  await button('保存序列').click();
  await rules.getByText('序列已保存').waitFor();
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
  assert.deepEqual(await headingStyle(), mailboxesHeading);
  assert.equal(mailboxesHeading.stacked, true);
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
  const contact = page.getByRole('complementary', { name: '联系人及接待设置' });
  if (!(await contact.isVisible())) await button('联系人资料').click();
  await contact.getByRole('link', { name: '邮箱设置' }).click();
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
  await page.waitForFunction(() => {
    const compose = document.querySelector('.inbox-compose');
    const send = compose?.querySelector('footer .primary');
    return (
      !!send &&
      compose.getBoundingClientRect().bottom <= innerHeight &&
      send.getBoundingClientRect().bottom <= innerHeight
    );
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.setViewportSize({ width: 541, height: 773 });
  await page.waitForFunction(() => {
    const workspace = document
      .querySelector('.mail-conversations-workspace')
      ?.getBoundingClientRect();
    return workspace && workspace.height >= 515 && workspace.bottom <= innerHeight;
  });
  await page.setViewportSize({ width: 390, height: 667 });
  const readingPane = page.locator('.inbox-thread-scroll');
  await page.waitForFunction(
    () => document.querySelector('.inbox-thread-scroll')?.clientHeight >= 150,
  );
  const idleReadingHeight = await readingPane.evaluate((element) => element.clientHeight);
  await label('回复正文').focus();
  await button('正文格式').waitFor();
  assert.ok((await readingPane.evaluate((element) => element.clientHeight)) < idleReadingHeight);
  const sendBounds = await page.locator('.inbox-compose footer .primary').boundingBox();
  assert.ok(
    sendBounds && sendBounds.y + sendBounds.height <= 667,
    '短屏手机展开编辑后可看到发送按钮',
  );
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
        bodyText:
          i === 30
            ? 'Could you confirm the finish, mounting options and lead time for our showroom samples before we place the order?'
            : 'Enquiry body ' + i,
        unread: true,
      });
    }
  });
  await page.setViewportSize({ width: 1397, height: 773 });
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
  const title = messageBody.locator('.inbox-thread-tools h2');
  assert.equal(await title.getAttribute('title'), first.subject);
  assert.equal(
    await messageBody.getByRole('heading', { name: first.subject, exact: true }).count(),
    1,
  );
  const contactWasClosed = !(await contact.isVisible());
  if (contactWasClosed) await button('联系人资料').click();
  await contact.getByText('负责人 · QA', { exact: true }).waitFor();
  if (contactWasClosed) await button('关闭联系人资料').click();
  const editor = label('回复正文');
  await page.waitForFunction(() => {
    const viewport = document.querySelector('.inbox-thread-scroll')?.getBoundingClientRect();
    const body = document
      .querySelector('.inbox-message[open] .mail-body-viewer')
      ?.getBoundingClientRect();
    return (
      viewport &&
      viewport.height >= 300 &&
      body &&
      body.top >= viewport.top &&
      body.top + 20 <= viewport.bottom
    );
  });
  for (const [selector, minimum] of [
    ['.mail-conversation-row-top strong', 14],
    ['.mail-conversation-row-subject', 14],
    ['.mail-conversation-row-top time', 12],
    ['.inbox-sender b', 14],
    ['.inbox-message > summary time', 12],
  ]) {
    const size = await page
      .locator(selector)
      .first()
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    assert.ok(size >= minimum, selector + ' 字号 ' + size + ' 应至少为 ' + minimum);
  }
  const rowHeights = [];
  for (const [enquiry, lines] of [
    [29, 1],
    [30, 2],
  ]) {
    const row = page.getByRole('button', { name: new RegExp('Fixture enquiry ' + enquiry) });
    const layout = await row.evaluate((element) => {
      const sender = element.querySelector('.mail-conversation-row-top strong');
      const preview = element.querySelector('.mail-conversation-preview');
      const previewBounds = preview.getBoundingClientRect();
      const subject = element
        .querySelector('.mail-conversation-row-subject')
        .getBoundingClientRect();
      return {
        height: element.getBoundingClientRect().height,
        lines: Math.round(previewBounds.height / parseFloat(getComputedStyle(preview).lineHeight)),
        senderWeight: getComputedStyle(sender).fontWeight,
        previewWeight: getComputedStyle(preview).fontWeight,
        ordered:
          sender.getBoundingClientRect().bottom < previewBounds.top &&
          previewBounds.bottom < subject.top,
        fullWidth: previewBounds.left === subject.left && previewBounds.right === subject.right,
      };
    });
    assert.equal(layout.lines, lines);
    assert.ok(layout.ordered && layout.fullWidth, JSON.stringify(layout));
    assert.equal(layout.senderWeight, '500');
    assert.equal(layout.previewWeight, '400');
    assert.equal(await row.locator('.inbox-brand-label, .mail-conversation-row-count').count(), 0);
    rowHeights.push(layout.height);
  }
  assert.ok(rowHeights[1] > rowHeights[0], '长短摘要随内容改变列表项高度');
  const draftBody = 'Draft retained while paging';
  assert.equal(await editor.innerText().then((t) => t.trim()), '');
  assert.equal(service.replies.draft(firstThreadId), null);
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
  await label('共 1 段会话').waitFor();
  assert.equal(await pager.isVisible(), false);
  assert.equal(await page.locator('.mail-conversation-row').count(), 1);
  assert.equal(service.replies.draft(firstThreadId).bodyText, draftBody + '\n\nQA team');
  await label('搜索邮件会话').fill('');
  await pager.getByText('共 32 段 · 1 / 2').waitFor();
  await page.getByRole('button', { name: /Fixture enquiry 30/ }).click();
  await button('内部备注').click();
  await label('内部备注正文').fill('Discuss samples with sales colleagues.');
  await button('添加备注').click();
  await page
    .locator('.inbox-team-note')
    .getByText('Discuss samples with sales colleagues.')
    .waitFor();
  await button('回复客户').click();
  assert.equal(await editor.innerText().then((t) => t.trim()), '');
  await button('稍后处理').click();
  await button('1 小时后').click();
  await pager.getByText('共 32 段 · 1 / 2').waitFor();
  await label('其他处理状态').selectOption('later');
  await label('共 1 段会话').waitFor();
  await page.getByRole('button', { name: /Fixture enquiry 30/ }).click();
  await button('标为完成').click();
  await label('其他处理状态').selectOption('done');
  await page.getByRole('button', { name: /Fixture enquiry 30/ }).click();
  await page
    .locator('.inbox-team-note')
    .getByText('Discuss samples with sales colleagues.')
    .waitFor();
  await button('全部').click();
  await pager.getByText('共 32 段 · 1 / 2').waitFor();
  await page.getByRole('button', { name: /Fixture enquiry 30/ }).click();
  await button('重新打开').click();
  await pager.getByText('共 32 段 · 1 / 2').waitFor();
  // Real local IMAP records with distinct reply headers, across two configured accounts.
  function seedReply(mailbox, suffix, minute, from, options = {}) {
    const originalId = '<origin-' + suffix + '@brand.example>';
    const subject = 'Panel request ' + suffix;
    const receivedAt = new Date(Date.UTC(2026, 0, 3, 0, minute)).toISOString();
    service.conversations.putMessage(mailbox, {
      identity: 'origin-' + suffix,
      messageId: originalId,
      source: 'imap',
      direction: 'outbound',
      deliveryStatus: 'sent',
      from: mailbox.email,
      to: from,
      occurredAt: '2026-01-02T00:00:00.000Z',
      subject,
      bodyText: 'Which panels do you need?',
    });
    service.conversations.putMessage(mailbox, {
      identity: 'reply-' + suffix,
      messageId: '<reply-' + suffix + '@dealer.example>',
      inReplyTo: originalId,
      source: 'imap',
      direction: 'inbound',
      deliveryStatus: 'received',
      from,
      to: mailbox.email,
      occurredAt: receivedAt,
      subject: 'Re: ' + subject,
      bodyText: 'Please quote 72 mm panels for ' + suffix,
      unread: minute % 2 === 0,
      ...options,
    });
  }
  const longReply = [
    'Thank you for the panel information.',
    'We are preparing a sample kit for our showroom.',
    'Our clients asked to compare two finishes before choosing.',
    'Could you confirm the panel material and the finish options?',
    'We would like to check how the handles feel in person.',
    'The team will review the drawings on Friday morning.',
    'Please include the installation notes for the small display.',
    'We can confirm the final quantities after the sample review.',
    'Which mounting option would you suggest for this project?',
    'The east display will represent a narrow living room window.',
    'We have space for a second panel beside the timber samples.',
    'Our installer is available to review the drawing next week.',
    'Would a corner detail help explain the mounting options?',
    'The headrail will be visible from the entrance to the showroom.',
    'Please indicate which end caps should be on the sample board.',
    'Let me know what dimensions you need before preparing the drawing.',
    'I will share your suggestions with our installation team.',
    'Best regards,',
    'Jordan',
  ];
  service.transaction(() => {
    for (let i = 0; i < 26; i++)
      seedReply(
        box,
        'dealer-' + String(i).padStart(2, '0'),
        i,
        'dealer' + i + '@dealer.example',
        i === 25
          ? {
              bodyText: longReply.join('\n'),
              bodyHtml:
                longReply.map((line) => '<div>' + line + '</div>').join('') +
                '<table style="font: italic 13px/20px Georgia, serif"><tr><td>Finish reference</td></tr></table>' +
                `<img src="${remoteImageUrl}" alt="远程图片自动加载验收">`,
              bodyFormatVersion: 2,
            }
          : i === 0
            ? {
                bodyText:
                  'Please quote 72 mm panels.\n' +
                  'Dimensions and finish for this room.\n'.repeat(50),
              }
            : {},
      );
    seedReply(mailboxes[1], 'other-mailbox', 26, 'other@dealer.example');
    seedReply(box, 'internal', 27, mailboxes[1].email);
    seedReply(box, 'bounce', 28, 'postmaster@dealer.example', {
      subject: 'Delivery failure',
      bodyText: 'User unknown',
    });
    seedReply(box, 'receipt', 29, 'no-reply@dealer.example', {
      subject: 'Automatic reply',
      bodyText: 'This is an automated message.',
    });
  });
  const oldest = service.conversations.list({ mailboxId: box.id, q: 'Panel request dealer-00' })
    .items[0].id;
  await page.goto(
    base +
      '/inbox?' +
      new URLSearchParams({ tab: 'inbox', mailboxId: box.id, thread: oldest, hasReply: '1' }),
  );
  await pager.getByText('共 26 段 · 1 / 2').waitFor();
  assert.equal(await button('有回复').getAttribute('aria-pressed'), 'true');
  await messageBody
    .getByRole('heading', { name: 'Panel request dealer-00', exact: true })
    .waitFor();
  const titleTop = await title.evaluate((el) => el.getBoundingClientRect().top);
  const scrollOffset = await messageBody.locator('.inbox-thread-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  assert.ok(scrollOffset > 0);
  assert.equal(await title.evaluate((el) => el.getBoundingClientRect().top), titleTop);
  assert.equal(await page.locator('.mail-conversation-row.selected').count(), 0);
  await pager.getByRole('button', { name: '下一页' }).click();
  await pager.getByText('共 26 段 · 2 / 2').waitFor();
  await page
    .locator('.mail-conversation-row.selected')
    .getByText('Panel request dealer-00', { exact: true })
    .waitFor();
  await button('刷新').click();
  await pager.getByText('共 26 段 · 2 / 2').waitFor();
  await messageBody
    .getByRole('heading', { name: 'Panel request dealer-00', exact: true })
    .waitFor();
  await label('搜索邮件会话').fill('dealer-01');
  await label('共 1 段会话').waitFor();
  await label('筛选会话邮箱').selectOption(mailboxes[1].id);
  await label('共 0 段会话').waitFor();
  assert.equal(await label('搜索邮件会话').inputValue(), 'dealer-01');
  assert.equal(await button('有回复').getAttribute('aria-pressed'), 'true');
  await label('筛选会话邮箱').selectOption('all');
  await label('共 1 段会话').waitFor();
  await label('搜索邮件会话').fill('');
  await pager.getByText('共 27 段 · 1 / 2').waitFor();
  await button('未读').focus();
  await page.keyboard.press('Enter');
  const unreadCount = service.conversations.list({ unread: true }).total;
  await pager.getByText('共 ' + unreadCount + ' 段 · 1 / ' + Math.ceil(unreadCount / 25)).waitFor();
  assert.equal(await page.locator('.mail-conversation-row:not(.unread)').count(), 0);
  await button('全部').click();
  const allCount = service.conversations.list({}).total;
  await pager.getByText('共 ' + allCount + ' 段 · 1 / ' + Math.ceil(allCount / 25)).waitFor();
  assert.equal(allCount, 62);
  await service.conversations.sync({ mailboxId: box.id });
  assert.equal(service.conversations.syncState(box).error, null);
  const layoutResults = [];
  const readingViewports = [
    { width: 1600, height: 900, minBodyHeight: 395 },
    { width: 1397, height: 773, minBodyHeight: 300 },
    { width: 541, height: 773, minBodyHeight: 460 },
  ];
  for (const { width, height, minBodyHeight } of readingViewports) {
    await page.setViewportSize({ width, height });
    await page.goto(
      base + '/inbox?' + new URLSearchParams({ tab: 'inbox', mailboxId: box.id, hasReply: '1' }),
    );
    const rows = page.locator('.mail-conversation-items');
    const selectedRow = rows.getByRole('button', { name: /Panel request dealer-25/ });
    await selectedRow.waitFor();
    assert.equal(await page.locator('.mail-sync-summary').getAttribute('open'), null);
    const narrow = width === 541;
    const pageTitle = page.locator('.page-heading h1');
    if (narrow) {
      await pageTitle.waitFor();
      await tab('收件箱').waitFor();
      assert.equal(await button('有回复').getAttribute('aria-pressed'), 'true');
    }
    const completeRows = await rows.evaluate(completeListRows);
    await selectedRow.click();
    const viewer = page.locator('.inbox-message[open] .mail-body-viewer');
    const frame = viewer.frameLocator('iframe');
    const appFont = await page.locator('html').evaluate((el) => getComputedStyle(el).fontFamily);
    const typography = (el) => {
      const { fontFamily, fontSize, lineHeight, fontStyle } = getComputedStyle(el);
      return { fontFamily, fontSize, lineHeight, fontStyle };
    };
    assert.deepEqual(await frame.getByText(longReply[0], { exact: true }).evaluate(typography), {
      fontFamily: appFont,
      fontSize: '16px',
      lineHeight: '25.6px',
      fontStyle: 'normal',
    });
    assert.deepEqual(await frame.getByText('Finish reference').evaluate(typography), {
      fontFamily: 'Georgia, serif',
      fontSize: '13px',
      lineHeight: '20px',
      fontStyle: 'italic',
    });
    await viewer
      .frameLocator('iframe')
      .getByRole('img', { name: '远程图片自动加载验收' })
      .waitFor();
    assert.ok(remoteImageRequests.length > 0, '打开原邮件后应自动请求外链图片');
    assert.equal(await button('加载图片').count(), 0);
    if (narrow) {
      await pageTitle.waitFor({ state: 'hidden' });
      assert.equal(await tab('收件箱').isVisible(), false);
      assert.equal(await rows.isVisible(), false);
    }
    const html = await viewer.evaluate(visibleReply);
    assert.equal(await contact.isVisible(), false, '正常进入会话时保留完整阅读宽度');
    await viewer.getByRole('button', { name: '纯文本' }).click();
    await viewer.locator('.mail-conversation-body').waitFor();
    const plain = await viewer.evaluate(visibleReply);
    await button('联系人资料').click();
    await contact.getByText('负责人 · QA', { exact: true }).waitFor();
    if (narrow) await page.keyboard.press('Escape');
    else await button('关闭联系人资料').click();
    await contact.waitFor({ state: 'hidden' });
    assert.equal(await button('联系人资料').getAttribute('aria-expanded'), 'false');
    assert.equal((await viewer.evaluate(visibleReply)).paneWidth, plain.paneWidth);
    await viewer.getByRole('button', { name: '原邮件' }).click();
    await viewer.frameLocator('iframe').getByText(longReply[0], { exact: true }).waitFor();
    const back = button('返回会话列表');
    if (narrow) {
      await back.click();
      await pageTitle.waitFor();
      await tab('收件箱').waitFor();
      assert.equal(await label('筛选会话邮箱').inputValue(), box.id);
      assert.equal(await button('有回复').getAttribute('aria-pressed'), 'true');
    }
    await rows.getByRole('button', { name: /Panel request dealer-24/ }).click();
    await page
      .locator('.inbox-message[open] .mail-conversation-body')
      .getByText('Please quote 72 mm panels for dealer-24', { exact: true })
      .waitFor();
    if (narrow) await back.click();
    await rows.waitFor();
    const result = { width, height, completeRows, html, plain };
    const workspaceWidth = await page
      .locator('.mail-conversations-workspace')
      .evaluate((el) => el.clientWidth);
    for (const body of [html, plain]) {
      assert.ok(
        body.bodyWidth >= workspaceWidth * (narrow ? 0.87 : 0.64) &&
          body.bodyHeight >= minBodyHeight,
        JSON.stringify(result),
      );
    }
    layoutResults.push(result);
  }
  console.log('首屏度量', JSON.stringify(layoutResults));
  for (const result of layoutResults) {
    assert.ok(result.completeRows >= (result.width === 541 ? 2 : 3), JSON.stringify(result));
    assert.ok(result.html.lines >= 10 && result.plain.lines >= 10, JSON.stringify(result));
  }
  readerFails = true;
  await button('同步邮件').click();
  const syncStatus = page.locator('.mail-sync-summary');
  await syncStatus.getByText('1 个邮箱同步异常', { exact: true }).waitFor();
  if (!(await syncStatus.locator('[role="alert"]').isVisible()))
    await syncStatus.locator('summary').first().click();
  await syncStatus.locator('[role="alert"]').waitFor();
  await syncStatus.locator('summary').first().click();
  await page
    .locator('.mail-conversation-items')
    .getByRole('button', { name: /Panel request dealer-25/ })
    .click();
  await page
    .locator('.inbox-message[open]')
    .frameLocator('iframe')
    .getByText(longReply[0], { exact: true })
    .waitFor();
  assert.deepEqual(failures, []);
  console.log(
    'PASS 沟通中心四栏、邮箱配置、标签持久化与批量操作、筛选与刷新、三步序列、首封原文、外链图片自动加载、所属计划、统一字重、窄屏邮件往返、全部/未读/有回复与真实回信深链、草稿签名、分页、内部备注与稍后/完成/重开',
  );
} finally {
  await browser?.close();
  if (app.listening) await new Promise((resolve) => app.close(resolve));
  if (!service.closed) await service.close();
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
