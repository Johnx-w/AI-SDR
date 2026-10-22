import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { connectionEnvironment } from '../server/api-connections.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';

const env = connectionEnvironment();
const client = new FeishuClient({ env });
const fields = await client.fields();
const legacy = fields.find((field) => field.field_name === '客户名称');
const current = fields.find((field) => field.field_name === '公司名称');
if (legacy && current) throw new Error('存在两个名称字段，停止自动迁移');
const field = legacy || current;
if (!field || field.type !== 1) throw new Error('名称字段不是预期的文本字段');
if (!process.argv.includes('--apply')) {
  console.log(
    JSON.stringify({
      fieldId: field.field_id,
      from: field.field_name,
      to: '公司名称',
      pending: Boolean(legacy),
    }),
  );
  process.exit(0);
}
const records = await client.records();
const at = new Date().toISOString();
const backup = '.data/backups/company-name-field-' + at.replace(/[:.]/g, '-') + '.json';
mkdirSync('.data/backups', { recursive: true });
writeFileSync(
  backup,
  JSON.stringify({ at, tableId: env.FEISHU_TABLE_ID, fields, records }, null, 2),
);
if (legacy) {
  try {
    await client.request(client.tablePath() + '/fields/' + encodeURIComponent(field.field_id), {
      method: 'PUT',
      body: { field_name: '公司名称', type: field.type },
    });
  } catch (error) {
    // A lost write response is reconciled by field id; never create another field.
    const actual = (await client.fields()).find((value) => value.field_id === field.field_id);
    if (actual?.field_name !== '公司名称' || actual.type !== field.type) throw error;
  }
}
const afterFields = await client.fields();
const after = await client.records();
assert.equal(afterFields.find((f) => f.field_id === field.field_id)?.field_name, '公司名称');
assert.equal(afterFields.length, fields.length);
assert.equal(after.length, records.length);
const byId = new Map(after.map((record) => [record.record_id, record]));
for (const before of records) {
  const expected = { ...before.fields };
  if (Object.hasOwn(expected, '客户名称')) {
    expected['公司名称'] = expected['客户名称'];
    delete expected['客户名称'];
  }
  assert.deepEqual(byId.get(before.record_id)?.fields, expected);
}
console.log(
  JSON.stringify({
    renamed: Boolean(legacy),
    fieldId: field.field_id,
    fieldCount: afterFields.length,
    verifiedRecords: after.length,
    backup,
  }),
);
