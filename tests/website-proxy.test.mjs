import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowsWebsiteProxy, websiteProxyUrl } from '../server/website-proxy.mjs';

test('只使用已启用的 Windows HTTPS 或统一代理，不把 HTTP/SOCKS 专用地址当作 HTTPS 代理', () => {
  assert.equal(parseWindowsWebsiteProxy('0x1', '127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(parseWindowsWebsiteProxy(0, '127.0.0.1:7897'), '');
  assert.equal(
    parseWindowsWebsiteProxy(1, 'http=localhost:8000;https=localhost:8001'),
    'http://localhost:8001',
  );
  assert.equal(
    parseWindowsWebsiteProxy(1, 'https=https://proxy.example.org:8443'),
    'https://proxy.example.org:8443',
  );
  assert.equal(parseWindowsWebsiteProxy(1, 'http=localhost:8000;socks=localhost:8002'), '');
});

test('显式官网代理优先，非法设置报通用错误，不泄露凭证', async (t) => {
  const previous = process.env.WEBSITE_HTTPS_PROXY;
  t.after(() => {
    if (previous === undefined) delete process.env.WEBSITE_HTTPS_PROXY;
    else process.env.WEBSITE_HTTPS_PROXY = previous;
  });
  process.env.WEBSITE_HTTPS_PROXY = 'https://proxy.example.org:8443';
  assert.equal((await websiteProxyUrl()).href, 'https://proxy.example.org:8443/');
  process.env.WEBSITE_HTTPS_PROXY = 'socks5://user:secret@proxy.example.org:1080';
  await assert.rejects(websiteProxyUrl(), /^Error: 官网代理地址无效，须使用 HTTP 或 HTTPS 代理$/);
});
