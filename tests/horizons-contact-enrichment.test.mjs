import test from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { researchFields } from '../server/company-research.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';
import { readPublicHtml } from '../server/branding.mjs';

const site = 'https://www.horizonshades.com/';
const footer = await readFile(
  new URL('./fixtures/horizons-social-footer.html', import.meta.url),
  'utf8',
);

test('官网直连不可达时通过已配置代理读取 Horizons 页尾，社媒贯通提取与客户字段', async (t) => {
  const previous = process.env.WEBSITE_HTTPS_PROXY;
  process.env.WEBSITE_HTTPS_PROXY = 'http://127.0.0.1:7897';
  t.after(() => {
    if (previous === undefined) delete process.env.WEBSITE_HTTPS_PROXY;
    else process.env.WEBSITE_HTTPS_PROXY = previous;
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(dns, 'lookup', async () => [{ address: '23.37.80.10', family: 4 }]);
  const requests = [];
  t.mock.method(https, 'request', (url, options, callback) => {
    requests.push({ url, options });
    // Simulate the actual deployment: only the configured proxy route is reachable.
    if (url.hostname !== '23.37.80.10' || !options.agent?.options.proxyEnv?.HTTPS_PROXY)
      throw new Error('Direct website connection timed out');
    const request = new EventEmitter();
    request.end = () => {
      const response = Readable.from([Buffer.from(footer)]);
      response.statusCode = 200;
      response.headers = { 'content-type': 'text/html; charset=utf-8' };
      callback(response);
    };
    return request;
  });
  syncBuiltinESMExports();
  let extractions = 0;
  const service = new NativeAcquisition({
    env: {},
    providers: {
      web: {
        extract: async () => {
          extractions++;
          return {
            results: [
              { url: site, raw_content: '# Horizons Window Fashions\nCustom window coverings.' },
            ],
          };
        },
      },
    },
  });
  try {
    const page = await service.collect(site);
    const fields = researchFields(
      { source_url: site, facts: [], products: [] },
      page.website_metadata,
    );
    const lead = mapFeishuRecord({ record_id: 'rec-horizons', fields });
    assert.deepEqual(lead.social.map((s) => s.platform).sort(), [
      'Facebook',
      'Instagram',
      'LinkedIn',
    ]);
    assert.equal(
      fields.Facebook,
      'https://www.facebook.com/pages/BW-Window-Fashions/200906233304652',
    );
    assert.equal(fields.Instagram, 'https://www.instagram.com/horizonswindowfashions');
    assert.equal(extractions, 0, '完整 HTML 成功时无需付费正文降级');
    assert.equal(requests[0].options.servername, 'www.horizonshades.com');
    assert.equal(requests[0].options.headers.Host, 'www.horizonshades.com');
    assert.ok(
      page.website_metadata.social.every((s) => s.source_url === site && footer.includes(s.quote)),
    );
  } finally {
    service.close();
  }
});

test('启用官网代理后仍在建立连接前拒绝私网来源和含私网解析的域名', async (t) => {
  let requests = 0;
  t.mock.method(dns, 'lookup', async () => [
    { address: '23.37.80.10', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  t.mock.method(https, 'request', () => {
    requests++;
    throw new Error('Must not reach transport');
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  for (const value of [
    'https://127.0.0.1/',
    'https://169.254.169.254/',
    'https://user:secret@www.horizonshades.com/',
  ])
    await assert.rejects(
      readPublicHtml(new URL(value), AbortSignal.timeout(1000)),
      /非公网 HTTPS 来源/,
    );
  await assert.rejects(readPublicHtml(new URL(site), AbortSignal.timeout(1000)), /非公网来源/);
  assert.equal(requests, 0);
});
