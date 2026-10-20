// Generate a reviewable atomic patch from a fresh snapshot of the current workflow.
import fs from 'node:fs/promises';
const w = JSON.parse(await fs.readFile('artifacts/batch-workflow-before.json', 'utf8'));
const get = (name) => structuredClone(w.nodes.find((n) => n.name === name));
const operations = [];
const param = (name, parameters) =>
  operations.push({ type: 'updateNodeParameters', nodeName: name, parameters });
const link = (source, target, sourceIndex = 0) =>
  operations.push({ type: 'addConnection', source, target, sourceIndex });
const unlink = (source, target, sourceIndex = 0) =>
  operations.push({ type: 'removeConnection', source, target, sourceIndex });
const add = (name, type, version, parameters, x, y) =>
  operations.push({
    type: 'addNode',
    node: { name, type, typeVersion: version, parameters, position: [x, y] },
  });
const condition = (expr) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      {
        id: 'batch-condition',
        leftValue: `={{ ${expr} }}`,
        rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      },
    ],
    combinator: 'and',
  },
  options: {},
});
const cfg = get('配置搜索目标').parameters;
cfg.jsonOutput = cfg.jsonOutput.replace(
  'country: $json.body?.country',
  `batch_mode: $json.body?.batch_mode ?? 'legacy',
  operation_id: $json.body?.operation_id ?? '',
  source_url: $json.body?.source_url ?? '',
  source_title: $json.body?.source_title ?? '',
  search_country: $json.body?.search_country ?? '',
  exclude_domains: Array.isArray($json.body?.exclude_domains) ? $json.body.exclude_domains.slice(0,150) : [],
  country: $json.body?.country`,
);
param('配置搜索目标', cfg);
add(
  '批量结果查询?',
  'n8n-nodes-base.if',
  2.2,
  condition(`$json.batch_mode === 'status'`),
  400,
  -400,
);
add(
  '读取批量处理结果',
  'n8n-nodes-base.code',
  2,
  {
    mode: 'runOnceForAllItems',
    jsCode: `const id=$input.first().json.operation_id;const cache=$getWorkflowStaticData('global').batch_results||{};return [{json:{settled:!!cache[id],output:cache[id]||null}}];`,
  },
  640,
  -600,
);
unlink('配置搜索目标', '获取飞书Token');
link('配置搜索目标', '批量结果查询?');
link('批量结果查询?', '读取批量处理结果');
link('批量结果查询?', '获取飞书Token', 1);
add(
  '指定企业研究?',
  'n8n-nodes-base.if',
  2.2,
  condition(`$json.batch_mode === 'research'`),
  1100,
  -200,
);
unlink('整理已知域名', '展开市场国家');
link('整理已知域名', '指定企业研究?');
link('指定企业研究?', '选择一个独立企业官网');
link('指定企业研究?', '展开市场国家', 1);
const expand = get('展开市场国家').parameters;
expand.jsCode =
  `const cfg=$input.first().json;if(cfg.batch_mode==='discover')return [{json:{...cfg,search_country:cfg.search_country||cfg.country}}];\n` +
  expand.jsCode;
param('展开市场国家', expand);
const search = get('Tavily Search').parameters;
search.jsonBody = search.jsonBody.replace(
  'auto_parameters: false',
  'auto_parameters: false, exclude_domains: $json.exclude_domains || []',
);
param('Tavily Search', search);
const selection = get('选择一个独立企业官网').parameters;
selection.jsCode = selection.jsCode
  .replace('const MAX = 3;', `const MAX = config.batch_mode==='discover' ? 20 : 3;`)
  .replace(
    "const includeSocial = config.include_social !== false && config.include_social !== 'false';",
    'const includeSocial = false;',
  )
  .replace(
    'const inputs =',
    `if(config.batch_mode==='research') {
    const match=/^https?:\\/\\/([^/?#]+)(?:[/?#]|$)/i.exec(config.source_url||'');
    const host=match?.[1]?.toLowerCase().replace(/^www\\./,'');
    if(!host || host.includes('@') || !host.includes('.') || /[:\\d]$/.test(host))throw new Error('研究网址无效');
    if(knownDomains.has(host))return [{json:{found:false,stage:'select',skipped_existing_count:1,skipped_existing:[{domain:host,url:config.source_url}],reason:'该企业已在飞书收录，已跳过'}}];
    const c={found:true,source_url:config.source_url,source_title:config.source_title||'',source_kind:'website'};
    return [{json:{...c,candidates:[c],candidate_urls:[c.source_url]}}];
  }
  const inputs =`,
  );
param('选择一个独立企业官网', selection);
add(
  '仅发现候选?',
  'n8n-nodes-base.if',
  2.2,
  condition(`$('配置搜索目标').first().json.batch_mode === 'discover'`),
  1700,
  -200,
);
add(
  '返回候选队列',
  'n8n-nodes-base.code',
  2,
  {
    mode: 'runOnceForAllItems',
    jsCode: `const r=$input.first().json;const search=$('Tavily Search').first().json;const b=search.body||search;if(b.error||b.detail)throw new Error('Tavily 搜索失败');return [{json:{candidates:r.candidates||[],skipped_existing:r.skipped_existing||[],reason:r.reason||'',execution_id:$execution.id}}];`,
  },
  1960,
  -400,
);
unlink('选择一个独立企业官网', '找到官网?');
link('选择一个独立企业官网', '仅发现候选?');
link('仅发现候选?', '返回候选队列');
link('仅发现候选?', '找到官网?', 1);
const summary = get('入库汇总').parameters;
summary.jsCode = summary.jsCode
  .replace('return [{json: summarizeAcquisition(', 'const result=summarizeAcquisition(')
  .replace(
    '$execution.id)}];',
    `$execution.id);
const cfg=$('配置搜索目标').first().json;
if(cfg.batch_mode==='research' && cfg.operation_id){const state=$getWorkflowStaticData('global');state.batch_results=state.batch_results||{};state.batch_results[cfg.operation_id]=result;const keys=Object.keys(state.batch_results);for(const key of keys.slice(0,-1000))delete state.batch_results[key];}
return [{json:result}];`,
  );
param('入库汇总', summary);
operations.push({
  type: 'setWorkflowSettings',
  settings: {
    executionTimeout: 180,
    saveDataSuccessExecution: 'all',
    saveDataErrorExecution: 'all',
  },
});
operations.push({
  type: 'setNodeGroups',
  nodeGroups: [
    {
      name: '批量发现、官网研究与入库',
      description: '分别处理候选发现、独立企业研究和结果核对；本机后台按新增目标调度并去重。',
      nodeNames: w.nodes
        .filter((n) => !['n8n-nodes-base.webhook', 'n8n-nodes-base.manualTrigger'].includes(n.type))
        .map((n) => n.name)
        .concat(operations.filter((o) => o.type === 'addNode').map((o) => o.node.name)),
    },
  ],
});
await fs.writeFile('artifacts/batch-workflow-operations.json', JSON.stringify(operations, null, 2));
console.log(
  JSON.stringify({
    operations: operations.length,
    added: operations.filter((o) => o.type === 'addNode').map((o) => o.node.name),
  }),
);
