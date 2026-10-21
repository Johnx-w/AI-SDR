import fs from 'node:fs/promises';
import { phoneHelpers } from '../server/phone-format.mjs';
import { extractContacts } from '../server/contact-extractor.mjs';
import { researchFields } from '../server/company-research.mjs';
import { upgradePhoneWriteDecision } from '../server/n8n-contacts.mjs';
import {
  websiteScope,
  extractCatalogProducts,
  extractWebsiteMetadata,
  combineWebsiteEvidence,
  websiteTextExcerpt,
} from '../server/website-metadata.mjs';
import { extractAdvertisingCodes } from '../server/advertising-codes.mjs';
import { researchPageText } from '../server/research-pages.mjs';

const workflow = JSON.parse(
  await fs.readFile(process.argv[2] || 'artifacts/phone-workflow-before.json', 'utf8'),
);
const get = (name) => {
  const node = workflow.nodes.find((n) => n.name === name);
  if (!node) throw new Error('缺少节点：' + name);
  return node.parameters.jsCode;
};
const evidence = get('汇总官网证据');
const evidenceTail = evidence.slice(evidence.lastIndexOf("const p=$('检查正文')"));
const builder = get('构建飞书记录');
const builderTail = builder.slice(builder.lastIndexOf("const r=$('最终结果')"));
if (
  !evidenceTail.includes('combineWebsiteEvidence') ||
  !builderTail.includes('researchFields(r,evidence')
)
  throw new Error('线上节点结构已变化');
const code = (nodeName, jsCode) => ({
  type: 'updateNodeParameters',
  nodeName,
  replace: true,
  parameters: { mode: 'runOnceForAllItems', jsCode },
});
const operations = [
  code(
    '汇总官网证据',
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
        .map((fn) => fn.toString())
        .join('\n') +
      '\n' +
      evidenceTail,
  ),
  code(
    '构建飞书记录',
    phoneHelpers +
      '\n' +
      extractContacts.toString() +
      '\n' +
      researchFields.toString() +
      '\n' +
      builderTail.replace(
        'researchFields(r,evidence)',
        "researchFields(r,evidence,{},$('汇总官网证据').first().json.research_pages||[])",
      ),
  ),
  code('判定写入方式', upgradePhoneWriteDecision(get('判定写入方式'))),
];
const configNode = workflow.nodes.find((node) => node.name === '配置搜索目标');
const config = structuredClone(configNode.parameters);
if (!config.jsonOutput.includes('phone_only:')) {
  const marker = "  target_record_id: $json.body?.target_record_id ?? '',";
  if (!config.jsonOutput.includes(marker)) throw new Error('缺少存量客户记录 ID 保护');
  config.jsonOutput = config.jsonOutput.replace(
    marker,
    marker + '\n  phone_only: $json.body?.phone_only === true,',
  );
}
operations.push({
  type: 'updateNodeParameters',
  nodeName: '配置搜索目标',
  replace: true,
  parameters: config,
});
const recordOperation = operations.find((op) => op.nodeName === '构建飞书记录');
if (!recordOperation.parameters.jsCode.includes('仅更新电话必须指定原记录')) {
  recordOperation.parameters.jsCode = recordOperation.parameters.jsCode.replace(
    'const fields=Object.fromEntries(Object.entries(raw).filter(([name])=>types[name]));',
    "const cfg=$('配置搜索目标').first().json;if(cfg.phone_only&&!cfg.target_record_id)throw new Error('仅更新电话必须指定原记录');const fields=Object.fromEntries(Object.entries(raw).filter(([name])=>types[name]&&(!cfg.phone_only||name==='电话')));",
  );
  if (!recordOperation.parameters.jsCode.includes('仅更新电话必须指定原记录'))
    throw new Error('未找到预期的字段筛选入口');
}
await fs.writeFile('artifacts/phone-workflow-operations.json', JSON.stringify(operations, null, 2));
console.log(JSON.stringify({ operations: operations.map((o) => o.nodeName) }));
