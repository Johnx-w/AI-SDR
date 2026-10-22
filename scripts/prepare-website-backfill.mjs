import fs from 'node:fs/promises';
import {
  websiteScope,
  combineWebsiteEvidence,
  enrichmentFields,
} from '../server/website-metadata.mjs';
import { enrichmentHelpers } from '../server/n8n-enrichment.mjs';
const before = JSON.parse(await fs.readFile('artifacts/enrichment-records-before.json', 'utf8'))
  .data.items;
const current = JSON.parse(
  await fs.readFile('artifacts/enrichment-backfill-evidence.json', 'utf8'),
);
const pages = [
  ...JSON.parse(await fs.readFile('artifacts/enrichment-tavily-backfill.json', 'utf8')),
  ...JSON.parse(await fs.readFile('artifacts/enrichment-contact-pages.json', 'utf8')),
];
const byRecord = {};
const summaries = [];
for (const record of before) {
  const url = record.fields['来源链接'];
  if (/eventbrite\.com/.test(url)) continue;
  const local = current.find((x) => x.record_id === record.record_id)?.evidence;
  const page = pages
    .filter((p) => websiteScope(p.url)?.domain === websiteScope(url)?.domain)
    .map((p) => ({ url: p.url, content: p.raw_content || '' }));
  const extracted = combineWebsiteEvidence(page, record.fields['国家'] || '');
  const unique = (items, key) => [...new Map(items.map((x) => [key(x), x])).values()];
  const evidence = {
    ...extracted,
    addresses: unique([...(local?.addresses || []), ...extracted.addresses], (x) =>
      [x.country, x.region, x.city, x.street].join('|'),
    ),
    social: unique([...(local?.social || []), ...extracted.social], (x) => x.platform + x.url),
    contacts: unique(
      [...(local?.contacts || []), ...extracted.contacts],
      (x) => x.kind + x.normalized,
    ),
    service_areas: unique(
      [...(local?.service_areas || []), ...extracted.service_areas],
      (x) => x.name,
    ),
    checked_urls: [...new Set([...(local?.checkedUrls || []), ...extracted.checked_urls])],
    snippets: [],
  };
  byRecord[record.record_id] = evidence;
  const result = enrichmentFields(
    JSON.parse(record.fields['画像JSON'] || '{}'),
    evidence,
    record.fields,
  );
  summaries.push({
    record_id: record.record_id,
    name: record.fields['公司名称'] || record.fields['客户名称'],
    phone: result.fields['电话'],
    email: result.fields['邮箱'],
    address: result.fields['详细地址'],
    areas: result.fields['服务地区'],
    social: evidence.social.map((x) => x.platform),
    profileLength: result.fields['画像JSON'].length,
  });
}
await fs.writeFile('artifacts/enrichment-backfill-plan.json', JSON.stringify(summaries, null, 2));
const code =
  enrichmentHelpers +
  '\nconst evidenceByRecord=' +
  JSON.stringify(byRecord) +
  `;
const b=$('备份客户记录').first().json.body;
if(b?.code!==0 || b.data?.has_more)throw new Error('现有客户读取不完整，停止补全');
const records=[];
for(const r of b.data.items){const e=evidenceByRecord[r.record_id];if(!e)continue;
 let profile;try{profile=JSON.parse(r.fields['画像JSON'] || '{}');}catch{throw new Error('客户画像无法解析：'+r.record_id);}
 const fields=enrichmentFields(profile,e,r.fields).fields;
 records.push({record_id:r.record_id,fields});}
return [{json:{records}}];`;
await fs.writeFile('artifacts/enrichment-backfill-code.txt', code);
console.log(
  JSON.stringify({
    codeFile: 'artifacts/enrichment-backfill-code.txt',
    summaryFile: 'artifacts/enrichment-backfill-plan.json',
    count: summaries.length,
  }),
);
