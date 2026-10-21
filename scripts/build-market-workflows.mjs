import fs from 'node:fs/promises';
import { groupedMarkets, audienceTerms } from '../server/markets.mjs';
import { enrichmentHelpers, websiteFetchParameters } from '../server/n8n-enrichment.mjs';
import { phoneHelpers } from '../server/phone-format.mjs';
import { extractContacts } from '../server/contact-extractor.mjs';
import { upgradePhoneWriteDecision } from '../server/n8n-contacts.mjs';
import { researchPageText } from '../server/research-pages.mjs';
import {
  companyResearchRequest,
  companyResearchSchema,
  parseCompanyResearch,
  researchFields,
} from '../server/company-research.mjs';
import { searchTargetConfig } from '../server/n8n-search-target.mjs';
import {
  recoveryPlanCode,
  recoveryCondition,
  recoveryExtractParameters,
} from '../server/n8n-recovery.mjs';
const w = JSON.parse(await fs.readFile('artifacts/market-workflow-before.json', 'utf8'));
const fields = JSON.parse(await fs.readFile('artifacts/market-fields-before.json', 'utf8'));
const get = (name) => structuredClone(w.nodes.find((n) => n.name === name));
const base =
  'https://open.feishu.cn/open-apis/bitable/v1/apps/X4pqbYS9CacppyscbhCcBeT5nmh/tables/tblM4fJJzczgx2bA';
const token = get('获取飞书Token');
const auth = { sendHeaders: true, headerParameters: get('读取表字段').parameters.headerParameters };
const code = (name, jsCode) => ({
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  parameters: { mode: 'runOnceForAllItems', jsCode },
});
const http = (name, parameters) => ({
  name,
  type: 'n8n-nodes-base.httpRequest',
  typeVersion: 4.4,
  parameters,
});
const options = {
  response: { response: { fullResponse: true, neverError: true } },
  timeout: 30000,
};
const jsonHttp = (name, url, method, jsonBody, extra = {}) =>
  http(name, {
    ...auth,
    method,
    url,
    sendBody: true,
    specifyBody: 'json',
    jsonBody,
    options,
    ...extra,
  });
const sdk = (nodes, connections, name) =>
  nodes
    .map(
      (n, i) =>
        `const n${i}=${n.type.includes('manualTrigger') ? 'trigger' : 'node'}(${JSON.stringify({ type: n.type, version: n.typeVersion, config: { name: n.name, parameters: n.parameters, ...(n.credentials ? { credentials: n.credentials } : {}) }, output: [{ json: {} }] })});`,
    )
    .join('\n') +
  '\nexport default workflow(' +
  JSON.stringify(name) +
  ',' +
  JSON.stringify(name) +
  ')' +
  nodes.map((n, i) => '.add(n' + i + ')').join('') +
  connections
    .map(
      ([a, b, si = 0, ti = 0]) =>
        `.add(n${nodes.findIndex((n) => n.name === a)}.output(${si}).to(n${nodes.findIndex((n) => n.name === b)}.input(${ti})))`,
    )
    .join('') +
  `.group('核验与入库',[${nodes
    .map((n, i) => (n.type.includes('manualTrigger') ? null : 'n' + i))
    .filter(Boolean)
    .join(',')}],{description:'读取证据、校验 AI 输出、按原记录身份写回并读回核验。'});`;
const drop = [
  '来源渠道',
  '城市',
  '画像JSON',
  '用户画像JSON',
  'YouTube',
  'X',
  'TikTok',
  'Pinterest',
  '社媒JSON',
  '服务地区JSON',
  '匹配状态',
];
const creates = [
  {
    field_name: '客户等级',
    type: 3,
    property: { options: ['A', 'B', 'C'].map((name, i) => ({ name, color: i })) },
  },
  { field_name: '主营产品偏好', type: 1 },
  { field_name: '服务客群', type: 1 },
].filter((f) => !fields.some((x) => x.field_name === f.field_name));
const schemaOps = creates.map((body) => ({ method: 'POST', url: base + '/fields', body }));
if (!fields.some((f) => f.field_name === '州 / 城市'))
  schemaOps.push({
    method: 'PUT',
    url: base + '/fields/' + fields.find((f) => f.field_name === '州').field_id,
    body: { field_name: '州 / 城市', type: 1 },
  });
const schemaNodes = [
  { name: '开始核验', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
  token,
  code('准备字段调整', `return ${JSON.stringify(schemaOps)}.map(json=>({json}));`),
  jsonHttp(
    '调整飞书字段',
    '={{ $json.url }}',
    '={{ $json.method }}',
    '={{ JSON.stringify($json.body) }}',
    { options: { ...options, batching: { batch: { batchSize: 1, batchInterval: 500 } } } },
  ),
  code(
    '核对字段调整',
    `for(const i of $input.all()){const b=i.json.body || i.json;if(b.code!==0)throw new Error('字段调整失败 '+JSON.stringify(b));}return [{json:{ready:true}}];`,
  ),
  http('读取当前记录', { ...auth, url: base + '/records?page_size=500', options }),
  code(
    '迁移显示字段',
    `const b=$input.first().json.body;if(b.code!==0 || b.data.has_more)throw new Error('记录不完整，停止迁移');const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?v.text || v.link || '':String(v??'');const types={installer:'安装商',distributor:'经销商 / 批发商',retailer:'零售商',contractor:'工程承包商',manufacturer:'制造商',unknown:'待核实'};return [{json:{records:b.data.items.map(r=>{const f=r.fields;let p={};try{p=JSON.parse(text(f['画像JSON'])||'{}')}catch{};const fields={};const loc=[text(f['州 / 城市'] || f['州']),text(f['城市'])].filter(Boolean);if(loc.length)fields['州 / 城市']=[...new Set(loc)].join(' · ');const type=text(f['客户类型']);if(types[type])fields['客户类型']=types[type];let areas=text(f['服务地区']);if(!areas || /^[\\[{]/.test(areas)){try{const a=JSON.parse(text(f['服务地区JSON'])||areas||'[]');areas=a.map(x=>typeof x==='string'?x:x.name).filter(Boolean).join('\\n')}catch{areas=''}}if(areas)fields['服务地区']=areas;return {record_id:r.record_id,fields};})}}];`,
  ),
  jsonHttp(
    '保存迁移值',
    base + '/records/batch_update',
    'POST',
    '={{ JSON.stringify({records:$json.records}) }}',
  ),
  code(
    '准备删除旧字段',
    `const b=$input.first().json.body;if(b.code!==0)throw new Error('迁移值写入失败，停止删除旧列');return ${JSON.stringify(fields.filter((f) => drop.includes(f.field_name)).map((f) => ({ field_id: f.field_id, field_name: f.field_name })))}.map(json=>({json}));`,
  ),
  http('删除旧字段', {
    ...auth,
    method: 'DELETE',
    url: '={{ ' + JSON.stringify(base + '/fields/') + ' + $json.field_id }}',
    options: { ...options, batching: { batch: { batchSize: 1, batchInterval: 500 } } },
  }),
  code(
    '迁移核对',
    `for(const i of $input.all()){const b=i.json.body||i.json;if(b.code!==0)throw new Error('旧列删除失败 '+JSON.stringify(b));}return [{json:{ok:true,deleted:$input.all().length}}];`,
  ),
];
const schemaConnections = schemaNodes.slice(1).map((n, i) => [schemaNodes[i].name, n.name]);
await fs.writeFile(
  'artifacts/market-schema-sdk.js',
  sdk(schemaNodes, schemaConnections, '飞书显示字段迁移'),
);
await fs.writeFile('artifacts/market-schema-nodes.json', JSON.stringify(schemaNodes));

export const prompt = companyResearchRequest({ source_url: '', page_text: '' }).messages[0].content;
const aiParameters = {
  resource: 'text',
  operation: 'response',
  modelId: { __rl: true, mode: 'id', value: 'gpt-5-mini' },
  responses: {
    values: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content:
          '={{ JSON.stringify({target:$("配置搜索目标").first().json,pages:$json.research_pages}) }}',
      },
    ],
  },
  simplify: false,
  options: {
    store: false,
    maxTokens: 10000,
    reasoning: { reasoningOptions: { effort: 'low', summary: 'none' } },
    textFormat: {
      textOptions: {
        type: 'json_schema',
        name: 'company_research',
        schema: companyResearchSchema,
        strict: true,
      },
    },
  },
};
const researchHelpers =
  phoneHelpers +
  '\n' +
  [extractContacts, parseCompanyResearch, researchFields].map((f) => f.toString()).join('\n');
const evidenceJs =
  enrichmentHelpers +
  '\n' +
  researchPageText.toString() +
  `\nconst p=$('检查正文').first().json;const plans=$('官网补全页面').all();const pages=$input.all().map((item,i)=>({url:plans[i]?.json.url,content:item.json.statusCode===200 ? item.json.body || item.json.html || '' : ''})).filter(x=>x.url&&typeof x.content==='string');const domain=websiteScope(p.source_url)?.domain;for(const x of ($('Tavily Extract').first().json.body || $('Tavily Extract').first().json).results || [])if(websiteScope(x.url)?.domain===domain)pages.push({url:x.url,content:x.raw_content || ''});const evidence=combineWebsiteEvidence(pages);const research_pages=pages.filter(p=>p.content).map(p=>({source_url:p.url,text:researchPageText(p.content,16000)}));return [{json:{...p,website_metadata:evidence,research_pages,page_text:research_pages.map(x=>x.text).join('\\n')}}];`;
const recoveredEvidenceJs = evidenceJs
  .replace('const pages=$input.all().map', 'const pages=$("读取官网HTML").all().map')
  .replace(
    'const evidence=combineWebsiteEvidence(pages);',
    `const recovery=$input.first().json;for(const x of (recovery.body||recovery).results||[])if(websiteScope(x.url)?.domain===domain)pages.push({url:x.url,content:x.raw_content||''});const evidence=combineWebsiteEvidence(pages);`,
  );
const parseJs =
  researchHelpers +
  `\nconst page=$('汇总官网证据').first().json;return [{json:parseCompanyResearch($input.first().json,page,$('配置搜索目标').first().json)}];`;
const builderJs =
  researchHelpers +
  `\nconst r=$('最终结果').first().json;const evidence=$('汇总官网证据').first().json.website_metadata;const b=$input.first().json.body||$input.first().json;if(b.code!==0 || b.data.has_more)throw new Error('字段读取失败');const types=Object.fromEntries(b.data.items.map(f=>[f.field_name,f.type]));const key=/^https?:\\/\\/([^/?#]+)/i.exec(r.source_url)?.[1]?.replace(/^www\\./,'');const raw={...researchFields(r,evidence),'来源链接':r.source_url,'主体类型':'企业'};const fields=Object.fromEntries(Object.entries(raw).filter(([name])=>types[name]));return [{json:{ready:true,website_key:key,source_url:r.source_url,company_name:r.company_name,insert_fields:{...fields,customer_id:'web_'+key,'首次发现时间':Date.now()},update_fields:fields,new_customer_id:'web_'+key}}];`;
const mergeJs = `const rec=$('可查询?').first().json;const r=$input.first().json;const b=r.body||r;const result=(action,extra={})=>[{json:{...rec,action,...extra}}];if(b.code!==0 || b.data?.has_more)return result('failed',{reason:'身份查询不完整'});const text=v=>Array.isArray(v)?v.map(text).join(''):v&&typeof v==='object'?v.text||v.link||'':String(v??'');const key=u=>/^https?:\\/\\/([^/?#]+)/i.exec(text(u))?.[1]?.toLowerCase().replace(/^www\\./,'')||'';const exact=(b.data.items||[]).filter(x=>key(x.fields['来源链接'])===rec.website_key);if(exact.length>1)return result('manual_review',{reason:'同域名多行，暂停覆盖'});if(!exact.length)return result('insert');const old=exact[0],fields={...rec.update_fields};for(const name of ['邮箱','电话','Facebook','Instagram','LinkedIn','WhatsApp'])if(fields[name])fields[name]=[...new Set([...text(old.fields[name]).split('\\n'),...text(fields[name]).split('\\n')].filter(Boolean))].join('\\n');return result('update',{record_id:old.record_id,update_fields:fields,customer_id:text(old.fields.customer_id)||rec.new_customer_id});`;
const updates = {
  配置搜索目标: { ...get('配置搜索目标').parameters, jsonOutput: searchTargetConfig },
  官网补全页面: {
    mode: 'runOnceForAllItems',
    jsCode:
      enrichmentHelpers +
      `\nconst p=$input.first().json;const ex=$('Tavily Extract').first().json;const content=((ex.body||ex).results||[]).map(x=>x.raw_content||'').join('\\n');return planWebsitePages(p.source_url,content).map(url=>({json:{url}}));`,
  },
  汇总官网证据: { mode: 'runOnceForAllItems', jsCode: recoveredEvidenceJs },
  解析结果: { mode: 'runOnceForAllItems', jsCode: parseJs },
  最终结果: { mode: 'raw', jsonOutput: '={{ JSON.stringify($json) }}', options: {} },
  构建飞书记录: { mode: 'runOnceForAllItems', jsCode: builderJs },
  判定写入方式: { mode: 'runOnceForAllItems', jsCode: upgradePhoneWriteDecision(mergeJs) },
};
const marketPlan = code(
  '展开市场国家',
  `const p=$input.first().json;const groups=${JSON.stringify(groupedMarkets)};const terms=${JSON.stringify(audienceTerms)};const countries=groups[p.country]||[p.country];return countries.map(country=>({json:{...p,search_country:country,search_query:countries.length===1?p.search_query:[p.product,terms[p.audience||'BC'],country].filter(Boolean).join(' ')}}));`,
);
const operations = Object.entries(updates).map(([nodeName, parameters]) => ({
  type: 'updateNodeParameters',
  nodeName,
  parameters,
  replace: true,
}));
operations.push(
  { type: 'addNode', node: marketPlan },
  { type: 'removeConnection', source: '整理已知域名', target: 'Tavily Search' },
  { type: 'addConnection', source: '整理已知域名', target: '展开市场国家' },
  { type: 'addConnection', source: '展开市场国家', target: 'Tavily Search' },
  {
    type: 'addNode',
    node: {
      name: 'AI企业研究',
      type: '@n8n/n8n-nodes-langchain.openAi',
      typeVersion: 2.3,
      parameters: aiParameters,
    },
  },
  { type: 'removeConnection', source: '汇总官网证据', target: '调用Dify Workflow' },
  { type: 'removeConnection', source: '调用Dify Workflow', target: '解析结果' },
  { type: 'addConnection', source: '汇总官网证据', target: 'AI企业研究' },
  { type: 'addConnection', source: 'AI企业研究', target: '解析结果' },
  { type: 'removeNode', nodeName: '调用Dify Workflow' },
);
const recoveryNodes = [
  code('检查新增与失败页面', recoveryPlanCode('官网补全页面', '读取官网HTML', '检查正文')),
  {
    name: '需要补抓官网页面?',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    parameters: recoveryCondition,
  },
  {
    name: '补抓官网页面',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    parameters: recoveryExtractParameters(get('Tavily Extract').parameters),
    credentials: get('Tavily Extract').credentials,
  },
];
operations.push(
  ...recoveryNodes.map((node) => ({ type: 'addNode', node })),
  { type: 'removeConnection', source: '读取官网HTML', target: '汇总官网证据' },
  { type: 'addConnection', source: '读取官网HTML', target: '检查新增与失败页面' },
  { type: 'addConnection', source: '检查新增与失败页面', target: '需要补抓官网页面?' },
  { type: 'addConnection', source: '需要补抓官网页面?', target: '补抓官网页面', sourceIndex: 0 },
  { type: 'addConnection', source: '需要补抓官网页面?', target: '汇总官网证据', sourceIndex: 1 },
  { type: 'addConnection', source: '补抓官网页面', target: '汇总官网证据' },
  {
    type: 'setNodeSettings',
    nodeName: '补抓官网页面',
    settings: { onError: 'continueRegularOutput' },
  },
  {
    type: 'setNodeGroups',
    nodeGroups: [
      {
        name: '自动获客与客户入库',
        description: '按市场和客群搜索，补读官网证据，研究主营产品后去重写入飞书。',
        nodeNames: w.nodes
          .filter(
            (n) =>
              !n.type.includes('Trigger') &&
              !n.type.includes('webhook') &&
              n.name !== '调用Dify Workflow',
          )
          .map((n) => n.name)
          .concat(['展开市场国家', 'AI企业研究', ...recoveryNodes.map((n) => n.name)]),
      },
    ],
  },
);
await fs.writeFile('artifacts/market-main-operations.json', JSON.stringify(operations));
await fs.writeFile(
  'artifacts/market-research-parameters.json',
  JSON.stringify({ aiParameters, evidenceJs, parseJs, researchHelpers }),
);
console.log(JSON.stringify({ schemaNodes: schemaNodes.length, updates: operations.length }));
