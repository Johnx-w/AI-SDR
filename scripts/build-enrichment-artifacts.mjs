import fs from 'node:fs/promises';
import {
  newFeishuFields,
  pagePlanCode,
  evidenceCode,
  mergeSupplementCode,
  websiteFetchParameters,
  upgradeRecordBuilder,
  upgradeExistingMerge,
} from '../server/n8n-enrichment.mjs';
const before = JSON.parse(await fs.readFile('artifacts/enrichment-workflow-before.json', 'utf8'));
const get = (name) => structuredClone(before.nodes.find((n) => n.name === name));
const base =
  'https://open.feishu.cn/open-apis/bitable/v1/apps/X4pqbYS9CacppyscbhCcBeT5nmh/tables/tblM4fJJzczgx2bA';
const token = get('获取飞书Token');
const headers = get('读取表字段').parameters;
const configs = [
  { type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: '手动维护' } },
  {
    type: token.type,
    version: token.typeVersion,
    config: { name: token.name, parameters: token.parameters, credentials: token.credentials },
  },
  {
    type: 'n8n-nodes-base.httpRequest',
    version: 4.5,
    config: { name: '读取字段', parameters: headers },
  },
  {
    type: 'n8n-nodes-base.code',
    version: 2,
    config: {
      name: '检查缺少字段',
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode: `const b=$input.first().json.body;if(b?.code!==0 || b.data?.has_more)throw new Error('表字段读取未完整成功');const fields=b.data.items.map(f=>f.field_name);const missing=${JSON.stringify(newFeishuFields)}.filter(f=>!fields.includes(f)); return missing.map(field_name=>({json:{field_name,type:1}}));`,
      },
    },
  },
  {
    type: 'n8n-nodes-base.httpRequest',
    version: 4.5,
    config: {
      name: '新增飞书字段',
      parameters: {
        ...headers,
        method: 'POST',
        url: base + '/fields',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json) }}',
        options: { ...headers.options, batching: { batch: { batchSize: 1, batchInterval: 500 } } },
      },
    },
  },
  {
    type: 'n8n-nodes-base.code',
    version: 2,
    config: {
      name: '检查建列结果',
      parameters: {
        mode: 'runOnceForAllItems',
        jsCode:
          'const responses=$input.all().map(x=>x.json.body||x.json);if(responses.some(x=>x.code!==0))throw new Error(JSON.stringify(responses));return [{json:{created:responses.map(x=>x.data.field.field_name)}}];',
      },
    },
  },
  {
    type: 'n8n-nodes-base.httpRequest',
    version: 4.5,
    config: {
      name: '备份客户记录',
      parameters: { ...headers, url: base + '/records?page_size=500' },
    },
  },
];
const lines = configs
  .map((c, i) => `const n${i}=${i === 0 ? 'trigger' : 'node'}(${JSON.stringify(c)});`)
  .join('\n');
const code = `import {workflow,node,trigger} from '@n8n/workflow-sdk';\n${lines}\nexport default workflow('shadeflow-maintenance','ShadeFlow 官网信息补全维护').add(n0)${configs
  .slice(1)
  .map((_, i) => `.to(n${i + 1})`)
  .join(
    '',
  )}.group('飞书字段与备份',[n1,n2,n3,n4,n5,n6],{description:'按需新建地址、服务地区和社媒列，保留原客户数据备份'});`;
await fs.writeFile('artifacts/enrichment-maintenance-sdk.js', code);
const nodes = [
  {
    name: '官网补全页面',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { mode: 'runOnceForAllItems', jsCode: pagePlanCode },
    position: [1330, 360],
  },
  {
    name: '读取官网HTML',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.5,
    parameters: websiteFetchParameters,
    position: [1530, 360],
  },
  {
    name: '汇总官网证据',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { mode: 'runOnceForAllItems', jsCode: evidenceCode },
    position: [1730, 360],
  },
  {
    ...get('Tavily Extract'),
    id: undefined,
    name: '补充官网联系页',
    parameters: {
      ...get('Tavily Extract').parameters,
      jsonBody:
        '={{ JSON.stringify({urls:$json.fallback_urls.length ? $json.fallback_urls : [$json.source_url],extract_depth:"basic",format:"markdown"}) }}',
    },
    position: [1930, 360],
  },
  {
    name: '归并官网补全',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    parameters: { mode: 'runOnceForAllItems', jsCode: mergeSupplementCode },
    position: [2130, 360],
  },
];
const operations = nodes.map((node) => ({ type: 'addNode', node }));
operations.push({
  type: 'setNodeSettings',
  nodeName: '读取官网HTML',
  settings: { onError: 'continueRegularOutput' },
});
operations.push({
  type: 'removeConnection',
  source: '正文有效?',
  sourceIndex: 0,
  target: '调用Dify Workflow',
  targetIndex: 0,
});
for (const [source, target] of [
  ['正文有效?', '官网补全页面'],
  ['官网补全页面', '读取官网HTML'],
  ['读取官网HTML', '汇总官网证据'],
  ['汇总官网证据', '补充官网联系页'],
  ['补充官网联系页', '归并官网补全'],
  ['归并官网补全', '调用Dify Workflow'],
])
  operations.push({ type: 'addConnection', source, target, sourceIndex: 0, targetIndex: 0 });
operations.push({
  type: 'addNodeGroup',
  name: '官网地址联系与服务范围',
  nodeNames: nodes.map((n) => n.name),
  description: '读取官网HTML与原始正文，独立提取实际地址、公开联系方式、社媒与服务地区',
});
for (const [name, fn] of [
  ['构建飞书记录', upgradeRecordBuilder],
  ['判定写入方式', upgradeExistingMerge],
]) {
  const n = get(name);
  operations.push({
    type: 'updateNodeParameters',
    nodeName: name,
    replace: true,
    parameters: { ...n.parameters, jsCode: fn(n.parameters.jsCode) },
  });
}
await fs.writeFile('artifacts/enrichment-operations.json', JSON.stringify(operations));
console.log(
  JSON.stringify({
    sdk: 'artifacts/enrichment-maintenance-sdk.js',
    operations: 'artifacts/enrichment-operations.json',
    nodes: nodes.length,
  }),
);
