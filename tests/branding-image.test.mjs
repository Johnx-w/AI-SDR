import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  inspectBrandImage,
  readImageResponse,
  readPublicImage,
} from '../server/branding-image.mjs';

const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80"><path d="M0 0h10v10z"/></svg>',
);

test('按图片字节识别格式和尺寸，拒绝HTML及无效图片', () => {
  assert.deepEqual(inspectBrandImage(svg), {
    contentType: 'image/svg+xml',
    width: 320,
    height: 80,
  });
  const png = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.write('IHDR', 12);
  png.writeUInt32BE(480, 16);
  png.writeUInt32BE(160, 20);
  assert.deepEqual(inspectBrandImage(png), { contentType: 'image/png', width: 480, height: 160 });
  const gif = Buffer.alloc(13);
  gif.write('GIF89a');
  gif.writeUInt16LE(120, 6);
  gif.writeUInt16LE(60, 8);
  assert.deepEqual(inspectBrandImage(gif), { contentType: 'image/gif', width: 120, height: 60 });
  for (const body of [
    Buffer.from('<html><img src="logo.png"></html>'),
    Buffer.from('not image'),
    Buffer.alloc(0),
    Buffer.alloc(2 * 1024 * 1024 + 1),
  ])
    assert.equal(inspectBrandImage(body), null);
  png.writeUInt32BE(0, 16);
  assert.equal(inspectBrandImage(png), null);
});

test('识别JPEG、WebP和ICO最大帧，保留真实清晰度', () => {
  const jpeg = Buffer.from([
    255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 8, 8, 0, 80, 1, 64, 0, 255, 217,
  ]);
  assert.deepEqual(inspectBrandImage(jpeg), { contentType: 'image/jpeg', width: 320, height: 80 });
  const webp = Buffer.alloc(30);
  webp.write('RIFF');
  webp.writeUInt32LE(22, 4);
  webp.write('WEBPVP8X', 8);
  webp.writeUIntLE(639, 24, 3);
  webp.writeUIntLE(159, 27, 3);
  assert.deepEqual(inspectBrandImage(webp), { contentType: 'image/webp', width: 640, height: 160 });
  const lossless = Buffer.alloc(25);
  lossless.write('RIFF');
  lossless.write('WEBPVP8L', 8);
  lossless[20] = 47;
  lossless.writeUInt32LE(127 | (63 << 14), 21);
  assert.deepEqual(inspectBrandImage(lossless), {
    contentType: 'image/webp',
    width: 128,
    height: 64,
  });
  const ico = Buffer.alloc(40);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(2, 4);
  ico[6] = ico[7] = 16;
  ico.writeUInt32LE(1, 14);
  ico.writeUInt32LE(38, 18);
  ico[22] = ico[23] = 128;
  ico.writeUInt32LE(1, 30);
  ico.writeUInt32LE(39, 34);
  assert.deepEqual(inspectBrandImage(ico), {
    contentType: 'image/x-icon',
    width: 128,
    height: 128,
  });
  assert.equal(inspectBrandImage(ico.subarray(0, 38)), null);
  assert.equal(inspectBrandImage(jpeg.subarray(0, 14)), null);
});

test('SVG拒绝主动内容与外部引用，允许内部渐变与样式', () => {
  for (const content of [
    '<svg><script>alert(1)</script></svg>',
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><foreignObject><div>hello</div></foreignObject></svg>',
    '<!DOCTYPE svg [<!ENTITY x SYSTEM "https://private.example.com">]><svg></svg>',
    '<svg><image href="https://private.example.com/image"/></svg>',
    '<svg><use xlink:href="https://private.example.com/image#logo"/></svg>',
    '<svg><style>@import "https://private.example.com/style"</style></svg>',
    '<svg><path style="fill:url(https://private.example.com/image)"/></svg>',
    '<svg><path/>',
  ])
    assert.equal(inspectBrandImage(Buffer.from(content)), null, content);
  assert.ok(
    inspectBrandImage(
      Buffer.from(
        '<svg viewBox="0 0 10 10"><style>.a{fill:red}</style><path fill="url(#a)"/><use href="#a"/></svg>',
      ),
    ),
  );
});

test('SWF样式SVG可包含经过字节验证的base64位图，拒绝伪装数据与内嵌SVG', () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9HBN0AAAAASUVORK5CYII=';
  const wrap = (reference) =>
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><svg width="220px" height="26px" viewBox="0 0 220 26" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g transform="translate(-130, -70)"><image id="SWFc_Logo_2019" x="130" y="70" width="220" height="26" xlink:href="${reference}"/></g></svg>`,
    );
  assert.deepEqual(inspectBrandImage(wrap('data:image/png;base64,' + png)), {
    contentType: 'image/svg+xml',
    width: 220,
    height: 26,
  });
  for (const reference of [
    'data:image/svg+xml;base64,' +
      Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64'),
    'data:image/png;base64,' +
      Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64'),
    'data:image/png;base64,' + Buffer.from('<html>error</html>').toString('base64'),
    'data:text/html;base64,' + png,
    'data:image/jpeg;base64,' + png,
    'data:image/png;base64,invalid',
    'data:image/svg+xml;base64,\n' +
      Buffer.from('<svg><script>alert(1)</script></svg>').toString('base64'),
    'https://private.example.com/\nimage.png',
  ])
    assert.equal(inspectBrandImage(wrap(reference)), null, reference.slice(0, 40));
});

test('图片流超过上限或中途关闭不会缓存截断内容', async () => {
  const full = new PassThrough();
  const reading = readImageResponse(full, 20);
  full.end(Buffer.from('valid body'));
  assert.equal((await reading).toString(), 'valid body');
  const oversized = new PassThrough();
  const rejected = assert.rejects(readImageResponse(oversized, 3), /上限/);
  oversized.end(Buffer.from('too long'));
  await rejected;
  const partial = new PassThrough();
  const truncated = assert.rejects(readImageResponse(partial), /完整/);
  partial.write('partial');
  partial.destroy();
  await truncated;
});

function network(pages, addresses = () => [{ address: '8.8.8.8', family: 4 }]) {
  const calls = [];
  return {
    calls,
    options: {
      lookupImpl: async (host) => addresses(host),
      proxyImpl: async () => null,
      requestImpl: (url, options, callback) => {
        calls.push({ url: url.href, options });
        const request = new EventEmitter();
        request.end = () =>
          queueMicrotask(() => {
            const page = pages[calls.length - 1];
            if (!page) {
              request.emit('error', new Error('Unexpected request'));
              return;
            }
            const response = new PassThrough();
            response.statusCode = page.status || 200;
            response.headers = page.headers || {};
            callback(response);
            response.end(page.body || svg);
          });
        return request;
      },
    },
  };
}

test('CDN跳转逐跳验证公网DNS，固定目标IP且不信任响应声明的图片类型', async () => {
  const net = network([
    { status: 302, headers: { location: 'https://cdn.shadeco.com/logo.svg' } },
    { headers: { 'content-type': 'application/octet-stream' } },
  ]);
  const image = await readPublicImage('https://shadeco.com/logo', undefined, net.options);
  assert.equal(image.contentType, 'image/svg+xml');
  assert.equal(image.width, 320);
  assert.equal(net.calls.length, 2);
  const options = net.calls[1].options;
  assert.equal(options.servername, 'cdn.shadeco.com');
  assert.equal(options.headers.Host, 'cdn.shadeco.com');
  options.lookup('ignored-host', { all: true }, (error, selected) => {
    assert.equal(error, null);
    assert.deepEqual(selected, [{ address: '8.8.8.8', family: 4 }]);
  });
  const fake = network([
    { headers: { 'content-type': 'image/png' }, body: Buffer.from('<html>blocked</html>') },
  ]);
  await assert.rejects(
    readPublicImage('https://shadeco.com/logo.png', undefined, fake.options),
    /格式无效/,
  );
});

test('拒绝重定向到内网、HTTP、过多跳转和已取消请求', async () => {
  const privateNet = network(
    [{ status: 302, headers: { location: 'https://private.shadeco.com/logo.png' } }],
    (host) => [{ address: host.startsWith('private.') ? '127.0.0.1' : '8.8.8.8', family: 4 }],
  );
  await assert.rejects(
    readPublicImage('https://shadeco.com/logo', undefined, privateNet.options),
    /非公网/,
  );
  assert.equal(privateNet.calls.length, 1);
  const insecure = network([{ status: 302, headers: { location: 'http://cdn.shadeco.com/logo' } }]);
  await assert.rejects(
    readPublicImage('https://shadeco.com/logo', undefined, insecure.options),
    /HTTPS/,
  );
  const looping = network(
    Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/logo' } })),
  );
  await assert.rejects(
    readPublicImage('https://shadeco.com/logo', undefined, looping.options),
    /跳转次数/,
  );
  assert.equal(looping.calls.length, 4);
  const controller = new AbortController();
  controller.abort();
  const aborted = network([]);
  await assert.rejects(
    readPublicImage('https://shadeco.com/logo', controller.signal, aborted.options),
    { name: 'AbortError' },
  );
  assert.equal(aborted.calls.length, 0);
});

test('SWF式同站apex到www的HTTP规范跳转只尝试HTTPS，不发送HTTP请求', async () => {
  const net = network([
    { status: 301, headers: { location: 'http://www.shadeco.com/logo.svg' } },
    {},
  ]);
  const image = await readPublicImage('https://shadeco.com/logo.svg', undefined, net.options);
  assert.equal(image.contentType, 'image/svg+xml');
  assert.deepEqual(
    net.calls.map((call) => call.url),
    ['https://shadeco.com/logo.svg', 'https://www.shadeco.com/logo.svg'],
  );
});

test('DNS未返回时超时也能终止图片读取，不占用加载队列', async () => {
  const controller = new AbortController();
  const pending = readPublicImage('https://shadeco.com/logo', controller.signal, {
    lookupImpl: () => new Promise(() => {}),
    proxyImpl: async () => null,
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  controller.abort();
  await rejected;
});
