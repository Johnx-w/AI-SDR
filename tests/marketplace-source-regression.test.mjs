import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeAcquisition, selectWebsiteCandidates } from '../server/native-acquisition.mjs';
import { verifyCompanyIdentity } from '../server/company-identity.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/exporthub-marketplace-20261024.json', import.meta.url), 'utf8'),
);
const env = {
  ACQUISITION_PROVIDER: 'native',
  TAVILY_API_KEY: 'fixture-search',
  DEEPSEEK_API_KEY: 'fixture-model',
  FEISHU_APP_ID: 'fixture-app',
  FEISHU_APP_SECRET: 'fixture-secret',
  FEISHU_APP_TOKEN: 'fixture-table',
  FEISHU_TABLE_ID: 'fixture-id',
};

test('真实ExportHub产品卡片及同类B2B市场域名不是商家独立官网', () => {
  const found = selectWebsiteCandidates([
    { url: fixture.source_url, title: fixture.source_title },
    ...['globalsources.com', 'tradeindia.com', 'indiamart.com'].map((host) => ({
      url: `https://${host}/product/roller-fabrics`,
      title: 'Roller blind fabric manufacturer',
    })),
    {
      url: 'https://exporthub-blinds.example.org/',
      title: 'ExportHub Blinds Co. Official Website',
    },
  ]);
  assert.deepEqual(
    found.candidates.map((row) => row.domain),
    ['exporthub-blinds.example.org'],
  );
});

test('真实产品页商家名不能因逐字出现在供应商卡片就成为平台域名经营者', () => {
  const identity = verifyCompanyIdentity(
    fixture.identity_evidence,
    fixture.pages,
    fixture.source_url,
  );
  assert.equal(identity.name, null);
  assert.equal(identity.evidence.length, 0);
});

test('未知B2B市场的产品、会员与买卖家注册组合在研究前进入待核实', async () => {
  let modelCalls = 0;
  const source = 'https://marketplace.example.org/product/roller-blind-fabric.html';
  const pageText = fixture.pages[0].text
    .replaceAll('exporthub.com', 'marketplace.example.org')
    .replaceAll('ExportHub', 'MarketPlatform');
  const service = new NativeAcquisition({
    env,
    readPage: async () => ({ html: pageText }),
    feishu: {
      records: async () => [],
      write: async () => assert.fail('No remote write permitted'),
    },
    providers: {
      web: { extract: async () => ({ results: [] }) },
      model: {
        research: async () => {
          modelCalls++;
          throw new Error('No model request permitted');
        },
      },
    },
    fetchImpl: async () => assert.fail('No external requests permitted'),
  });
  try {
    const result = await service.research(
      { country: 'Canada', product: 'roller blind fabric', audience: 'BC' },
      { source_url: source, operation_id: 'unknown-marketplace-regression' },
    );
    assert.equal(modelCalls, 0);
    assert.equal(result.outcome, 'review');
    assert.equal(result.handoff.identity_verified, false);
    assert.equal(result.handoff.contact_verified, false);
    assert.match(result.reason, /第三方|独立官网|平台/);
  } finally {
    service.close();
  }
});

test('普通厂家Contact supplier与自身会员服务不单独触发平台误判', () => {
  const source = 'https://fabricbuyer.example.org/';
  const text =
    'Fabric Buyer LLC supplies roller blind fabrics. Contact supplier for samples. Register for our trade customer membership.';
  const found = selectWebsiteCandidates([
    { url: source, title: 'Fabric Buyer LLC', content: text },
  ]);
  const identity = verifyCompanyIdentity(
    [{ field: 'company_name', value: 'Fabric Buyer LLC', quote: text, source_url: source }],
    [{ source_url: source, text }],
    source,
  );
  assert.equal(found.candidates.length, 1);
  assert.equal(identity.name, 'Fabric Buyer LLC');
});
