import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { materialService } from '../tests/fixtures/deepseek-material-service.mjs';
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
const careText = 'Clean the slats with a dry microfiber cloth.';
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
  answerQuestion: (...args) => answerMailQuestion(knowledge, ...args),
  getDraftModel: () => ({
    name: 'browser-reception',
    generate: async (messages) => {
      const { evidence } = JSON.parse(messages[1].content);
      assert.deepEqual(
        evidence.slice(0, 2).map((s) => s.value),
        ['ZX-01', 'Aluminium alloy'],
      );
      return JSON.stringify({
        coverage: 'answered',
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
    if (
      String(url).endsWith('/tools/ocr') ||
      (String(url).endsWith('/chat/completions') &&
        Array.isArray(JSON.parse(init.body).messages?.[1]?.content))
    )
      return materialService(url, init);
    assert.equal(
      String(url),
      'https://api.deepseek.com/chat/completions',
      '本验收只允许本地模拟的起草请求',
    );
    const payload = JSON.parse(init.body);
    assert.match(payload.model, /deepseek/i);
    const data = JSON.parse(payload.messages.find((message) => message.role === 'user').content);
    if (data.incoming?.subject === 'Preview only') {
      const index = data.evidence.findIndex((s) => s.value === 'Aluminium alloy');
      assert.ok(index >= 0);
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                coverage: 'answered',
                body: 'The material is Aluminium alloy.',
                sourceIndexes: [index],
              }),
            },
          },
        ],
      });
    }
    modelCalls++;
    if (payload.messages[0].content.startsWith('Find terms')) {
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ words: ['fire rating', '防火等级'] }) },
          },
        ],
      });
    }
    assert.ok(payload.messages[0].content.includes(persona));
    assert.equal(data.website, 'honeybadgerblinds.com');
    if (data.incoming.subject === 'Purchasing introduction') {
      const content = JSON.stringify({
        coverage: 'correspondence',
        body: introduction,
        sourceIndexes: [],
      });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
    }
    if (['Care and rating', 'Rating only'].includes(data.incoming.subject)) {
      const index = data.evidence.findIndex((source) => source.value === careText);
      assert.ok(index >= 0);
      const mixed = data.incoming.subject === 'Care and rating';
      const content = JSON.stringify({
        coverage: mixed ? 'partial' : 'unanswered',
        body: mixed ? careText : '',
        sourceIndexes: mixed ? [index] : [],
      });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
    }
    if (data.incoming.subject === 'MX42 dimensions') {
      const index = data.evidence.findIndex((source) =>
        /MX42 track width is 73 mm/u.test(source.value),
      );
      assert.ok(index >= 0, '模型应收到扫描规格表的实际识别值');
      const content = JSON.stringify({
        coverage: 'partial',
        body: 'The MX42 track is 73 mm wide.',
        sourceIndexes: [index],
      });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content } }] });
    }
    const material = data.evidence.findIndex((source) => source.value === 'Aluminium alloy');
    assert.ok(material >= 0, '应使用已校对的已选资料');
    await modelGate;
    const content = JSON.stringify({
      coverage: 'answered',
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
  await page.getByLabel('筛选文件').click();
  await label('品牌邮箱筛选').selectOption('honeybadgerblinds.com');
  await page.getByLabel('筛选文件').click();
  const choosing = page.waitForEvent('filechooser');
  await button('新建 / 导入').click();
  await page.getByRole('button', { name: /选择文件上传/u }).click();
  await (await choosing).setFiles(resolve('tests/fixtures/mail-specimen.xlsx'));
  await button('预览 mail-specimen').click();
  const material = page.getByRole('region', { name: '素材详情' });
  await label('查找型号或主题').fill('ZX-01');
  await material.getByText('2 · ZX-01', { exact: true }).click();
  assert.equal(await label('规格!B2').inputValue(), 'Aluminium');
  await label('规格!B2').fill('Aluminium alloy');
  await label('审核人').fill('QA');
  await button('审核通过').click();
  await material.getByText('审核人 QA', { exact: true }).waitFor();
  await button('返回素材库').click();
  console.log('PASS 按邮箱官网上传工作簿、定位原单元格、校对与审核');
  const chooseCare = page.waitForEvent('filechooser');
  await button('新建 / 导入').click();
  await page.getByRole('button', { name: /选择文件上传/u }).click();
  await (
    await chooseCare
  ).setFiles({ name: 'care-note.txt', mimeType: 'text/plain', buffer: Buffer.from(careText) });
  await button('预览 care-note').click();
  await button('查看原文').click();
  const originalText = material.locator('.kb-raw-text');
  await originalText.filter({ hasText: careText }).waitFor();
  assert.equal(await originalText.textContent(), careText);
  await button('关闭原文').click();
  await button('采用片段').click();
  await label('审核人').fill('QA');
  await button('审核通过').click();
  await material.getByText('审核人 QA', { exact: true }).waitFor();
  await page.reload();
  await material.getByText('审核人 QA', { exact: true }).waitFor();
  assert.equal(knowledge.list().find((p) => p.name === 'care-note').sourceFacts[0].text, careText);
  await button('返回素材库').click();
  await page.getByLabel('筛选文件').click();
  await label('品牌邮箱筛选').selectOption('honeybadgerblinds.com');
  await page.getByLabel('筛选文件').click();
  const choosePdf = page.waitForEvent('filechooser');
  await button('新建 / 导入').click();
  await page.getByRole('button', { name: /选择文件上传/u }).click();
  await (await choosePdf).setFiles(resolve('tests/fixtures/material-mixed-catalog.pdf'));
  await button('预览 material-mixed-catalog').click();
  await material.getByText(/原件共 3 页/u).waitFor();
  const spec = material.locator('.kb-chunk').filter({ hasText: 'MX42 track width is 73 mm.' });
  const findChunk = material.getByRole('searchbox', { name: '搜索引用片段' });
  await findChunk.fill('unknown-qa-marker');
  await material.getByText('没有找到匹配的片段').waitFor();
  await findChunk.fill('第 2 页');
  await spec.getByRole('button', { name: /第 2 页/ }).click();
  await material.locator('iframe[src$="page=2"], a:not(.kb-enlarge)[href$="#page=2"]').waitFor();
  await spec.getByRole('button', { name: '编辑片段' }).click();
  const chunkEditor = page.getByRole('dialog', { name: '分块详情' });
  const edit = chunkEditor.getByRole('textbox', { name: '引用内容' });
  await edit.fill('Discard this edit');
  await chunkEditor.getByRole('button', { name: '取消', exact: true }).click();
  await spec.getByRole('button', { name: '编辑片段' }).click();
  assert.match(await edit.inputValue(), /MX42 track width is 73 mm/);
  await edit.fill('MX42 track width is 73 mm.');
  await chunkEditor.getByRole('button', { name: '保存并采用' }).click();
  await material.getByText('片段已保存并采用', { exact: true }).waitFor();
  await page.reload();
  await material.getByRole('button', { name: '已采用 · 1' }).click();
  assert.equal(await spec.locator('.kb-chunk-text').innerText(), 'MX42 track width is 73 mm.');
  await spec.getByRole('button', { name: '编辑片段' }).click();
  await edit.fill('MX42 track width is 73 mm. Checked against the printed table.');
  await chunkEditor.getByRole('button', { name: '保存修改' }).click();
  await material.getByText('片段修改已保存', { exact: true }).waitFor();
  await label('审核人').fill('QA');
  await button('审核通过').click();
  await material.getByText('审核人 QA', { exact: true }).waitFor();
  await button('返回素材库').click();

  await page.goto(base + '/inbox');
  await page.getByRole('link', { name: '自动回复设置', exact: true }).click();
  const mode = page.getByRole('combobox', { name: /接待方式/ });
  await page.locator('summary').filter({ hasText: '引用资料' }).click();
  await page.locator('summary').filter({ hasText: '身份与语气' }).click();
  assert.equal(await page.getByRole('checkbox', { name: /mail-specimen/ }).isChecked(), false);
  await page.getByRole('textbox', { name: /AI 起草身份与语气/ }).fill(persona);
  await button('保存设置').click();
  await page.getByText('设置已保存', { exact: true }).waitFor();
  await page.reload();
  await page.locator('summary').filter({ hasText: '身份与语气' }).click();
  assert.equal(
    await page.getByRole('textbox', { name: /AI 起草身份与语气/ }).inputValue(),
    persona,
  );
  await mode.selectOption('business');
  await button('保存设置').click();
  await page.getByText('设置已保存', { exact: true }).waitFor();
  assert.equal(boxes.get(configuration.id).autoBusinessReplies, true);
  await page.reload();
  assert.equal(await mode.inputValue(), 'business');
  await mode.selectOption('review');
  await page.locator('summary').filter({ hasText: '引用资料' }).click();
  await page.getByRole('checkbox', { name: /mail-specimen/ }).check();
  await page.getByRole('checkbox', { name: /care-note/ }).check();
  await page.getByRole('checkbox', { name: /material-mixed-catalog/ }).check();
  await button('保存设置').click();
  await page.getByText('设置已保存', { exact: true }).waitFor();
  const mailbox = boxes.list()[0];
  assert.deepEqual(mailbox.productIds, [saleProduct.id]);
  assert.deepEqual(mailbox.knowledgeProductIds.map((id) => knowledge.get(id).name).sort(), [
    'care-note',
    'mail-specimen',
    'material-mixed-catalog',
  ]);
  await button('试运行').click();
  await label('主题').fill('Preview only');
  await label('客户来信').fill('What material is ZX-01 made of?');
  await button('预览回复').click();
  await page.locator('.studio-mail').filter({ hasText: 'Aluminium alloy' }).waitFor();
  await page.getByText('需人工审核', { exact: true }).waitFor();
  await page.getByRole('link', { name: '邮箱管理', exact: true }).click();
  console.log('PASS 回复设置持久化、当前配置试写及审核提示');
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
  await page.getByRole('tab', { name: /^待审草稿/ }).click();
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
  for (const [key, subject, bodyText] of [
    ['care', 'Care and rating', 'How should I clean the slats? What is their fire rating?'],
    ['rating', 'Rating only', 'What is their fire rating?'],
    ['pdf', 'MX42 dimensions', 'How wide is the MX42 track? What is its fire rating?'],
  ]) {
    service.conversations.putMessage(mailbox, {
      identity: key,
      messageId: '<' + key + '@dealer.test>',
      direction: 'inbound',
      from: peer,
      to: me,
      toAddresses: [me],
      subject,
      bodyText,
      source: 'imap',
      deliveryStatus: 'received',
      occurredAt: '2025-02-13T09:00:00Z',
    });
    const convo = service.conversations.list({ mailboxId: mailbox.id, q: subject }).items[0];
    await page.goto(
      base +
        '/inbox?' +
        new URLSearchParams({ tab: 'inbox', thread: convo.id, mailboxId: mailbox.id }),
    );
    await assist.click();
    await page.getByText('AI草稿 · 待审核', { exact: true }).waitFor();
    await page.reload();
    await page.getByText('AI草稿 · 待审核', { exact: true }).waitFor();
    const body = await editor.innerText();
    assert.match(body, /with my manager/);
    const sources = service.replies.draft(convo.id).provenance.sources;
    if (key === 'care') {
      assert.ok(body.includes(careText));
      await page.getByText('查看回复依据 · 1', { exact: true }).click();
      await page.getByText(/care-note.txt.*第 1 段/).waitFor();
      assert.deepEqual(
        sources.map((s) => s.value),
        [careText],
      );
    } else if (key === 'pdf') {
      assert.match(body, /73 mm/);
      await page.getByText('查看回复依据 · 1', { exact: true }).click();
      await page.getByText(/material-mixed-catalog.pdf.*第 2 页/u).waitFor();
      const original = page.getByRole('link', { name: /material-mixed-catalog.pdf.*第 2 页/u });
      assert.ok((await original.getAttribute('href')).endsWith('#page=2'));
      const response = await page.request.get(
        new URL(await original.getAttribute('href'), base).href,
      );
      assert.equal(response.headers()['content-type'], 'application/pdf');
      assert.match(sources[0].value, /MX42 track width is 73 mm/u);
    } else assert.deepEqual(sources, []);
    assert.equal(sent.length, sentBefore);
  }
  console.log('PASS 直接审核采用的片段，刷新后混合问题引用原段并请示，未命中问题仅请示。');
  await page.goto(base + '/materials?tab=test');
  await page.getByLabel('检索范围').selectOption(configuration.id);
  await page.getByLabel('测试问题').fill('What material is ZX-01 made of?');
  await button('开始测试').click();
  await page.locator('.kb-hit').filter({ hasText: 'Aluminium alloy' }).first().waitFor();
  await page.getByLabel('测试问题').fill('What material is Shuangsheng ZX-01 made of?');
  await button('开始测试').click();
  await page.getByText('匹配片段 · 0').waitFor();
  await button('数据集').click();
  const nameColumn = page.getByRole('columnheader', { name: '集合名称' });
  await nameColumn.getByRole('button').click();
  await nameColumn.and(page.locator('[aria-sort="ascending"]')).waitFor();
  await page.getByRole('checkbox', { name: '选择 care-note', exact: true }).check();
  await page.getByText('已选择 1 项').waitFor();
  await button('取消选择').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await button('素材库信息').click();
  await button('关闭素材库信息').click();
  await button('预览 material-mixed-catalog').click();
  await button('文件信息').click();
  await button('关闭文件信息').click();
  await page.getByRole('searchbox', { name: '搜索引用片段' }).fill('第 2 页');
  await spec.getByRole('button', { name: '编辑片段' }).click();
  await chunkEditor.getByRole('button', { name: '对照原文' }).click();
  await chunkEditor.locator('iframe[src$="page=2"],a[href$="#page=2"]').first().waitFor();
  assert.ok(await chunkEditor.evaluate((e) => e.scrollWidth <= e.clientWidth + 1));
  await chunkEditor.getByRole('button', { name: '取消', exact: true }).click();
  console.log('PASS 素材库文件排序与选择、实际邮箱检索命中与隔离、手机分块编辑对照原页。');
  await button('展开栏目导航').click();
  await button('收起栏目导航').click();
  await button('返回素材库').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [module, view] of [
    ['获客任务', '定时计划'],
    ['跟进任务', '邮箱来信跟进'],
    ['素材库', '搜索测试'],
  ]) {
    await page.locator('.sidebar').getByRole('link', { name: module, exact: true }).click();
    const item = page
      .getByRole('navigation', { name: module + '栏目' })
      .getByRole('button', { name: view, exact: true });
    await item.click();
    await page.reload();
    await item.and(page.locator('[aria-current="page"]')).waitFor();
    assert.equal(
      await page.locator('.sidebar').evaluate((el) => el.getBoundingClientRect().width),
      58,
    );
  }
  console.log('PASS 共用主栏、模块栏目切换与刷新、资料校对收起和展开导航。');
  const settingsLink = page
    .locator('.sidebar')
    .getByRole('link', { name: 'API 连接', exact: true });
  await settingsLink.hover();
  await page.locator('.workspace-nav-hint').filter({ hasText: 'API 连接' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.workspace-nav-hint').waitFor({ state: 'detached' });
  await settingsLink.click();
  const apiNav = page.getByRole('navigation', { name: 'API 连接栏目' });
  await page.locator('#WEB_SEARCH_BASE_URL').fill('https://search.example.test');
  await apiNav.getByRole('button', { name: '飞书同步' }).click();
  await page.locator('#FEISHU_APP_ID').fill('test-navigation-only');
  await apiNav.getByRole('button', { name: '大语言模型 API' }).click();
  assert.equal(await page.locator('.connection-group').count(), 3);
  assert.equal(await page.locator('#FEISHU_APP_ID').count(), 0);
  await page.goBack();
  assert.equal(await page.locator('#FEISHU_APP_ID').inputValue(), 'test-navigation-only');
  await apiNav.getByRole('button', { name: '搜索 API' }).click();
  assert.equal(
    await page.locator('#WEB_SEARCH_BASE_URL').inputValue(),
    'https://search.example.test',
  );
  await apiNav.getByRole('button', { name: '大语言模型 API' }).click();
  await page.reload();
  await page.getByRole('heading', { name: '大语言模型 API', exact: true }).waitFor();
  await page.getByRole('heading', { name: '素材库 · 文档解析', exact: true }).waitFor();
  const parsingKey = page.getByLabel('文档解析 API Key', { exact: true });
  const clearParsingKey = page.getByLabel('清除 文档解析 API Key', { exact: true });
  await parsingKey.fill('synthetic-material-key');
  await button('保存全部修改').click();
  await clearParsingKey.waitFor();
  await page.reload();
  await clearParsingKey.waitFor();
  assert.equal(await parsingKey.inputValue(), 'synt********-key');
  await clearParsingKey.check();
  await button('保存全部修改').click();
  await clearParsingKey.waitFor({ state: 'detached' });
  await page.reload();
  await parsingKey.waitFor();
  assert.equal(await parsingKey.inputValue(), '');
  console.log('PASS 一级导航悬停提示、API 连接跨栏编辑、文档解析密钥保存与清除后刷新回读。');
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
