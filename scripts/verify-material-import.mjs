import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createApp } from '../server/app.mjs';

// Generate the three local files first with make-material-workbooks.py.
const dir = resolve(process.argv[2] || '.codex-tmp/material-size-qa');
const v1 = join(dir, 'catalog-v1.xlsx'),
  v2 = join(dir, 'catalog-v2.xlsx'),
  over = join(dir, 'catalog-over.xlsx');
assert.deepEqual(
  [v1, v2, over].map((p) => statSync(p).size),
  [52428800, 52428800, 52428801],
);
const scratch = resolve('.codex-tmp');
mkdirSync(scratch, { recursive: true });
const database = mkdtempSync(join(scratch, 'browser-'));
const proxy = process.env.MATERIAL_QA_PROXY;
if (proxy) assert.equal(new URL(proxy).hostname, '127.0.0.1');
const env = {
  BATCH_DB_PATH: join(database, 'materials.sqlite'),
  OUTREACH_DATA_DIR: join(database, 'outreach'),
  CONNECTIONS_PATH: join(database, 'connections.json'),
  PUBLIC_ORIGIN: proxy,
};
const app = createApp({
  env,
  outreachServiceFactory: () => ({ mailboxes: { list: () => [] }, close() {} }),
  fetchImpl: async () => {
    throw Error('离线素材验收');
  },
});
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
let browser;
try {
  await new Promise((ok, fail) =>
    app.once('error', fail).listen(Number(process.env.MATERIAL_QA_PORT || 0), '127.0.0.1', ok),
  );
  env.PORT = String(app.address().port);
  const base = proxy || 'http://127.0.0.1:' + env.PORT;
  const executablePath = [
    process.env.MAIL_BROWSER_PATH,
    String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
    String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find((p) => p && existsSync(p));
  browser = await chromium.launch({ executablePath });
  const page = await browser.newPage(
    proxy
      ? {
          ignoreHTTPSErrors: true,
          httpCredentials: {
            username: process.env.MATERIAL_QA_USER,
            password: process.env.MATERIAL_QA_PASSWORD,
          },
        }
      : {},
  );
  const dialog = page.getByRole('region', { name: '素材详情' });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const preview = (name) => button('预览 ' + name).click();
  const close = () => button('返回素材库').click();
  async function choose(name, path) {
    if (name === '选择文件上传') await button('新建 / 导入').click();
    const chooser = page.waitForEvent('filechooser');
    await button(name).click();
    await (await chooser).setFiles(path);
  }
  async function verify(path, cell) {
    await page.reload();
    await dialog.getByText('2 · ZX-01', { exact: true }).click();
    assert.equal(await dialog.getByLabel('规格!B2').inputValue(), cell);
    await dialog.getByRole('button', { name: '下一页' }).click();
    await dialog.getByText('17 · ZX-16', { exact: true }).click();
    assert.equal(await dialog.getByLabel('规格!B17').inputValue(), 'Aluminium');
    assert.ok(await dialog.getByLabel('规格!B17').isVisible());
    const download = await dialog.getByRole('link', { name: '下载原件' }).getAttribute('href');
    const original = await page.request.get(new URL(download, base).href);
    assert.equal(original.status(), 200);
    assert.equal(digest(await original.body()), digest(readFileSync(path)));
    await original.dispose();
  }
  await page.goto(base + '/materials');
  await choose('选择文件上传', v1);
  await preview('catalog-v1');
  await verify(v1, 'Aluminium');
  await close();

  // The browser reads the actual file from disk for its native drag/drop event.
  const cdp = await page.context().newCDPSession(page);
  const area = page.getByRole('region', { name: '素材库' });
  await area.scrollIntoViewIfNeeded();
  const drop = await area.boundingBox();
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', {
      type,
      x: drop.x + 20,
      y: drop.y + 20,
      data: { items: [], files: [v2], dragOperationsMask: 1 },
    });
  }
  await preview('catalog-v2');
  await verify(v2, 'Stainless steel');
  await close();
  await choose('选择文件上传', over);
  await page
    .getByRole('status')
    .filter({ hasText: '1 份失败' })
    .filter({ hasText: '50 MiB' })
    .waitFor();
  assert.equal(await button('预览 catalog-over').count(), 0);

  await preview('catalog-v1');
  await choose('上传新版本', v2);
  await dialog.getByText('已保存新版本', { exact: true }).waitFor();
  await verify(v2, 'Stainless steel');
  await choose('上传新版本', over);
  await dialog.getByRole('alert').filter({ hasText: '50 MiB' }).waitFor();
  await verify(v2, 'Stainless steel');
  await dialog.getByRole('button', { name: '历史版本' }).click();
  const versions = dialog.getByRole('combobox');
  assert.deepEqual(
    await versions.locator('option').evaluateAll((options) => options.map((o) => o.value)),
    ['2', '1'],
  );
  await versions.selectOption('1');
  await button('查看所选版本原件').click();
  await dialog.getByText('2 · ZX-01', { exact: true }).click();
  assert.equal(await dialog.getByLabel('规格!B2').inputValue(), 'Aluminium');
  console.log(
    'PASS 选择、拖入和换版各 52,428,800 字节。刷新后验明 B2、第二页 B17 和整份原件 SHA-256。超限 1 字节保留 v2，历史 v1 可读。',
  );
  await close();
  const pdf = join(database, 'catalog-page.pdf');
  const source = await browser.newPage();
  await source.setContent('<p>Catalog ZX-16: 20 mm</p>');
  await source.pdf({ path: pdf });
  await source.close();
  await choose('选择文件上传', pdf);
  await preview('catalog-page');
  const download = await dialog.getByRole('link', { name: '下载原件' }).getAttribute('href');
  const original = await page.request.get(new URL(download, base).href);
  assert.ok((await original.body()).equals(readFileSync(pdf)));
  const waitForReader = async (tab) => {
    const isReader = (frame) =>
      frame.url().startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/');
    if (!tab.frames().some(isReader)) await tab.waitForEvent('framenavigated', isReader);
  };
  await button('查看原文').click();
  if (original.headers()['x-frame-options'] === 'DENY') {
    const open = page.waitForEvent('popup');
    await dialog.getByRole('link', { name: '在新窗口查看 PDF 原件' }).click();
    const popup = await open;
    await waitForReader(popup);
    await popup.close();
  } else {
    await dialog.locator('iframe').waitFor();
    await waitForReader(page);
  }
  console.log('PASS Chrome 阅读器打开完整 PDF，回读字节与原件一致。');
  await close();
  const fileName = 'catalog-page';
  await page.getByRole('checkbox', { name: '选择 ' + fileName, exact: true }).check();
  page.once('dialog', (prompt) => prompt.accept());
  await button('停用').click();
  await button('预览 ' + fileName).waitFor({ state: 'hidden' });
  await page.goto(base + '/materials?status=archived');
  const enabled = page.getByRole('switch', { name: '启用 ' + fileName, exact: true });
  await enabled.waitFor();
  assert.equal(await enabled.getAttribute('aria-checked'), 'false');
  await enabled.click();
  await enabled.waitFor({ state: 'hidden' });
  await page.goto(base + '/materials?status=draft');
  await preview(fileName);
  await dialog.getByRole('button', { name: '审核通过' }).waitFor();
  console.log('PASS 在集合表停用文件、筛选停用记录并重新启用，恢复后需要审核。');
} finally {
  await browser?.close();
  if (app.listening) await new Promise((ok) => app.close(ok));
  rmSync(database, { recursive: true, force: true });
}
