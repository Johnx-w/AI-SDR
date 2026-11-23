import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';

const env = {};
const app = createApp({ env });
await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
env.PORT = String(app.address().port);
const base = 'http://127.0.0.1:' + env.PORT;
const executablePath = [
  process.env.MAIL_BROWSER_PATH,
  String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
  String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].find((path) => path && existsSync(path));

async function checkCorners(page, surface) {
  const { x, y, width, height } = await surface.boundingBox();
  const bounds = await surface.evaluate((el) => ({
    gutter: el.offsetWidth - el.clientWidth,
    range: el.scrollHeight - el.clientHeight,
    radius: parseFloat(getComputedStyle(el).borderTopRightRadius),
  }));
  assert.ok(
    bounds.range > 0 && bounds.gutter > 4 && bounds.radius >= 6,
    '用真实的占位滚动条复现圆角问题',
  );
  // A computed radius also exists on the broken UI. Sample the painted corners against the adjacent backdrop.
  const { data, info } = await sharp(await page.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (cx, cy) => {
    const i = (Math.round(cy) * info.width + Math.round(cx)) * info.channels;
    return data.subarray(i, i + 3);
  };
  for (const ty of [y + 1, y + height - 2]) {
    for (const [tx, outside] of [
      [x + 1, x - 3],
      [x + width - 2, x + width + 2],
    ]) {
      const edge = pixel(tx, ty),
        backdrop = pixel(outside, ty);
      assert.ok(
        edge.every((channel, i) => Math.abs(channel - backdrop[i]) < 32),
        '滚动条盖住了弹窗外侧的圆角',
      );
    }
  }
}

let browser;
try {
  browser = await chromium.launch({
    executablePath,
    headless: true,
    ignoreDefaultArgs: ['--hide-scrollbars'],
    args: ['--disable-features=OverlayScrollbar,FluentOverlayScrollbar'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 620 } });
  const lead = {
    id: 'rounding-qa',
    name: 'Example Blinds',
    website: 'https://example.test',
    domain: 'example.test',
    product: 'Roller blinds',
    grade: 'A',
    score: 75,
    status: '已联系',
    type: 'retailer',
    mainProductPreference: '测试目录',
    assessment: { opportunities: [] },
    updatedAt: '2026-11-22T00:00:00Z',
  };
  await page.route('**/api/v1/leads/real/**', (route) =>
    route.fulfill({
      json: {
        scope: 'fixture',
        sync: { revision: 1, refreshing: false },
        lead,
        leads: [],
        total: 0,
        page: 1,
        pageSize: 20,
      },
    }),
  );
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 620 : 520 });
    await page.goto(base + '/leads?dataset=real&lead=rounding-qa');
    const profile = page.getByRole('dialog', { name: '客户档案' });
    await profile.getByText(lead.name, { exact: true }).first().waitFor();
    await checkCorners(page, profile);
    await profile.hover();
    await page.mouse.wheel(0, 900);
    await page.waitForFunction(() => document.querySelector('dialog:modal').scrollTop > 0);
    await checkCorners(page, profile);
    await page.keyboard.press('Escape');
    await profile.waitFor({ state: 'detached' });

    await page.setViewportSize({ width, height: 320 });
    await page.goto(base + '/materials');
    await page.getByRole('button', { name: '新建 / 导入' }).click();
    const importer = page.getByRole('dialog', { name: '导入本地文件' });
    await importer.getByRole('button', { name: '选择文件上传' }).waitFor();
    await checkCorners(page, importer);
    await importer.getByRole('button', { name: '关闭导入' }).click();
    await importer.waitFor({ state: 'detached' });
    console.log('PASS', width, 'px · 客户档案及素材导入弹窗四角、滚动与关闭');
  }
  // Stress the same raw-result component with both scrollbars; the bottom-right gutter is separate.
  const resultPane = await page.evaluateHandle(() => {
    const host = document.createElement('section');
    host.className = 'result-pane';
    Object.assign(host.style, {
      position: 'fixed',
      inset: '20px',
      zIndex: '100',
      padding: '18px',
      background: '#929aa8',
    });
    const pre = document.createElement('pre');
    pre.style.height = '120px';
    pre.style.whiteSpace = 'pre';
    pre.textContent = Array.from({ length: 50 }, () => '0123456789'.repeat(30)).join('\n');
    host.append(pre);
    document.body.append(host);
    return pre;
  });
  const raw = page.locator('.result-pane pre').last();
  await checkCorners(page, raw);
  const moved = await resultPane.evaluate((node) => {
    node.scrollTo(node.scrollWidth, node.scrollHeight);
    return node.scrollLeft > 0 && node.scrollTop > 0;
  });
  assert.ok(moved, '原始结果支持横向和纵向滚动');
  await checkCorners(page, raw);
  console.log('PASS 双向滚动的原始结果面板四角及右下交汇处');
} finally {
  await browser?.close();
  await new Promise((resolve) => app.close(resolve));
}
