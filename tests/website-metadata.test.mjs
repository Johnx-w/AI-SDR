import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  combineWebsiteEvidence,
  enrichmentFields,
  planWebsitePages,
  extractWebsiteMetadata,
} from '../server/website-metadata.mjs';
import { enrichmentHelpers } from '../server/n8n-enrichment.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';
import { readFile } from 'node:fs/promises';
import { improveContactNode } from '../server/n8n-contacts.mjs';
import { removeCityTarget } from '../server/n8n-search-target.mjs';
import {
  upgradeRecordBuilder,
  evidenceCode,
  mergeSupplementCode,
  newFeishuFields,
} from '../server/n8n-enrichment.mjs';
const url = 'https://vtrackscreens.com/screens/florida/miami/';
const org = {
  '@type': 'Organization',
  url: 'https://vtrackscreens.com',
  name: 'V-Track Screens',
  address: {
    streetAddress: '12446 Highway 205',
    addressLocality: 'Lavon',
    addressRegion: 'TX',
    postalCode: '75166',
    addressCountry: 'US',
  },
  telephone: '+1-469-942-7193',
  sameAs: ['https://www.instagram.com/vtrackscreens'],
};
const service = {
  '@type': 'Service',
  url,
  areaServed: {
    '@type': 'City',
    name: 'Miami',
    containedInPlace: { '@type': 'State', name: 'Florida' },
  },
};
const html = `<script type="application/ld+json">${JSON.stringify([org, service])}</script><a href="https://www.facebook.com/sharer/sharer.php?u=https://vtrackscreens.com">share</a><a href="https://www.youtube.com/@Vtrackscreens"><svg/></a>`;
test('企业结构化地址与服务地区独立，分享链接不作为社媒账户', () => {
  const e = combineWebsiteEvidence([{ url, content: html }]);
  assert.equal(e.addresses[0].city, 'Lavon');
  assert.equal(e.addresses[0].region, 'TX');
  assert.equal(e.service_areas[0].name, 'Miami, Florida');
  assert.deepEqual(e.social.map((x) => x.platform).sort(), ['Instagram', 'YouTube']);
  assert.equal(e.contacts[0].normalized, '+14699427193');
  for (const s of e.social) assert.ok(html.includes(s.quote));
  const result = enrichmentFields({ task_target: { city: 'Miami', region: 'Florida' } }, e).fields;
  assert.equal(result['州'], 'TX');
  assert.equal(result['城市'], 'Lavon');
  assert.equal(result['服务地区'], 'Miami, Florida');
  const mapped = mapFeishuRecord({ record_id: 'test', fields: result });
  assert.equal(mapped.city, 'Lavon');
  assert.equal(mapped.serviceAreas, 'Miami, Florida');
  assert.equal(mapped.social.length, 2);
});
test('没有地址时不把目标/服务城市当成企业所在地；JSON-LD 和原文保留证据', () => {
  const e = combineWebsiteEvidence([
    { url, content: `<script type="application/ld+json">${JSON.stringify(service)}</script>` },
  ]);
  const result = enrichmentFields(
    { task_target: { country: 'United States', region: 'Florida' } },
    e,
  ).fields;
  assert.equal(result['国家'], undefined);
  assert.equal(result['州'], undefined);
  assert.equal(result['城市'], undefined);
  const postal = extractWebsiteMetadata({
    sourceUrl: 'https://magnatrackoutdoorscreens.com/',
    content: 'Office: 7839 Fruitville Rd, Sarasota, FL 34240, USA',
  });
  assert.equal(postal.addresses[0].city, 'Sarasota');
});
test('补全保留原有电话/社媒，空值不清除已有地址与服务地区', () => {
  const first = combineWebsiteEvidence([{ url, content: html }]);
  const p = enrichmentFields({}, first).profile;
  const e = combineWebsiteEvidence([{ url, content: 'No new details.' }]);
  const result = enrichmentFields(p, e, {
    电话: '+1-888-477-4202',
    Facebook: 'https://www.facebook.com/old',
  });
  assert.ok(result.fields['电话'].includes('+1-888-477-4202'));
  assert.equal(result.fields['城市'], 'Lavon');
  assert.equal(result.fields['服务地区'], 'Miami, Florida');
  assert.equal(result.fields['Facebook'], 'https://www.facebook.com/old');
});
test('限制站内补全范围，拒绝私有域名与跨站联系页；n8n 无网络沙箱可运行', () => {
  assert.deepEqual(
    planWebsitePages(
      'https://vtrackscreens.com',
      '<a href="contact/">Contact</a><a href="https://evil.com/contact">Contact</a>',
    ),
    ['https://vtrackscreens.com/', 'https://vtrackscreens.com/contact/'],
  );
  assert.deepEqual(planWebsitePages('https://127.0.0.1/'), []);
  const output = vm.runInNewContext(
    enrichmentHelpers +
      ';combineWebsiteEvidence([{url:' +
      JSON.stringify(url) +
      ',content:' +
      JSON.stringify(html) +
      '}])',
  );
  assert.equal(output.addresses[0].city, 'Lavon');
  assert.equal(output.service_areas[0].name, 'Miami, Florida');
});

test('生产 n8n 证据采集、补充正文失败降级、飞书映射贯通，目标州不污染实际地址', async () => {
  const original = await readFile(
    new URL('./fixtures/n8n-build-record-original.txt', import.meta.url),
    'utf8',
  );
  const code = upgradeRecordBuilder(removeCityTarget(improveContactNode(original)));
  const nodes = {
    检查正文: { source_url: url, page_text: 'Motorized patio screens in Miami.' },
    官网补全页面: [{ url }],
    'Tavily Extract': { results: [] },
    最终结果: [
      {
        ok: true,
        source_url: url,
        company_name: 'V-Track Screens',
        actual_country: null,
        customer_type: 'manufacturer',
        products: ['screens'],
        fit_status: 'review',
        facts: [],
      },
    ],
    配置搜索目标: { country: 'United States', region: 'Florida', product: 'screens' },
    获取飞书Token: { body: { code: 0, tenant_access_token: 'test-only' } },
  };
  const run = (script, input) =>
    JSON.parse(
      JSON.stringify(
        vm.runInNewContext('(function(){' + script + '})()', {
          $: (name) => ({
            first: () => ({ json: nodes[name] }),
            all: () => nodes[name].map((json) => ({ json })),
          }),
          $input: { first: () => ({ json: input }), all: () => [{ json: input }] },
        }),
      ),
    );
  nodes['汇总官网证据'] = run(evidenceCode, { statusCode: 200, html })[0].json;
  nodes['归并官网补全'] = run(mergeSupplementCode, { error: 'optional page unavailable' })[0].json;
  const fields = [
    'customer_id',
    '客户名称',
    '来源链接',
    '来源渠道',
    '主体类型',
    '国家',
    '州',
    '城市',
    '客户类型',
    '相关产品',
    '画像JSON',
    '邮箱',
    '电话',
    '匹配状态',
    '首次发现时间',
    ...newFeishuFields,
  ];
  const result = run(code, {
    code: 0,
    data: {
      items: fields.map((field_name) => ({
        field_name,
        type: field_name === '首次发现时间' ? 5 : 1,
      })),
    },
  })[0].json;
  assert.equal(result.ready, true);
  assert.equal(result.insert_fields['城市'], 'Lavon');
  assert.equal(result.insert_fields['州'], 'TX');
  assert.equal(result.insert_fields['国家'], 'United States');
  assert.equal(result.insert_fields['服务地区'], 'Miami, Florida');
  assert.ok(result.insert_fields['Instagram'].includes('vtrackscreens'));
  assert.equal(result.website_key, 'vtrackscreens.com');
  const p = JSON.parse(result.insert_fields['画像JSON']);
  assert.equal(p.task_target.region, 'Florida');
  assert.equal(p.website_metadata.addresses[0].region, 'TX');
  assert.equal(p.actual_country, 'United States');
});
