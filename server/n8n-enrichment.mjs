import { extractContacts } from './contact-extractor.mjs';
import { phoneHelpers } from './phone-format.mjs';
import { extractAdvertisingCodes } from './advertising-codes.mjs';
import {
  websiteScope,
  extractCatalogProducts,
  extractWebsiteMetadata,
  planWebsitePages,
  combineWebsiteEvidence,
  enrichmentFields,
  websiteTextExcerpt,
} from './website-metadata.mjs';

export const enrichmentHelpers =
  phoneHelpers +
  '\n' +
  [
    websiteScope,
    extractCatalogProducts,
    extractContacts,
    extractAdvertisingCodes,
    extractWebsiteMetadata,
    planWebsitePages,
    combineWebsiteEvidence,
    enrichmentFields,
    websiteTextExcerpt,
  ]
    .map((fn) => fn.toString())
    .join('\n');
export const newFeishuFields = ['详细地址', '服务地区', 'Facebook', 'Instagram', 'LinkedIn'];
export const websiteFetchParameters = {
  url: '={{ $json.url }}',
  options: {
    redirect: { redirect: { followRedirects: false } },
    response: {
      response: {
        responseFormat: 'text',
        outputPropertyName: 'html',
        fullResponse: true,
        neverError: true,
      },
    },
    timeout: 12000,
  },
};
export const pagePlanCode = `${enrichmentHelpers}\nconst p=$input.first().json; return planWebsitePages(p.source_url,p.page_text).map(url=>({json:{url}}));`;
export const evidenceCode = `${enrichmentHelpers}
const p=$('检查正文').first().json;
const plans=$('官网补全页面').all();
const pages=$input.all().map((item,i)=>({url:plans[i]?.json.url,content:(item.json.statusCode===200 ? item.json.body || item.json.html : '') || ''})).filter(x=>x.url && typeof x.content==='string');
const domain=websiteScope(p.source_url)?.domain;
for(const x of ($('Tavily Extract').first().json.body || $('Tavily Extract').first().json).results || []) if(websiteScope(x.url)?.domain===domain) pages.push({url:x.url,content:x.raw_content || ''});
const evidence=combineWebsiteEvidence(pages);
const supplement=evidence.snippets.map(x=>'官网结构化数据 来源 '+x.source_url+'\\n'+x.text).join('\\n');
return [{json:{...p,page_text:p.page_text+'\\n'+supplement,website_metadata:evidence,fallback_urls:plans.map(x=>x.json.url).filter(u=>u!==websiteScope(p.source_url)?.url).slice(0,2)}}];`;

export const mergeSupplementCode = `${enrichmentHelpers}
const p=$('汇总官网证据').first().json;
const domain=websiteScope(p.source_url)?.domain;
const extra=($input.first().json.body || $input.first().json).results || [];
const pages=extra.filter(x=>websiteScope(x.url)?.domain===domain).map(x=>({url:x.url,content:x.raw_content || ''}));
const e=combineWebsiteEvidence(pages,p.website_metadata.addresses[0]?.country || '');
const prior=p.website_metadata;
const unique=(items,key)=>[...new Map(items.map(x=>[key(x),x])).values()];
const rank=a=>a.method==='json_ld'?3:a.method==='map_address_link'?2:1;
const addresses=unique([...prior.addresses,...e.addresses].sort((a,b)=>rank(a)-rank(b)),x=>[x.country,x.region,x.city,x.street].join('|')).sort((a,b)=>rank(b)-rank(a));
const evidence={...prior,contacts:unique([...prior.contacts,...e.contacts],x=>x.kind+':'+x.normalized),addresses,social:unique([...prior.social,...e.social],x=>x.platform+':'+x.url),service_areas:unique([...prior.service_areas,...e.service_areas],x=>x.name),checked_urls:[...new Set([...prior.checked_urls,...e.checked_urls])],snippets:[]};
const supplement=pages.map(x=>'官网补充页 来源 '+x.url+'\\n'+websiteTextExcerpt(x.content,8000)).join('\\n');
return [{json:{...p,page_text:p.page_text+'\\n'+supplement,website_metadata:evidence}}];`;

export function upgradeRecordBuilder(original) {
  if (original.includes('WEBSITE_ENRICHMENT_V3')) throw new Error('Already enriched');
  // Replace the legacy embedded extractor as well, so it cannot shadow the current shared rules.
  const legacyStart = original.indexOf('function extractContacts(');
  const legacyEnd = original.indexOf('function hostKey(', legacyStart);
  if (legacyStart >= 0 && legacyEnd > legacyStart)
    original = original.slice(0, legacyStart) + original.slice(legacyEnd);
  const start = original.indexOf('  const foundContacts =');
  const end = original.indexOf('  const target =', start);
  if (start < 0 || end < 0 || !original.includes('const fields={};'))
    throw new Error('Unexpected record builder');
  return (
    'const WEBSITE_ENRICHMENT_V3 = true;\n' +
    enrichmentHelpers +
    '\n' +
    original.slice(0, start) +
    `  const evidence=$('归并官网补全').first().json.website_metadata;
  const contacts=evidence.contacts;
  const emails=contacts.filter(c=>c.kind==='email').map(c=>c.value);
  const phones=contacts.filter(c=>c.kind==='phone').map(c=>c.value);
` +
    original.slice(end).replace(
      '  const fields={};',
      `  Object.assign(raw,enrichmentFields(profile,evidence).fields);
  const fields={};`,
    )
  );
}

export function upgradeExistingMerge(original) {
  if (!original.includes("return result('update'")) throw new Error('Unexpected merge node');
  return (
    enrichmentHelpers +
    '\n' +
    original.replace(
      "return result('update'",
      `if(fields['画像JSON']) {
  const current=JSON.parse(fields['画像JSON']);
  let previous={}; try { previous=JSON.parse(asText(of['画像JSON']) || '{}'); } catch {}
  const base={...previous,...current,website_metadata:previous.website_metadata,latest_research:{...current.latest_research,contact_evidence:[...(previous.latest_research?.contact_evidence || []),...(current.latest_research?.contact_evidence || [])]}};
  const enhanced=enrichmentFields(base,current.website_metadata || {social:[],addresses:[],contacts:[],service_areas:[]},of);
  Object.assign(fields,enhanced.fields);
}
return result('update'`,
    )
  );
}
