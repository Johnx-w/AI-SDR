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
    CONNECTIONS_PATH: join(dir, 'connections.json'),
    BRANDING_CACHE_PATH: join(dir, 'branding'),
  };
const knowledge = new ProductKnowledge(env.PRODUCT_KNOWLEDGE_DB_PATH);
const saleProduct = knowledge.save({
  name: 'QA 布艺帘轨道',
  direction: 'materials',
  sourceUrl: 'https://honeybadgerblinds.com',
  status: 'approved',
  approvedBy: 'QA',
});
const me = 'sales@honeybadgerblinds.com',
  peer = 'buyer@dealer.test',
  inbox = [],
  sent = [];
const crm = new CustomerBusiness({
  customer: async (id) => (id === 'qa' ? { record_id: id } : null),
});
const boxes = new OutreachMailboxes({
  env: {},
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
const app = createApp({
  env,
  outreachServiceFactory: () => service,
  fetchImpl: async () => {
    throw Error('本验收仅使用本地测试数据');
  },
});
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
  page.on('dialog', (dialog) => dialog.accept());
  page.setDefaultTimeout(10000);
  const button = (name) => page.getByRole('button', { name, exact: true }),
    tab = (name) => page.getByRole('tab', { name: new RegExp(name) });
  const label = (name) => page.getByLabel(name, { exact: true });
  await page.goto(base + '/inbox');
  for (const name of ['邮箱管理', '触达计划', '收件箱', '跟进序列']) await tab(name).waitFor();
  assert.equal(await tab('邮箱管理').getAttribute('aria-selected'), 'true');
  await button('添加邮箱').first().click();
  await label('发件邮箱').fill(me);
  await label('业务员姓名 / 发件人名称').fill('Jo');
  await label('负责人').fill('Jo');
  await page.locator('input[name=password]').fill('browser-test-only');
  assert.equal(await page.getByRole('checkbox', { name: /QA 布艺帘轨道/ }).count(), 0);
  await label('业务备注').fill('周五交接客户');
  await button('保存邮箱').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const card = page.locator('.outreach-mailbox-card').filter({ hasText: me });
  await card.getByText('周五交接客户', { exact: true }).waitFor();
  const configuration = boxes.list()[0];
  assert.deepEqual(configuration.productIds, [saleProduct.id]);
  for (const businessNote of ['周三交接客户', '']) {
    await card.getByRole('button', { name: '配置', exact: true }).click();
    await label('业务备注').fill(businessNote);
    const submitted = page.waitForRequest(
      (req) => req.method() !== 'GET' && req.url().includes('/outreach/mailboxes'),
    );
    await button('保存邮箱').click();
    const request = await submitted;
    assert.equal(request.method(), 'PATCH');
    assert.ok(request.url().endsWith('/' + configuration.id + '/note'));
    assert.deepEqual(request.postDataJSON(), { businessNote });
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    assert.equal(
      await card
        .locator('.outreach-business-note')
        .allTextContents()
        .then((notes) => notes.join('')),
      businessNote,
    );
    assert.deepEqual(boxes.list()[0], configuration);
  }
  console.log('PASS 官网匹配可推产品，备注编辑与清空仅提交备注，不改发件配置');
  await button('验证连接').click();
  await page.getByText('SMTP 发件与 IMAP 收件、已发送文件夹均已验证。', { exact: true }).waitFor();
  await page.goto(base + '/materials');
  await label('品牌邮箱筛选').selectOption('honeybadgerblinds.com');
  const choosing = page.waitForEvent('filechooser');
  await button('选择文件上传').click();
  await (await choosing).setFiles(resolve('tests/fixtures/mail-specimen.xlsx'));
  await button('预览 mail-specimen').click();
  const material = page.getByRole('dialog', { name: '素材详情' });
  await label('查找型号或主题').fill('ZX-01');
  await material.getByText('2 · ZX-01', { exact: true }).click();
  assert.equal(await label('规格!B2').inputValue(), 'Aluminium');
  await label('规格!B2').fill('Aluminium alloy');
  await button('保存校对').click();
  await material.getByText('校对已保存', { exact: true }).waitFor();
  await label('审核人').fill('QA');
  await button('审核通过').click();
  await material.getByText('审核人 QA', { exact: true }).waitFor();
  await button('关闭素材详情').click();
  console.log('PASS 按邮箱官网上传工作簿、定位原单元格、校对与审核');

  await page.goto(base + '/inbox');
  await button('配置').click();
  const mode = page.getByRole('combobox', { name: /接待方式/ });
  assert.equal(await page.getByRole('checkbox', { name: /mail-specimen/ }).count(), 0);
  await mode.selectOption('review');
  await page.getByRole('checkbox', { name: /mail-specimen/ }).check();
  await button('保存邮箱').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  const mailbox = boxes.list()[0];
  assert.deepEqual(mailbox.productIds, [saleProduct.id]);
  assert.equal(mailbox.knowledgeProductIds.length, 1);
  assert.equal(knowledge.get(mailbox.knowledgeProductIds[0]).name, 'mail-specimen');
  await page.getByText('按此邮箱资料试问', { exact: true }).click();
  await label('客户问题').fill('What material is ZX-01 made of?');
  await button('预览答复').click();
  await page.getByText(/Material: Aluminium alloy/).waitFor();
  await label('客户问题').fill('What material is Shuangsheng ZX-01 made of?');
  await button('预览答复').click();
  await page.getByText('问题超出当前官网资料范围', { exact: true }).waitFor();
  assert.equal(await page.getByText(/Material: Aluminium alloy/).count(), 0);
  console.log('PASS 邮箱配置、资料授权、SMTP 与 IMAP 替身验证、问答及跨站隔离');
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
  await tab('收件箱').click();
  await button('同步邮件').click();
  await page
    .getByRole('button', { name: /Track material/ })
    .first()
    .waitFor();
  await button('待审').click();
  await page.getByRole('button', { name: /Track material/ }).click({ timeout: 20_000 });
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
  assert.match(sent[0].text, /Material: Aluminium alloy/);
  await button('全部').click();
  await page.getByRole('button', { name: /Track material/ }).click();
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
