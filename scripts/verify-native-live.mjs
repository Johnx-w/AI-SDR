import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';
import { fieldText } from '../server/feishu.mjs';
import { websiteUrl } from '../server/branding.mjs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { connectionEnvironment } from '../server/api-connections.mjs';
const env = connectionEnvironment();

// This check uses real search/model credits, and blocks all Feishu writes at the network boundary.
const readonlyFetch = (url, options = {}) => {
  const target = new URL(url);
  if (
    target.hostname === 'open.feishu.cn' &&
    target.pathname.includes('/bitable/') &&
    (options.method || 'GET') !== 'GET'
  )
    throw new Error('验收脚本禁止真实飞书写入');
  return fetch(url, options);
};
const client = new FeishuClient({ env, fetchImpl: readonlyFetch });
const records = await client.records();
const usable = records.filter((record) => {
  const url = websiteUrl(fieldText(record.fields?.['来源链接']));
  return url && !/eventbrite|facebook|linkedin|directory/i.test(url.hostname);
});
const record =
  usable.find((r) => /usmotions\.com/.test(fieldText(r.fields['来源链接']))) || usable[0];
if (!record) throw new Error('没有可用于只读复核的现有官网客户');
let proposed,
  simulatedWrites = 0;
const feishu = {
  records: () => client.records(),
  fields: () => client.fields(),
  write: async (action, fields, recordId) => {
    if (action !== 'update' || recordId !== record.record_id)
      throw new Error('只允许模拟复核原记录');
    simulatedWrites++;
    proposed = { record_id: recordId, fields: { ...record.fields, ...fields } };
    return proposed;
  },
  record: async () => proposed,
};
const service = new NativeAcquisition({
  env: { ...env, ACQUISITION_DB_PATH: '.data/native-verification.sqlite' },
  fetchImpl: readonlyFetch,
  feishu,
});
const input = {
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens',
  audience: 'BC',
  customer_type: '',
  customer_profile: 'all',
  search_query: 'outdoor zip screens Florida',
  acquisition_channel: 'tavily_web',
};
try {
  const found = await service.discover(input, { query: input.search_query });
  const result = await service.research(input, {
    source_url: fieldText(record.fields['来源链接']),
    target_record_id: record.record_id,
    operation_id: 'verify-' + randomUUID(),
  });
  const after = await client.records();
  const originalAfter = after.find((r) => r.record_id === record.record_id);
  const report = {
    mode: 'read-only-with-simulated-write',
    checkedAt: new Date().toISOString(),
    newCandidates: found.candidates.length,
    skippedExisting: found.skipped_existing_count,
    researchOutcome: result.outcome,
    simulatedWrites,
    realWrites: 0,
    sourceUrl: fieldText(record.fields['来源链接']),
    recordId: record.record_id,
    countsUnchanged: after.length === records.length,
    originalRecordUnchanged:
      JSON.stringify(originalAfter?.fields) === JSON.stringify(record.fields),
    fieldNames: Object.keys(proposed?.fields || {}),
    research: result.research,
    reason: result.reason,
  };
  await writeFile('.data/native-verification.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, research: undefined }));
  if (result.更新 !== 1 || !report.countsUnchanged || !report.originalRecordUnchanged)
    process.exitCode = 1;
} finally {
  service.close();
}
