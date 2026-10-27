import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverBranding,
  parseBranding,
  publicAddress,
  readPublicHtml,
} from '../server/branding.mjs';

test('官网将裸域跳到HTTP的www地址时优先尝试同站HTTPS，不读取明文地址', async () => {
  const calls = [];
  const result = await discoverBranding(
    { name: 'SWFcontract', website: 'https://swfcontract.com/' },
    {
      readPage: async (url) => {
        calls.push(url.href);
        return calls.length === 1
          ? { redirect: 'http://www.swfcontract.com/' }
          : {
              html: '<img alt="SWF Contract" src="/siteassets/assets/images/ui/swfc_logo_2019.svg">',
            };
      },
    },
  );
  assert.equal(
    result.candidates[0]?.url,
    'https://www.swfcontract.com/siteassets/assets/images/ui/swfc_logo_2019.svg',
  );
  assert.deepEqual(calls, ['https://swfcontract.com/', 'https://www.swfcontract.com/']);
});

test('官网的跨站HTTP跳转、非标准端口和含凭证地址仍不跟随', async () => {
  for (const redirect of [
    'http://unrelated.com/',
    'http://www.swfcontract.com:8080/',
    'http://user:password@www.swfcontract.com/',
    'http://127.0.0.1/',
  ]) {
    const calls = [];
    const result = await discoverBranding(
      { name: 'SWFcontract', website: 'https://swfcontract.com/' },
      {
        readPage: async (url) => {
          calls.push(url.href);
          return { redirect };
        },
      },
    );
    assert.deepEqual(calls, ['https://swfcontract.com/']);
    assert.ok(result.candidates.every((mark) => mark.kind === 'website_icon'));
  }
});

test('文字页头可从同官网企业结构化数据取得明确声明的 Logo，不取产品或第三方品牌', () => {
  const marks = parseBranding(
    `<header><a href="/">Shadeotech</a></header><script type="application/ld+json">${JSON.stringify(
      {
        '@context': 'https://schema.org',
        '@graph': [
          {
            '@type': 'Organization',
            name: 'Partner',
            url: 'https://partner.com/',
            logo: 'https://partner.com/logo.png',
          },
          {
            '@type': 'Product',
            name: 'Shadeotech',
            url: 'https://shadeotech.com/',
            logo: 'https://shadeotech.com/product.png',
          },
          {
            '@type': 'HomeAndConstructionBusiness',
            name: 'Shadeotech Window Fashions',
            url: 'https://shadeotech.com/',
            logo: {
              '@type': 'ImageObject',
              url: 'https://shadeotech.com/wp-content/uploads/2025/03/01-01-2-retina-copy.png',
            },
          },
        ],
      },
    )}</script>`,
    'https://shadeotech.com/',
    'Shadeotech',
  );
  assert.deepEqual(marks, [
    {
      url: 'https://shadeotech.com/wp-content/uploads/2025/03/01-01-2-retina-copy.png',
      kind: 'logo',
    },
  ]);
});

test('官网 DNS 或代理等待也受取消信号约束，不占住品牌获取并发位置', async () => {
  for (const blocked of ['dns', 'proxy']) {
    const controller = new AbortController();
    let entered;
    const waiting = new Promise((resolve) => {
      entered = resolve;
    });
    const read = readPublicHtml(new URL('https://shadeco.com/'), controller.signal, {
      lookupImpl: async () => {
        if (blocked === 'dns') {
          entered();
          return new Promise(() => {});
        }
        return [{ address: '8.8.8.8', family: 4 }];
      },
      proxyImpl: async () => {
        entered();
        return new Promise(() => {});
      },
      requestImpl: () => {
        throw new Error('must not request');
      },
    });
    const handled = read.catch((error) => error);
    await Promise.race([waiting, new Promise((resolve) => setTimeout(resolve, 20))]);
    controller.abort(new Error('cancelled website'));
    const result = await Promise.race([
      handled,
      new Promise((resolve) => setTimeout(() => resolve(null), 50)),
    ]);
    assert.match(result?.message || '', /cancelled website/, blocked);
  }
});

test('页头品牌识别支持无 logo 文件名和响应式高清图片，跳过页面合作品牌', () => {
  const marks = parseBranding(
    `<link rel="icon" href="/tiny.ico"><section class="partners"><img alt="ShadeCo partner logo" src="/shadeco-partner-logo.png"></section>
    <header><a href="/" class="site-branding"><picture><source media="(min-width: 800px)" srcset="/brand-640.webp 640w, /brand-1280.webp 1280w"><img class="custom-logo" alt="ShadeCo" src="/brand-80.png" srcset="/brand-160.png 160w, /brand-320.png 320w"></picture></a></header>`,
    'https://shadeco.com/',
    'ShadeCo',
  );
  assert.equal(marks[0].url, 'https://shadeco.com/brand-1280.webp');
  assert.equal(marks[0].kind, 'logo');
  assert.equal(
    marks.some((mark) => mark.url.includes('partner')),
    false,
  );
});

test('官网页头 Logo 使用懒加载高清源并保留白色品牌图背景提示', () => {
  const marks = parseBranding(
    `<header><a href="/" class="header__heading-link"><img alt="ShadeCo" class="header__heading-logo" src="data:image/gif;base64,AAAA" data-src="/shadeco-logo-white-80.png" data-srcset="/shadeco-logo-white-160.png 1x, /shadeco-logo-white.svg 2x"></a></header>`,
    'https://shadeco.com/',
    'ShadeCo',
  );
  assert.equal(marks[0]?.url, 'https://shadeco.com/shadeco-logo-white.svg');
  assert.equal(marks[0]?.background, 'dark');
});

test('Phantom 与 Universal 的真实页头结构可识别，不依赖企业全名或 Logo 替代文字', () => {
  const phantom = parseBranding(
    `<header>Welcome</header><div id="main-menu-nav-container"><div><a href="/"><img src="/logo-ko.png" alt="Phantom Screens" width="230" height="80"></a></div></div><footer><a href="/"><img class="footer-logo" src="/logo.png" alt="Phantom Screens"></a></footer>`,
    'https://phantomsouthflorida.com/',
    'Phantom Screens of South Florida',
  );
  assert.equal(phantom[0]?.url, 'https://phantomsouthflorida.com/logo-ko.png');
  assert.equal(phantom[0]?.background, 'dark');
  const universal = parseBranding(
    `<div class="navbar"><a class="navbar-brand-sitelogo" href="https://www.usmotions.com/"><img src="/universal-retractable-screens-logo-3.png" alt="Back Home" width="250" height="100"></a></div>`,
    'https://www.usmotions.com/',
    'Universal Screens LLC',
  );
  assert.equal(universal[0]?.kind, 'logo');
  assert.match(universal[0].url, /universal-retractable-screens-logo-3\.png$/);
});

test('媒体品牌轮播、脚本模板和逗号拼接的错误图片源不作为企业品牌', () => {
  const marks = parseBranding(
    `<script>const x = '<img src="/fake-logo.png" alt="Logo">';</script>
    <header><a href="/"><img class="header-logo" src="/yoolax-logo.png" alt="Yoolax"></a></header>
    <section class="section-logo-list"><div><div><div><div><div><img src="/amazon-logo.svg" alt=""><img src="/work-with-yoolax-app-logo.png" alt=""></div></div></div></div></div></section>
    <img src="/broken-logo.png, //yoolax.com/broken-logo.png" alt="Logo">`,
    'https://yoolax.com/',
    'Yoolax',
  );
  assert.deepEqual(
    marks.map((mark) => mark.url),
    ['https://yoolax.com/yoolax-logo.png'],
  );
});

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
