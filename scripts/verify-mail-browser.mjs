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
    DEEPSEEK_API_KEY: 'local-browser-fixture',
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
const persona = '以工程项目销售的身份写正式英文回信，给采购团队一个明确的下一步。';
const introduction =
  'Dear Jordan,\n\nI understand that your purchasing team reviews supplier enquiries. Please forward this note to the colleague responsible for your project so they have a direct point of contact.\n\nA short outline of their purchasing priorities would help us prepare a focused discussion. They are welcome to reply in this thread when convenient.';
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
  getDraftModel: () => ({
    name: 'browser-reception',
    generate: async (messages) => {
      const { evidence } = JSON.parse(messages[1].content);
      assert.deepEqual(
        evidence.map((s) => s.value),
        ['ZX-01', 'Aluminium alloy'],
      );
      return JSON.stringify({
        body: 'For ZX-01, the material is Aluminium alloy.',
        sourceIndexes: [0, 1],
      });
    },
  }),
  setMailOwnership: async (detail, ownership, owner) => {
    const result = await record(detail);
    const c = crm.get('conversations', result.conversationId);
    await crm.saveConversation({ ...c, ownership, owner });
  },
});
let modelCalls = 0;
let finishModel;
const modelGate = new Promise((resolve) => {
  finishModel = resolve;
});
const app = createApp({
  env,
  outreachServiceFactory: () => service,
  fetchImpl: async (url, init) => {
    assert.equal(
      String(url),
      'https://api.deepseek.com/chat/completions',
      '本验收只允许本地模拟的起草请求',
    );
    modelCalls++;
    const payload = JSON.parse(init.body);
    assert.match(payload.model, /deepseek/i);
    const data = JSON.parse(payload.messages.find((message) => message.role === 'user').content);
    assert.ok(payload.messages[0].content.includes(persona));
    assert.equal(data.website, 'honeybadgerblinds.com');
    if (data.incoming.subject === 'Purchasing introduction') {
      assert.deepEqual(data.evidence, []);
      const content = JSON.stringify({ body: introduction, sourceIndexes: [] });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
    }
    const material = data.evidence.findIndex((source) => source.value === 'Aluminium alloy');
    assert.ok(material >= 0, '应使用已校对的已选资料');
    await modelGate;
    const content = JSON.stringify({
      body: 'The referenced track uses Aluminium alloy. What length do you need?',
      sourceIndexes: [material],
    });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
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
  assert.equal(await page.getByRole('checkbox', { name: /QA 布艺帘轨道/ }).isChecked(), false);
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
  assert.equal(await page.getByRole('checkbox', { name: /mail-specimen/ }).isChecked(), false);
  await page.getByRole('textbox', { name: /AI起草身份与语气/ }).fill(persona);
  await button('保存邮箱').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await button('配置').click();
  assert.equal(await page.getByRole('textbox', { name: /AI起草身份与语气/ }).inputValue(), persona);
  await mode.selectOption('business');
  await button('保存邮箱').click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(boxes.get(configuration.id).autoBusinessReplies, true);
  await button('配置').click();
  assert.equal(await mode.inputValue(), 'business');
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
  await page.locator('.inbox-sync-footer').getByRole('button', { name: '同步邮件' }).click();
  await page
    .getByRole('button', { name: /Track material/ })
    .first()
    .waitFor();
  await page.getByRole('button', { name: /^待审草稿/ }).click();
  await page.getByRole('button', { name: /Track material/ }).click({ timeout: 20_000 });
  await page.getByText('查看回复依据 · 2', { exact: true }).click();
  await page.getByText(/mail-specimen.xlsx.*规格!B2/).waitFor();
  await button('批准发送').click();
  await page.getByText('回复已被服务商接受。', { exact: true }).waitFor();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, peer);
  assert.equal(sent[0].inReplyTo, '<browser-1@dealer.test>');
  assert.match(sent[0].text, /For ZX-01, the material is Aluminium alloy/);
  await button('返回全部会话').click();
  await page.getByRole('button', { name: /Track material/ }).click();
  await button('联系人资料').click();
  await button('人工接管').click();
  await button('恢复邮箱接待').click();
  await button('人工接管').waitFor();
  await page.reload();
  await button('联系人资料').click();
  await button('人工接管').waitFor();
  assert.equal(crm.view().conversations[0].ownership, 'auto');
  assert.equal(crm.view().messages.length, 2);
  assert.equal(service.reception.list().total, 0);
  assert.deepEqual(pageErrors, []);
  console.log('PASS 待审列表、原信及来源、批准一次、CRM 实际消息、人工接管、恢复与刷新回读');
  // Historical mail in this isolated mailbox predates automatic reception.
  const subject = 'Historical product specification';
  service.conversations.putMessage(mailbox, {
    identity: 'assist-incoming',
    messageId: '<assist@dealer.test>',
    direction: 'inbound',
    from: peer,
    to: me,
    toAddresses: [me],
    subject,
    bodyText: 'What material is ZX-01 made of?',
    source: 'imap',
    deliveryStatus: 'received',
    occurredAt: '2025-01-12T09:00:00Z',
  });
  const thread = service.conversations.list({ mailboxId: mailbox.id, q: subject }).items[0];
  const source = service.conversations.messages(thread.id)[0];
  const threadUrl =
    base +
    '/inbox?' +
    new URLSearchParams({ tab: 'inbox', thread: thread.id, mailboxId: mailbox.id });
  await page.goto(threadUrl);
  const editor = label('回复正文'),
    assist = button('AI起草');
  await editor.waitFor();
  for (const viewport of [
    { width: 390, height: 667 },
    { width: 1440, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await assist.waitFor();
    assert.equal(await assist.innerText(), 'AI起草');
  }
  const draftMeta = page.locator('.inbox-draft-meta');
  assert.equal(await draftMeta.isVisible(), false);
  await editor.focus();
  assert.ok(await draftMeta.isVisible());
  const sentBeforeWriting = sent.length;
  const paragraphs = [
    '',
    'Thank you for sharing the preliminary drawings. I have listed the details we still need so we can prepare a room-by-room specification for your team.',
    '',
    'Sample review',
    'Please let us know which track finish and fabric samples you would like to see together. A photograph in daylight will also help us understand the existing interior.',
    '',
    'Drawings and installation',
    'Could you mark the mounting surface, the opening direction and the available clearance on each elevation? We will use those measurements when reviewing the layout with you.',
    '',
    'Schedule',
    'Please confirm the first room you would like us to review and the date your installer needs the drawings. We can then agree the order of the remaining rooms.',
    '',
    'Room checklist',
    ...[
      'Reception',
      'Meeting room',
      'Lounge',
      'Dining room',
      'Library',
      'Studio',
      'Guest room',
      'Conference suite',
      'East office',
      'West office',
      'Showroom',
      'Training room',
    ].flatMap((room) => [
      '',
      room,
      `Please mark the fixing points and finished height on the ${room.toLowerCase()} drawing.`,
      'Please note any access restrictions and the side from which the track will be serviced.',
    ]),
    '',
    'Kind regards,',
    'Jordan',
  ];
  for (const width of [1397, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 667 : 773 });
    const heading = width === 390 ? 'Hello Jordan,' : 'Hello Morgan,';
    await editor.fill([heading, ...paragraphs].join('\n'));
    const inline = await editor.evaluate((node) => {
      const shell = node.closest('.inbox-compose');
      const panel = node.closest('.mail-reply-panel');
      const actions = panel.querySelector('.mail-reply-actions').getBoundingClientRect();
      return {
        height: node.clientHeight,
        line: parseFloat(getComputedStyle(node).lineHeight),
        panelScroll: panel.scrollHeight - panel.clientHeight,
        shellScroll: shell.scrollHeight - shell.clientHeight,
        actionsVisible:
          actions.bottom <= window.innerHeight &&
          actions.bottom <= shell.getBoundingClientRect().bottom + 1,
      };
    });
    if (width > 390) assert.ok(inline.height >= inline.line * 9, JSON.stringify(inline));
    assert.ok(
      inline.actionsVisible && inline.shellScroll <= 2 && inline.panelScroll <= 2,
      '普通长草稿只需滚动正文，操作栏应一直可见：' + JSON.stringify(inline),
    );
    await editor.press('Control+End');
    await editor.press('ArrowLeft');
    const keepCaret = async () =>
      editor.evaluateHandle((node) => {
        const selection = window.getSelection();
        return { node, anchor: selection.anchorNode, offset: selection.anchorOffset };
      });
    const assertCaret = async (handle) => {
      assert.ok(
        await handle.evaluate(({ node, anchor, offset }) => {
          const selection = window.getSelection();
          return (
            document.activeElement === node &&
            node === document.querySelector('.mail-editor-content') &&
            selection.anchorNode === anchor &&
            selection.anchorOffset === offset
          );
        }),
        '展开或收起应保留同一编辑器及光标位置',
      );
      await handle.dispose();
    };
    const compactCaret = await keepCaret();
    await button('展开写信').click();
    await page.getByRole('dialog', { name: '展开写信', exact: true }).waitFor();
    await assertCaret(compactCaret);
    const geometry = await editor.evaluate((node) => ({
      height: node.clientHeight,
      content: node.scrollHeight,
      left: node.getBoundingClientRect().left,
      right: node.getBoundingClientRect().right,
    }));
    assert.ok(geometry.height >= 340 && geometry.content > geometry.height);
    assert.ok(geometry.left >= 0 && geometry.right <= width);
    await editor.press('Control+Home');
    assert.ok(await editor.evaluate((node) => node.scrollTop < node.clientHeight / 4));
    if (width === 1397) {
      await page
        .getByRole('dialog', { name: '展开写信' })
        .screenshot({ path: join(root, 'expanded-reply-preview.png') });
    }
    await page.keyboard.insertText('Revised: ');
    assert.ok((await editor.innerText()).startsWith('Revised: ' + heading));
    const expandedCaret = await keepCaret();
    if (width === 390) await editor.press('Escape');
    else await button('收起写信').click();
    await button('展开写信').waitFor();
    await assertCaret(expandedCaret);
    await page.getByText('草稿已保存', { exact: true }).waitFor();
    const saved = service.replies.draft(thread.id).bodyText;
    assert.ok(saved.startsWith('Revised: ' + heading));
    for (const line of paragraphs) assert.ok(saved.includes(line));
  }
  await button('内部备注').click();
  await label('内部备注正文').waitFor();
  assert.ok(await editor.isHidden());
  await button('回复客户').click();
  assert.match(await editor.innerText(), /^Revised: Hello Jordan,/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await editor.waitFor();
  assert.match(await editor.innerText(), /^Revised: Hello Jordan,/);
  assert.equal(sent.length, sentBeforeWriting);
  console.log('PASS 长回复展开编辑、回首行修改、收起和 Esc 保留光标，桌面与手机全文保存且未发信');
  const manual = 'We are reviewing your request.';
  await editor.fill(manual);
  assert.ok(await assist.isDisabled());
  await page.getByText('草稿已保存', { exact: true }).waitFor();
  assert.match(service.replies.draft(thread.id).bodyText, /We are reviewing your request/);
  await button('丢弃草稿').click();
  const competing = 'Draft from the second browser.';
  await page.waitForFunction(() => !document.querySelector('.inbox-draft-assist')?.disabled);
  service.replies.saveDraft(thread.id, {
    replyToMessageId: source.id,
    bodyText: competing,
    bodyHtml: competing,
    attachments: [],
  });
  await assist.click();
  await page.getByRole('alert').filter({ hasText: '已有草稿' }).waitFor();
  assert.equal(await editor.innerText(), competing);
  assert.equal(service.replies.draft(thread.id).bodyText, competing);
  assert.equal(modelCalls, 0);
  await button('丢弃草稿').click();
  const sentBefore = sent.length;
  await assist.click();
  await page.locator('.inbox-draft-assist[aria-busy="true"]').waitFor();
  assert.equal(await editor.isEditable(), false);
  finishModel();
  await page.getByText('AI草稿 · 待审核', { exact: true }).waitFor();
  assert.match(await editor.innerText(), /Aluminium alloy/);
  await page.getByText('查看回复依据 · 1', { exact: true }).click();
  await page.getByText(/mail-specimen.xlsx.*规格!B2/).waitFor();
  const composer = page.getByRole('region', { name: '回复邮件' });
  assert.doesNotMatch(await composer.innerText(), /DeepSeek/i);
  assert.equal(await composer.locator('[title*="deepseek" i]').count(), 0);
  const generated = service.replies.draft(thread.id);
  assert.equal(generated.replyToMessageId, source.id);
  assert.equal(generated.provenance.generator, 'model');
  assert.equal(generated.provenance.automatic, false);
  assert.equal(generated.provenance.sources[0].value, 'Aluminium alloy');
  await page.reload();
  await page.getByText('AI草稿 · 待审核', { exact: true }).waitFor();
  assert.match(await editor.innerText(), /Aluminium alloy/);
  assert.ok(await assist.isDisabled());
  assert.equal(modelCalls, 1);
  assert.equal(sent.length, sentBefore);
  assert.deepEqual(service.replies.operations(thread.id), []);
  assert.deepEqual(pageErrors, []);
  console.log(
    'PASS 桌面及手机端 AI起草仅生成待审核草稿，保护已有/并发草稿，模型替身按已选资料引用，刷新后保留且未新增发信',
  );
  service.conversations.putMessage(mailbox, {
    identity: 'intro-request',
    messageId: '<intro@dealer.test>',
    direction: 'inbound',
    from: peer,
    to: me,
    toAddresses: [me],
    subject: 'Purchasing introduction',
    bodyText: 'Please send an introduction I can forward to purchasing.',
    source: 'imap',
    deliveryStatus: 'received',
    occurredAt: '2025-02-12T09:00:00Z',
  });
  const introThread = service.conversations.list({
    mailboxId: mailbox.id,
    q: 'Purchasing introduction',
  }).items[0];
  await page.goto(
    base +
      '/inbox?' +
      new URLSearchParams({ tab: 'inbox', thread: introThread.id, mailboxId: mailbox.id }),
  );
  await assist.click();
  await page.getByText('AI草稿 · 待审核', { exact: true }).waitFor();
  assert.match(await editor.innerText(), /colleague responsible/);
  assert.deepEqual(service.replies.draft(introThread.id).provenance.sources, []);
  assert.equal(sent.length, sentBefore);
  assert.deepEqual(pageErrors, []);
  console.log('PASS 正式邮箱身份保存与重开、常规自动回复模式选择、无匹配资料起草完整采购转介邮件');
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
  finishModel();
  await browser?.close();
  await service.close();
  await new Promise((r) => app.close(r));
  crm.close();
  knowledge.close();
  await rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
