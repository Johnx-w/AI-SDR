import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  combineWebsiteEvidence,
  enrichmentFields,
  planWebsitePages,
  extractWebsiteMetadata,
} from '../server/website-metadata.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';
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
  assert.deepEqual(e.social.map((x) => x.platform).sort(), ['Instagram']);
  assert.equal(e.contacts[0].normalized, '+14699427193');
  for (const s of e.social) assert.ok(html.includes(s.quote));
  const result = enrichmentFields({ task_target: { city: 'Miami', region: 'Florida' } }, e).fields;
  assert.equal(result['州 / 城市'], 'TX · Lavon');
  assert.equal(result['服务地区'], 'Miami, Florida');
  const mapped = mapFeishuRecord({ record_id: 'test', fields: result });
  assert.equal(mapped.region, 'TX · Lavon');
  assert.equal(mapped.serviceAreas, 'Miami, Florida');
  assert.equal(mapped.social.length, 1);
});
test('服务地区不收录官网宣传句', () => {
  const sourceUrl = 'https://abcblinds.com.au/';
  const content =
    '<script type="application/ld+json">' +
    JSON.stringify({ '@type': 'Organization', url: sourceUrl, areaServed: 'Western Australia' }) +
    '</script><p>Proudly serving Western Australia for over 50 years, ABC Blinds & Awnings is not just based here — we&#x27;re built here</p>' +
    '<p>Proudly serving Western Australia for over 50 years, ABC Blinds & Awnings is not just based here — we’re built here</p>';
  const evidence = combineWebsiteEvidence([{ url: sourceUrl, content }]);
  assert.deepEqual(
    evidence.service_areas.map((area) => area.name),
    ['Western Australia'],
  );
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
  assert.ok(result.fields['电话'].includes('+1 8884774202'));
  assert.equal(result.fields['州 / 城市'], 'TX · Lavon');
  assert.equal(result.fields['服务地区'], 'Miami, Florida');
  assert.equal(result.fields['Facebook'], 'https://www.facebook.com/old');
});
test('限制站内补全范围，拒绝私有域名与跨站联系页', () => {
  assert.deepEqual(
    planWebsitePages(
      'https://vtrackscreens.com',
      '<a href="contact/">Contact</a><a href="https://evil.com/contact">Contact</a>',
    ),
    ['https://vtrackscreens.com/', 'https://vtrackscreens.com/contact/'],
  );
  assert.deepEqual(planWebsitePages('https://127.0.0.1/'), []);
});
