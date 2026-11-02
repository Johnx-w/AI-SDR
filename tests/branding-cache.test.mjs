import { withFeishuAuth } from './helpers/feishu.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrandingCache } from '../server/branding-cache.mjs';
import { DatabaseSync } from 'node:sqlite';
import { withApp } from './helpers/http.mjs';

const lead = { name: 'ShadeCo', website: 'https://shadeco.com/products' };
const logo = { url: 'https://shadeco.com/logo.svg', kind: 'logo' };
const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><path fill="#123456" d="M0 0h240v80H0z"/></svg>',
);
const stores = new Map();
function openCache(options) {
  const cache = new BrandingCache(options);
  stores.get(options.path).push(cache);
  return cache;
}

test('成功Logo的图片和官网关系持久入库，跨年重启且官网离线也不重新抓取', async (t) => {
  const path = await fixture(t);
  let time = 1000;
  let reads = 0;
  const cache = openCache({
    path,
    now: () => time,
    discover: async () => {
      reads++;
      return { candidates: [logo] };
    },
    readImage: async () => ({ body: svg }),
  });
  const first = await cache.get(lead);
  await cache.close();
  const db = new DatabaseSync(join(path, 'branding.sqlite'), { readOnly: true });
  const row = db.prepare('SELECT body FROM branding_assets').get();
  assert.deepEqual(Buffer.from(row.body), svg);
  assert.equal(db.prepare('SELECT count(*) AS total FROM branding_sites').get().total, 1);
  db.close();
  time += 366 * 86400000;
  const restarted = openCache({
    path,
    now: () => time,
    discover: async () => {
      reads++;
      throw new Error('offline');
    },
  });
  assert.deepEqual(await restarted.get(lead), first);
  await Promise.all([...restarted.pending.values()]);
  assert.equal(reads, 1);
  const hash = first.candidates[0].url.split('/').at(-1);
  assert.deepEqual((await restarted.asset(hash)).body, svg);
});

test('过期的旧Logo自动导入数据库，删除原缓存后重启仍能读取，损坏图片和旧失败记录不导入', async (t) => {
  const path = await fixture(t);
  const key = createHash('sha256').update('shadeco.com').digest('hex');
  const hash = createHash('sha256').update(svg).digest('hex');
  const mark = { url: '/api/v1/branding/assets/' + hash, kind: 'logo', background: 'dark' };
  const badHash = '0'.repeat(64);
  const emptyKey = createHash('sha256').update('other.com').digest('hex');
  const filename = join(path, key + '.json');
  await writeFile(join(path, hash + '.bin'), svg);
  await writeFile(join(path, badHash + '.bin'), Buffer.from('<html>not an image</html>'));
  await writeFile(
    filename,
    JSON.stringify({
      version: 1,
      candidates: [mark, { ...mark, url: '/api/v1/branding/assets/' + badHash }],
      checkedAt: 1,
      expires: 2,
    }),
  );
  await writeFile(
    join(path, emptyKey + '.json'),
    JSON.stringify({
      version: 1,
      candidates: [],
      expires: Date.now() + 86400000,
    }),
  );
  let reads = 0;
  const options = {
    path,
    discover: () => {
      reads++;
      throw new Error('offline');
    },
  };
  const cache = openCache(options);
  assert.deepEqual(await cache.get(lead), { candidates: [mark] });
  assert.equal(cache.db.prepare('SELECT count(*) AS total FROM branding_assets').get().total, 1);
  assert.equal(cache.db.prepare('SELECT count(*) AS total FROM branding_sites').get().total, 1);
  await unlink(filename);
  await unlink(join(path, hash + '.bin'));
  await cache.close();
  const restarted = openCache(options);
  assert.deepEqual(await restarted.get(lead), { candidates: [mark] });
  await Promise.all([...restarted.pending.values()]);
  assert.equal(reads, 0);
  assert.deepEqual((await restarted.asset(hash)).body, svg);
});

test('网站图标仅短暂缓存，官网恢复后自动升级为品牌Logo', async (t) => {
  const path = await fixture(t);
  let time = 1000;
  let reads = 0;
  const cache = openCache({
    path,
    now: () => time,
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

test('旧版七天图标导入数据库后立即后台重试，升级为Logo后持久复用', async (t) => {
  const path = await fixture(t);
  let reads = 0;
  const options = {
    path,
    discover: async () => ({
      candidates: [{ ...logo, kind: ++reads === 1 ? 'website_icon' : 'logo' }],
    }),
    readImage: async () => ({ body: svg }),
  };
  const key = createHash('sha256').update('shadeco.com').digest('hex');
  const filename = join(path, key + '.json');
  const hash = createHash('sha256').update(svg).digest('hex');
  await writeFile(join(path, hash + '.bin'), svg);
  await writeFile(
    filename,
    JSON.stringify({
      version: 1,
      candidates: [{ url: '/api/v1/branding/assets/' + hash, kind: 'website_icon' }],
      expires: Date.now() + 7 * 86400000,
    }),
  );
  const restarted = openCache({
    ...options,
    discover: async () => {
      reads++;
      return { candidates: [logo] };
    },
  });
  assert.equal((await restarted.get(lead)).candidates[0].kind, 'website_icon');
  await Promise.all([...restarted.pending.values()]);
  assert.equal((await restarted.get(lead)).candidates[0].kind, 'logo');
  assert.equal(reads, 1);
  await openCache(options).get(lead);
  assert.equal(reads, 1);
});
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'shadeflow-branding-'));
  stores.set(path, []);
  t.after(async () => {
    for (const cache of stores.get(path)) await cache.close();
    stores.delete(path);
    await rm(path, { recursive: true, force: true });
  });
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
  const cache = openCache(options);
  const results = await Promise.all(Array.from({ length: 8 }, () => cache.get(lead)));
  assert.equal(pages, 1);
  assert.equal(images, 1);
  assert.ok(results.every((r) => r.candidates[0].url.startsWith('/api/v1/branding/assets/')));
  const restarted = openCache(options);
  assert.deepEqual(await restarted.get(lead), results[0]);
  assert.equal(pages, 1);
  assert.equal(images, 1);
  const hash = results[0].candidates[0].url.split('/').at(-1);
  assert.deepEqual((await restarted.asset(hash)).body, svg);
  restarted.db.prepare('DELETE FROM branding_assets WHERE hash=?').run(hash);
  await restarted.get(lead);
  assert.equal(images, 2, '丢失的数据库图片会自动修复');
  restarted.db
    .prepare('UPDATE branding_assets SET body=? WHERE hash=?')
    .run(Buffer.from('bad'), hash);
  await restarted.get(lead);
  assert.equal(images, 3, '损坏的数据库图片会自动修复');
});

test('图标升级时立即显示已有图片，官网失败仍保留旧图并延后重试', async (t) => {
  const path = await fixture(t);
  let time = 1000,
    pages = 0,
    finish;
  const cache = openCache({
    path,
    now: () => time,
    retryMs: 50,
    discover: async () => {
      if (++pages > 1)
        return new Promise((resolve) => {
          finish = () => resolve({ candidates: [] });
        });
      return { candidates: [{ ...logo, kind: 'website_icon' }] };
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
  const cache = openCache({
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
  const cache = openCache({
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
  const cache = openCache({
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
  const seeded = await openCache({
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
        FEISHU_APP_ID: 'fixture-app',
        FEISHU_TABLE_ID: 'fixture-table',
        FEISHU_APP_SECRET: 'fixture-secret',
        FEISHU_APP_TOKEN: 'fixture-base',
      },
      fetchImpl: withFeishuAuth(async () =>
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
      ),
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
