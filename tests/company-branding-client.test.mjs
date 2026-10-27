import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/modules.mjs';

const { CompanyBrandingClient, logoContentBounds, prefersDarkLogoBackground } = loadModule(
  new URL('../src/services/companyBranding.ts', import.meta.url),
);
const marks = [{ url: '/api/v1/branding/assets/abc123', kind: 'logo', background: 'dark' }];
const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
};

test('透明白色标志使用深色底，透明空图、黑色和彩色标志及不透明白底图保持原样', () => {
  const pixels = (...colors) => new Uint8ClampedArray(colors.flat());
  const repeat = (color, count) => Array.from({ length: count }, () => color);
  const transparent = repeat([0, 0, 0, 0], 20);
  assert.equal(
    prefersDarkLogoBackground(pixels(...transparent, ...repeat([255, 255, 255, 255], 12))),
    true,
  );
  assert.equal(
    prefersDarkLogoBackground(pixels(...transparent, ...repeat([240, 240, 240, 150], 12))),
    true,
  );
  assert.equal(prefersDarkLogoBackground(pixels(...transparent)), false);
  assert.equal(
    prefersDarkLogoBackground(pixels(...transparent, ...repeat([0, 0, 0, 255], 12))),
    false,
  );
  assert.equal(
    prefersDarkLogoBackground(pixels(...transparent, ...repeat([245, 180, 60, 255], 12))),
    false,
  );
  assert.equal(
    prefersDarkLogoBackground(
      pixels(...repeat([255, 255, 255, 255], 30), ...repeat([0, 0, 0, 255], 2)),
    ),
    false,
  );
  assert.equal(
    prefersDarkLogoBackground(pixels(...transparent, ...repeat([255, 255, 255, 1], 12))),
    false,
  );
  assert.equal(
    prefersDarkLogoBackground(pixels(...transparent, ...repeat([255, 255, 255, 255], 2))),
    false,
  );
  assert.equal(
    prefersDarkLogoBackground(
      pixels(...transparent, ...repeat([255, 255, 255, 255], 9), [0, 0, 0, 255]),
    ),
    false,
  );
  assert.equal(
    prefersDarkLogoBackground(
      pixels(...transparent, ...repeat([255, 255, 255, 255], 5), ...repeat([0, 165, 170, 255], 7)),
    ),
    true,
  );
  assert.equal(
    prefersDarkLogoBackground(pixels(...transparent, ...repeat([0, 165, 170, 255], 12))),
    false,
  );
  assert.equal(
    prefersDarkLogoBackground(
      pixels(...transparent, ...repeat([255, 255, 255, 255], 5), ...repeat([30, 30, 30, 255], 7)),
    ),
    false,
  );
});

test('只裁掉大块透明边距，普通品牌内边距与全透明图片保持原样', () => {
  const paint = (start, end) => {
    const pixels = new Uint8ClampedArray(100 * 100 * 4);
    for (let y = start; y < end; y++)
      for (let x = start; x < end; x++) pixels.set([255, 255, 255, 255], (y * 100 + x) * 4);
    return pixels;
  };
  assert.deepEqual(logoContentBounds(paint(40, 60), 100, 100), {
    x: 39,
    y: 39,
    width: 22,
    height: 22,
  });
  assert.equal(logoContentBounds(paint(10, 90), 100, 100), null);
  assert.equal(logoContentBounds(new Uint8ClampedArray(100 * 100 * 4), 100, 100), null);
});

test('列表和档案同时读取合并请求，刷新页面后的五分钟内复用同源图片候选', async () => {
  const session = storage();
  let reads = 0;
  let finish;
  const fetcher = () => {
    reads++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  const client = new CompanyBrandingClient(
    fetcher,
    () => session,
    () => 1000,
  );
  const first = client.load('customer-1', 'https://shadeflow.com/');
  const second = client.load('customer-1', 'https://shadeflow.com/');
  assert.equal(first, second);
  assert.equal(reads, 1);
  finish(Response.json({ candidates: marks }));
  assert.deepEqual(await first, marks);
  assert.deepEqual(await second, marks);
  const reloaded = new CompanyBrandingClient(
    fetcher,
    () => session,
    () => 2000,
  );
  assert.deepEqual(reloaded.cached('customer-1', 'https://shadeflow.com/'), marks);
  assert.deepEqual(await reloaded.load('customer-1', 'https://shadeflow.com/'), marks);
  assert.equal(reads, 1);
});

test('缓存过期仍立即提供旧图，同时重取以呈现后台升级的新 Logo', async () => {
  const session = storage();
  let time = 0;
  let reads = 0;
  const updated = [{ ...marks[0], url: '/api/v1/branding/assets/better-logo' }];
  const fetcher = async () => Response.json({ candidates: reads++ ? updated : marks });
  const first = new CompanyBrandingClient(
    fetcher,
    () => session,
    () => time,
  );
  await first.load('customer-1');
  time = 5 * 60 * 1000 + 1;
  const reopened = new CompanyBrandingClient(
    fetcher,
    () => session,
    () => time,
  );
  assert.deepEqual(reopened.cached('customer-1'), marks);
  assert.deepEqual(await reopened.load('customer-1'), updated);
  assert.equal(reads, 2);
});

test('瞬时读取故障保留已有图片，短暂合并失败后允许重试', async () => {
  let time = 0;
  let reads = 0;
  const client = new CompanyBrandingClient(
    async () => {
      if (++reads > 1) throw new Error('offline');
      return Response.json({ candidates: marks });
    },
    () => undefined,
    () => time,
  );
  await client.load('customer-1');
  time += 5 * 60 * 1000;
  assert.deepEqual(await client.load('customer-1'), marks);
  assert.deepEqual(await client.load('customer-1'), marks);
  assert.equal(reads, 2);
  time += 30001;
  await client.load('customer-1');
  assert.equal(reads, 3);
});

test('同编号客户更换官网后不会复用另一家企业的 Logo', async () => {
  let reads = 0;
  const client = new CompanyBrandingClient(
    async () => {
      reads++;
      return Response.json({ candidates: marks });
    },
    () => undefined,
  );
  await client.load('customer-1', 'https://one.com/');
  assert.deepEqual(client.cached('customer-1', 'https://two.com/'), []);
  await client.load('customer-1', 'https://two.com/');
  assert.equal(reads, 2);
});

test('会话存储禁用或损坏不阻断加载，远程候选不写入持久缓存', async () => {
  for (const session of [
    {
      getItem() {
        throw new Error('denied');
      },
      setItem() {
        throw new Error('denied');
      },
    },
    { getItem: () => '{invalid', setItem() {} },
  ]) {
    const client = new CompanyBrandingClient(
      async () => Response.json({ candidates: marks }),
      () => session,
    );
    assert.deepEqual(await client.load('customer-1'), marks);
  }
  const session = storage();
  const client = new CompanyBrandingClient(
    async () =>
      Response.json({ candidates: [{ kind: 'logo', url: 'https://shadeflow.com/logo.svg' }] }),
    () => session,
  );
  await client.load('customer-1');
  const reloaded = new CompanyBrandingClient(
    async () => Response.json({ candidates: [] }),
    () => session,
  );
  assert.deepEqual(reloaded.cached('customer-1'), []);
});
