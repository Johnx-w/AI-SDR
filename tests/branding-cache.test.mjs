import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrandingCache } from '../server/branding-cache.mjs';
import { withApp } from './helpers/http.mjs';

const lead = { name: 'ShadeCo', website: 'https://shadeco.com/products' };
const logo = { url: 'https://shadeco.com/logo.svg', kind: 'logo' };
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><path fill="#123456" d="M0 0h240v80H0z"/></svg>',
);

test('网站图标仅短暂缓存，官网恢复后自动升级为品牌Logo', async (t) => {
  const path = await fixture(t);
  let time = 1000;
  let reads = 0;
  const cache = new BrandingCache({
    path,
    now: () => time,
    ttlMs: 10000,
    retryMs: 100,
    discover: async () => ({
      candidates: [{ ...logo, kind: ++reads === 1 ? 'website_icon' : 'logo' }],
    }),
    readImage: async () => ({ body: svg }),
  });
  assert.equal((await cache.get(lead)).candidates[0].kind, 'website_icon');
  time += 101;
  await cache.get(lead);
  await Promise.all([...cache.pending.values()]);
  assert.equal(reads, 2);
  assert.equal((await cache.get(lead)).candidates[0].kind, 'logo');
});

test('旧版七天图标缓存立即后台重试，已有高清Logo仍复用', async (t) => {
  const path = await fixture(t);
  let reads = 0;
  const options = {
    path,
    discover: async () => ({
      candidates: [{ ...logo, kind: ++reads === 1 ? 'website_icon' : 'logo' }],
    }),
    readImage: async () => ({ body: svg }),
  };
  await new BrandingCache(options).get(lead);
  const key = createHash('sha256').update('shadeco.com').digest('hex');
  const filename = join(path, key + '.json');
  const legacy = JSON.parse(await readFile(filename, 'utf8'));
  delete legacy.checkedAt;
  await writeFile(filename, JSON.stringify(legacy));
  const restarted = new BrandingCache(options);
  assert.equal((await restarted.get(lead)).candidates[0].kind, 'website_icon');
  await Promise.all([...restarted.pending.values()]);
  assert.equal((await restarted.get(lead)).candidates[0].kind, 'logo');
  assert.equal(reads, 2);
  await new BrandingCache(options).get(lead);
  assert.equal(reads, 2);
});
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'shadeflow-branding-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('同时打开列表和详情只抓一次，图片本地保存后跨服务重启不访问官网', async (t) => {
  const path = await fixture(t);
  let pages = 0,
    images = 0;
  const options = {
    path,
    discover: async () => {
      pages++;
      return { candidates: [logo] };
    },
    readImage: async () => {
      images++;
      return { body: svg };
    },
  };
  const cache = new BrandingCache(options);
  const results = await Promise.all(Array.from({ length: 8 }, () => cache.get(lead)));
  assert.equal(pages, 1);
  assert.equal(images, 1);
  assert.ok(results.every((r) => r.candidates[0].url.startsWith('/api/v1/branding/assets/')));
  const restarted = new BrandingCache(options);
  assert.deepEqual(await restarted.get(lead), results[0]);
  assert.equal(pages, 1);
  assert.equal(images, 1);
  const hash = results[0].candidates[0].url.split('/').at(-1);
  assert.deepEqual((await restarted.asset(hash)).body, svg);
  await unlink(join(path, hash + '.bin'));
  await restarted.get(lead);
  assert.equal(images, 2, '丢失的缓存文件会自动修复');
});

test('过期图片立即显示，官网失败保留旧图并延后重试', async (t) => {
  const path = await fixture(t);
  let time = 1000,
    pages = 0,
    finish;
  const cache = new BrandingCache({
    path,
    now: () => time,
    ttlMs: 100,
    retryMs: 50,
    discover: async () => {
      if (++pages > 1)
        return new Promise((resolve) => {
          finish = () => resolve({ candidates: [] });
        });
      return { candidates: [logo] };
    },
    readImage: async () => ({ body: svg }),
  });
  const first = await cache.get(lead);
  time += 101;
  assert.deepEqual(await cache.get(lead), first);
  assert.deepEqual(await cache.get(lead), first);
  assert.equal(pages, 2);
  const refresh = [...cache.pending.values()];
  finish();
  await Promise.all(refresh);
  assert.deepEqual(await cache.get(lead), first);
  assert.equal(pages, 2);
});

test('图片失败负缓存，缺失官网不共享其他企业的Logo，不保存HTML假图片', async (t) => {
  const path = await fixture(t);
  let reads = 0;
  const cache = new BrandingCache({
    path,
    discover: async () => {
      reads++;
      return { candidates: [logo] };
    },
    readImage: async () => ({ body: Buffer.from('<!doctype html><h1>Error</h1>') }),
  });
  assert.deepEqual(await cache.get(lead), { candidates: [] });
  assert.deepEqual(await cache.get(lead), { candidates: [] });
  assert.equal(reads, 1);
  assert.deepEqual(await cache.get({ name: 'Other' }), { candidates: [] });
  assert.equal(reads, 1);
});

test('候选Logo下载失败会继续高清备选，白色Logo保留暗背景，成功Logo不再请求图标', async (t) => {
  const path = await fixture(t);
  const calls = [];
  const cache = new BrandingCache({
    path,
    discover: async () => ({
      candidates: [
        logo,
        { ...logo, url: 'https://shadeco.com/logo-white.svg' },
        { url: 'https://shadeco.com/favicon.ico', kind: 'website_icon' },
      ],
    }),
    readImage: async (url) => {
      calls.push(url.href);
      if (url.href === logo.url) throw new Error('403');
      return { body: svg };
    },
  });
  const result = await cache.get(lead);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].background, 'dark');
  assert.equal(
    calls.some((url) => url.includes('favicon')),
    false,
  );
});

test('大量客户首次加载时限制并发抓取，候选请求仍按域名合并', async (t) => {
  const path = await fixture(t);
  let active = 0,
    peak = 0;
  let releaseFirst, enteredTwo;
  const gate = new Promise((resolve) => (releaseFirst = resolve));
  const firstWave = new Promise((resolve) => (enteredTwo = resolve));
  const cache = new BrandingCache({
    path,
    concurrency: 2,
    discover: async () => {
      peak = Math.max(peak, ++active);
      if (active === 2) enteredTwo();
      await gate;
      active--;
      return { candidates: [] };
    },
  });
  const loading = Promise.all(
    Array.from({ length: 10 }, (_, i) => cache.get({ website: `https://company${i}.com` })),
  );
  await firstWave;
  releaseFirst();
  await loading;
  assert.equal(peak, 2);
  assert.equal(cache.active, 0);
});

test('同源图片接口提供长期缓存、ETag和HEAD，重启后仍可读，不接受任意路径', async (t) => {
  const path = await fixture(t);
  const seeded = await new BrandingCache({
    path,
    discover: async () => ({ candidates: [logo] }),
    readImage: async () => ({ body: svg }),
  }).get(lead);
  const url = seeded.candidates[0].url;
  await withApp({ env: { BRANDING_CACHE_PATH: path } }, async (base) => {
    const response = await fetch(base + url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.match(response.headers.get('cache-control'), /immutable/);
    assert.match(response.headers.get('content-security-policy'), /sandbox/);
    assert.match(response.headers.get('content-security-policy'), /img-src data:/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), svg);
    const head = await fetch(base + url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(
      (await fetch(base + url, { headers: { 'If-None-Match': response.headers.get('etag') } }))
        .status,
      304,
    );
    assert.equal((await fetch(base + '/api/v1/branding/assets/' + '0'.repeat(64))).status, 404);
  });
});

test('客户品牌入口贯通官网发现、本地图片和重复请求缓存，不再返回外站图片地址', async (t) => {
  const path = await fixture(t);
  let pages = 0;
  await withApp(
    {
      env: {
        BRANDING_CACHE_PATH: path,
        N8N_BASE_URL: 'https://workspace.example.org',
        FEISHU_READ_WEBHOOK_URL: 'https://workspace.example.org/webhook/read-customers',
        N8N_WEBHOOK_SECRET: 'branding-test-only',
      },
      fetchImpl: async () =>
        Response.json({
          code: 0,
          data: {
            items: [
              {
                record_id: 'rec_brand',
                fields: { 公司名称: lead.name, 企业官网: lead.website },
              },
            ],
            has_more: false,
          },
        }),
      brandingOptions: {
        discover: async () => {
          pages++;
          return { candidates: [logo] };
        },
        readImage: async () => ({ body: svg }),
      },
    },
    async (base) => {
      const request = () =>
        fetch(base + '/api/v1/leads/real/rec_brand/branding').then((r) => r.json());
      const [first, second] = await Promise.all([request(), request()]);
      assert.deepEqual(first, second);
      assert.equal(pages, 1);
      assert.match(first.candidates[0].url, /^\/api\/v1\/branding\/assets\/[a-f0-9]{64}$/);
      const image = await fetch(base + first.candidates[0].url);
      assert.equal(image.status, 200);
      assert.deepEqual(Buffer.from(await image.arrayBuffer()), svg);
    },
  );
});
