import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';
import { OutreachService } from '../server/outreach-service.mjs';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { recordMailConversation } from '../server/mail-conversation-business.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';

const root = resolve('.codex-tmp');
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, 'browser-')),
  env = {
    PRODUCT_KNOWLEDGE_DB_PATH: join(dir, 'knowledge.sqlite'),
    OUTREACH_DB_PATH: join(dir, 'outreach.sqlite'),
  };
const knowledge = new ProductKnowledge(env.PRODUCT_KNOWLEDGE_DB_PATH);
const me = 'sales@honeybadgerblinds.com',
  peer = 'buyer@dealer.test',
  inbox = [],
  sent = [];
const crm = new CustomerBusiness({
  customer: async (id) => (id === 'qa' ? { record_id: id } : null),
});
const boxes = new OutreachMailboxes({
  path: join(dir, 'mailboxes.json'),
  seedPath: null,
  protect: async () => ({
    credential: 'test-handle',
    credentialProtection: 'aes-256-gcm-local-key',
  }),
  unprotect: async () => 'synthetic',
  transportFactory: () => ({
    verify: async () => true,
    sendMail: async (mail) => {
      assert.equal(mail.to, peer);
      sent.push(mail);
      return { accepted: [mail.to] };
    },
  }),
  mailboxReaderFactory: () => ({
    read: async ({ checkOnly } = {}) => ({
      folderCoverage: { inbox: true, sent: true },
      folders: checkOnly
        ? []
        : [{ path: 'INBOX', uidValidity: '1', nextUid: 20, messages: inbox.splice(0) }],
      hasMore: false,
    }),
  }),
  imapFactory: () => {
    throw Error('No external IMAP archive in browser fixture');
  },
});
const record = (detail) => recordMailConversation({ store: crm, ...detail });
const service = new OutreachService({
  path: env.OUTREACH_DB_PATH,
  mailboxes: boxes,
  products: () => knowledge.list(),
  customers: () => [{ id: 'qa', name: 'Browser QA', email: peer }],
  businessState: () => crm.view(),
  recordCommunication: record,
  answerQuestion: (b, q) => answerMailQuestion(knowledge, b, q),
  setMailOwnership: async (detail, ownership, owner) => {
    const result = await record(detail);
    const c = crm.get('conversations', result.conversationId);
    await crm.saveConversation({ ...c, ownership, owner });
  },
});
const app = createApp({ env, outreachServiceFactory: () => service });
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + app.address().port;
env.PORT = String(app.address().port);
const path = [
  process.env.MAIL_BROWSER_PATH,
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((p) => p && existsSync(p));
let browser, page;
try {
  browser = await chromium.launch({ executablePath: path, headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.setDefaultTimeout(10000);
  const button = (name) => page.getByRole('button', { name, exact: true }),
    tab = (name) => page.getByRole('tab', { name: new RegExp(name) });
  const label = (name) => page.getByLabel(name, { exact: true });
  await page.goto(base + '/materials');
  await button('新增产品资料').click();
  await page.getByLabel('产品名称 *', { exact: true }).fill('QA 轨道规格');
  await label('适用品牌').fill('Honey Badger Blinds');
  await label('来源链接').fill('https://honeybadgerblinds.com');
  await button('保存草稿').click();
  await button('查看 / 编辑').click();
  await page
    .locator('input[type=file]')
    .setInputFiles(resolve('tests/fixtures/mail-specimen.xlsx'));
  await page.getByRole('button', { name: /解析工作簿/ }).click();
  await button('关联工作簿并校对').click();
  await label('查找型号或主题').fill('ZX-01');
  await page.getByText('2 · ZX-01', { exact: true }).click();
  await label('规格!B2').fill('Aluminium alloy');
  await page.getByRole('combobox', { name: /资料状态/ }).selectOption('approved');
  await label('审核人 *').fill('QA');
  await label('生效日期').fill('2026-01-01');
  await button('审核并保存').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  console.log('PASS 工作簿上传、逐格校对与产品审核');
  await page.goto(base + '/inbox?tab=mailboxes');
  await button('添加邮箱').first().click();
  await label('发件邮箱').fill(me);
  await label('业务员姓名 / 发件人名称').fill('Jo');
  await label('负责人').fill('Jo');
  await page.locator('input[name=password]').fill('browser-test-only');
  await page.getByRole('combobox', { name: /接待方式/ }).selectOption('review');
  const picks = page.getByRole('checkbox', { name: 'QA 轨道规格' });
  assert.equal(await picks.count(), 2);
  await picks.nth(0).check();
  await picks.nth(1).check();
  await button('保存邮箱').click();
  await button('验证连接').click();
  await page.getByText('SMTP 发件与 IMAP 收件、已发送文件夹均已验证。', { exact: true }).waitFor();
  await page.getByText('按此邮箱资料试问', { exact: true }).click();
  await label('客户问题').fill('What material is ZX-01 made of?');
  await button('预览答复').click();
  await page.getByText(/Material: Aluminium alloy/).waitFor();
  console.log('PASS 邮箱配置、资料授权、SMTP 与 IMAP 替身验证及问答预览');
  inbox.push({
    uid: 1,
    from: peer,
    to: me,
    toAddresses: [me],
    direction: 'inbound',
    messageId: '<browser-1@dealer.test>',
    subject: 'Track material',
    bodyText: 'What material is ZX-01 made of?',
    occurredAt: new Date().toISOString(),
  });
  await tab('邮件会话').click();
  page.on('dialog', (dialog) => dialog.accept());
  await button('同步邮件').click();
  await page
    .getByRole('button', { name: /Track material/ })
    .first()
    .waitFor();
  await tab('待审回信').click();
  await page.getByRole('link', { name: '查看并审核' }).click({ timeout: 20000 });
  await page.getByText('查看回复依据 · 2', { exact: true }).click();
  await page.getByText(/mail-specimen.xlsx.*规格!B2/).waitFor();
  await button('批准发送').click();
  await page
    .getByText(/已被服务商接受|服务商已接受/)
    .first()
    .waitFor();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, peer);
  assert.equal(sent[0].inReplyTo, '<browser-1@dealer.test>');
  await button('人工接管').click();
  await button('恢复邮箱接待').click();
  await button('人工接管').waitFor();
  await page.reload();
  await button('人工接管').waitFor();
  assert.equal(crm.view().conversations[0].ownership, 'auto');
  assert.equal(crm.view().messages.length, 2);
  assert.equal(service.reception.list().total, 0);
  assert.deepEqual(pageErrors, []);
  console.log('PASS 待审列表、原信及来源、批准一次、CRM 实际消息、人工接管、恢复与刷新回读');
} catch (e) {
  console.error(
    '测试收件处理',
    service.db
      .prepare("SELECT state,json_extract(info,'$.reason') AS reason FROM mail_reception")
      .all(),
  );
  if (page) {
    console.error((await page.locator('body').innerText()).slice(-1800));
    await page.screenshot({ path: join(root, 'mail-browser-failure.png') });
  }
  throw e;
} finally {
  await browser?.close();
  await service.close();
  await new Promise((r) => app.close(r));
  crm.close();
  knowledge.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
