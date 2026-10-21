import fs from 'node:fs/promises';
import { researchPolicyCode } from './research-policy-code.mjs';
import {
  parseCompanyResearch,
  researchFields,
  companyResearchRequest,
  companyResearchSchema,
} from '../server/company-research.mjs';
import {
  websiteScope,
  planWebsitePages,
  extractCatalogProducts,
  extractWebsiteMetadata,
  combineWebsiteEvidence,
  websiteTextExcerpt,
} from '../server/website-metadata.mjs';
import { extractContacts } from '../server/contact-extractor.mjs';
import { phoneHelpers } from '../server/phone-format.mjs';
import { upgradePhoneWriteDecision } from '../server/n8n-contacts.mjs';
import { extractAdvertisingCodes } from '../server/advertising-codes.mjs';
import { researchPageText } from '../server/research-pages.mjs';
import { groupedMarkets, audienceTerms } from '../server/markets.mjs';
import acquisition from '../src/data/acquisition.json' with { type: 'json' };
const w = JSON.parse(
  await fs.readFile(process.argv[2] || 'artifacts/task-fields-workflow-before.json', 'utf8'),
);
const get = (name) => {
  const node = w.nodes.find((n) => n.name === name);
  if (!node) throw new Error('工作流快照缺少节点：' + name);
  return structuredClone(node);
};
const operations = [];
const replace = (nodeName, parameters) =>
  operations.push({ type: 'updateNodeParameters', nodeName, parameters, replace: true });
const config = get('配置搜索目标').parameters;
if (!config.jsonOutput.includes('customer_type:'))
  config.jsonOutput = config.jsonOutput.replace(
    '  customer_types: [],',
    '  customer_types: [],\n  customer_type: $json.body?.customer_type ?? "",\n  customer_profile: $json.body?.customer_profile ?? "all",',
  );
replace('配置搜索目标', config);
const ai = get('AI企业研究').parameters;
ai.responses.values[0].content = companyResearchRequest({}, {}).messages[0].content;
ai.options.textFormat.textOptions.schema = companyResearchSchema;
replace('AI企业研究', ai);
replace('解析结果', {
  mode: 'runOnceForAllItems',
  jsCode:
    researchPolicyCode +
    '\n' +
    parseCompanyResearch.toString() +
    '\nconst page=$("汇总官网证据").first().json;return [{json:parseCompanyResearch($input.first().json,page,$("配置搜索目标").first().json)}];',
});
const builderTail = get('构建飞书记录').parameters.jsCode.slice(
  get('构建飞书记录').parameters.jsCode.lastIndexOf("const r=$('最终结果')"),
);
if (!builderTail || !builderTail.includes('researchFields(r,evidence'))
  throw new Error('入库节点结构已变化');
const checkedBuilder = builderTail.includes('客户类型必须为单选字段')
  ? builderTail
  : builderTail.replace(
      'const key=/^https?',
      "for(const name of ['广告代码','需求产品','客户行业画像'])if(types[name]!==1)throw new Error('客户表缺少文本字段：'+name);if(types['客户类型']!==3)throw new Error('客户类型必须为单选字段');const key=/^https?",
    );
const gatedBuilder = checkedBuilder.replace(
  'const evidence=',
  "if(!r.ok || r.eligibility?.status!=='eligible')throw new Error('客户未通过全局准入判断');const evidence=",
);
if (gatedBuilder === checkedBuilder) throw new Error('无法定位入库准入关口');
replace('构建飞书记录', {
  mode: 'runOnceForAllItems',
  jsCode:
    phoneHelpers +
    '\n' +
    extractContacts.toString() +
    '\n' +
    researchFields.toString() +
    '\n' +
    gatedBuilder.replace(
      'researchFields(r,evidence)',
      "researchFields(r,evidence,{},$('汇总官网证据').first().json.research_pages||[])",
    ),
});
replace('判定写入方式', {
  mode: 'runOnceForAllItems',
  jsCode: upgradePhoneWriteDecision(get('判定写入方式').parameters.jsCode),
});
const planner = get('官网补全页面').parameters.jsCode;
const planTail = planner.slice(planner.lastIndexOf('const p=$input'));
if (!planTail.includes('planWebsitePages')) throw new Error('页面规划节点结构已变化');
replace('官网补全页面', {
  mode: 'runOnceForAllItems',
  jsCode: [websiteScope, planWebsitePages].map((f) => f.toString()).join('\n') + '\n' + planTail,
});
const evidence = get('汇总官网证据').parameters.jsCode;
const evidenceTail = evidence.slice(evidence.lastIndexOf("const p=$('检查正文')"));
if (!evidenceTail.includes('combineWebsiteEvidence')) throw new Error('证据汇总节点结构已变化');
// Prefer HTML evidence for each URL; only add markdown when HTML has no usable text.
const deduped = evidenceTail.includes('const researchPages=')
  ? evidenceTail
  : evidenceTail
      .replace(
        'const evidence=combineWebsiteEvidence(pages);',
        `const merged=new Map();for(const page of pages){const key=websiteScope(page.url)?.url||page.url;const prior=merged.get(key);if(!prior||!researchPageText(prior.content))merged.set(key,page);}const evidence=combineWebsiteEvidence(pages);const researchPages=[...merged.values()];`,
      )
      .replace('const research_pages=pages.filter', 'const research_pages=researchPages.filter');
replace('汇总官网证据', {
  mode: 'runOnceForAllItems',
  jsCode:
    phoneHelpers +
    '\n' +
    [
      websiteScope,
      extractContacts,
      extractAdvertisingCodes,
      extractCatalogProducts,
      extractWebsiteMetadata,
      combineWebsiteEvidence,
      websiteTextExcerpt,
      researchPageText,
    ]
      .map((f) => f.toString())
      .join('\n') +
    '\n' +
    deduped,
});
replace('展开市场国家', {
  mode: 'runOnceForAllItems',
  jsCode: `const cfg=$input.first().json;if(cfg.batch_mode==='discover')return [{json:{...cfg,search_country:cfg.search_country||cfg.country}}];const groups=${JSON.stringify(groupedMarkets)};const terms=${JSON.stringify(audienceTerms)};const acquisition=${JSON.stringify({ customerTypes: acquisition.customerTypes, profiles: acquisition.profiles })};const countries=groups[cfg.country]||[cfg.country];return countries.map(country=>({json:{...cfg,search_country:country,search_query:countries.length===1?cfg.search_query:[cfg.product,terms[cfg.audience||'BC'],acquisition.customerTypes.find(t=>t.value===cfg.customer_type)?.terms,acquisition.profiles.find(p=>p.value===cfg.customer_profile)?.terms,country].filter(Boolean).join(' ')}}));`,
});
// A research invocation builds exactly one company record. The loop performs one pass.
if (w.nodes.some((n) => n.name === '逐条写入')) {
  operations.push(
    { type: 'removeNode', nodeName: '逐条写入' },
    { type: 'addConnection', source: '构建飞书记录', target: '可查询?' },
    { type: 'addConnection', source: '核对写入结果', target: '入库汇总' },
  );
}
const schema = companyResearchSchema;
await fs.writeFile(
  'artifacts/customer-fields-operations.json',
  JSON.stringify(operations, null, 2),
);
await fs.writeFile(
  'artifacts/customer-fields-research-schema.json',
  JSON.stringify(schema, null, 2),
);
console.log(
  JSON.stringify({
    operations: operations.length,
    nodesBefore: w.nodes.length,
    nodesAfter: w.nodes.length - operations.filter((o) => o.type === 'removeNode').length,
  }),
);
