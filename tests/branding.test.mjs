import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverBranding, parseBranding, publicAddress } from '../server/branding.mjs';

test('官网品牌图片优先于图标，排除合作方图片与不安全地址', () => {
  const marks = parseBranding(
    `<link rel="icon" href="/icon.png"><img src="/partner-logo.png" alt="Partner Logo"><img src="/shadeco-logo.svg?a=1&amp;b=2" alt="ShadeCo Logo"><img src="/generic-logo.png" alt="Logo"><img src="/photo.jpg" alt="ShadeCo patio"><img src="http://127.0.0.1/logo.svg" alt="ShadeCo Logo"><img src="javascript:alert(1)" alt="Logo">`,
    'https://shadeco.com/',
    'ShadeCo',
  );
  assert.equal(marks[0].url, 'https://shadeco.com/shadeco-logo.svg?a=1&b=2');
  assert.equal(marks[0].kind, 'logo');
  assert.equal(
    marks.some((m) => m.url.includes('partner')),
    false,
  );
  assert.equal(
    marks.some((m) => m.url.includes('photo')),
    false,
  );
  assert.equal(
    marks.some((m) => m.url.includes('127.0.0.1')),
    false,
  );
  assert.equal(marks.at(-1).kind, 'website_icon');
});
test('公网地址检查拒绝本地、内网、链路本地及IPv6保留地址', () => {
  for (const ip of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])
    assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.equal(publicAddress('2606:4700::1111'), true);
});
test('真实官网读取仅跟随同域HTTPS跳转，提供官网图标和公开缓存降级', async () => {
  const calls = [];
  const result = await discoverBranding(
    { name: 'ShadeCo', website: 'https://shadeco.com/products' },
    {
      readPage: async (url) => {
        calls.push(url.href);
        return calls.length === 1
          ? { redirect: 'https://www.shadeco.com/' }
          : { html: '<img alt="ShadeCo Logo" src="/logo.svg">' };
      },
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(result.candidates[0].url, 'https://www.shadeco.com/logo.svg');
  assert.equal(result.candidates.at(-1).provider, 'DuckDuckGo');
  const redirected = [];
  await discoverBranding(
    { name: 'ShadeCo', website: 'https://shadeco.com/' },
    {
      readPage: async (url) => {
        redirected.push(url.href);
        return { redirect: 'https://unrelated.com/' };
      },
    },
  );
  assert.equal(redirected.length, 1);
});
test('官网错误不会阻断客户列表；示例域名不发起网络读取', async () => {
  const result = await discoverBranding(
    { name: 'ShadeCo', website: 'https://shadeco.com/' },
    {
      readPage: async () => {
        throw new Error('unavailable');
      },
    },
  );
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].kind, 'website_icon');
  const demo = await discoverBranding(
    { name: 'Demo', website: 'https://company.example/' },
    {
      readPage: async () => {
        throw new Error('must not call');
      },
    },
  );
  assert.deepEqual(demo.candidates, []);
});
