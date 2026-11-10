import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectionEnvironment } from '../server/api-connections.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';

const expected = {
  T7: 'tblH2qBpcxE1LDvW',
  T11: 'tblkpGzQTkz5Daxa',
};
const additions = [
  ['T7', '实际研究候选数', 2],
  ['T7', '任务类型', 3, '网页搜索与官网研究'],
  ['T7', '采集渠道', 3, '通用网页搜索'],
  ['T7', '任务状态', 3, '已停止'],
  ['T7', '任务状态', 3, '研究上限结束'],
  ['T11', '适用采集渠道', 3, '通用网页搜索'],
];

export async function extendOperationalSchema(client, { apply = false, backup } = {}) {
  const tables = await client.tables();
  const ids = {};
  const before = {};
  for (const [kind, tableId] of Object.entries(expected)) {
    const matches = tables.filter(
      (table) => table.table_id === tableId && table.name.startsWith(`${kind}｜`),
    );
    assert(matches.length === 1, `正式 Base 的 ${kind} 表编号不符`);
    ids[kind] = tableId;
    before[kind] = {
      fields: await client.fields(tableId),
      records: await client.records(tableId),
    };
  }
  const relation = before.T7.fields.find((field) => field.field_name === '关联关键词组');
  assert(
    relation?.type === 18 &&
      relation.property?.table_id === ids.T11 &&
      relation.property?.multiple === true,
    'T7 关联关键词组目标不符',
  );
  const pending = [];
  for (const [kind, name, type, option] of additions) {
    const field = before[kind].fields.find((item) => item.field_name === name);
    if (!field) {
      assert(type === 2, `正式 Base 缺少原有单选字段：${kind}/${name}`);
      pending.push({ kind, name, type });
    } else {
      assert.equal(field.type, type, `${kind}/${name} 字段类型不符`);
      if (option && !field.property?.options?.some((item) => item.name === option))
        pending.push({ kind, name, type, option });
    }
  }
  if (!apply)
    return {
      pending,
      recordCounts: Object.fromEntries(
        Object.entries(before).map(([kind, value]) => [kind, value.records.length]),
      ),
    };
  assert.equal(typeof backup, 'function', '修改字段前必须保存原结构与记录');
  await backup({ at: new Date().toISOString(), base: client.env.FEISHU_APP_TOKEN, before });
  for (const { kind, name, type, option } of pending) {
    const tableId = ids[kind];
    const confirm = async () => {
      const current = (await client.fields(tableId)).find((item) => item.field_name === name);
      return (
        current?.type === type &&
        (!option || current.property?.options?.some((item) => item.name === option))
      );
    };
    if (await confirm()) continue;
    const field = (await client.fields(tableId)).find((item) => item.field_name === name);
    try {
      if (field) {
        assert.equal(field.type, type, `${kind}/${name} 字段类型不符`);
        await client.request(
          client.tablePath(tableId) + '/fields/' + encodeURIComponent(field.field_id),
          {
            method: 'PUT',
            body: {
              field_name: name,
              type,
              property: {
                ...field.property,
                options: [...field.property.options, { name: option }],
              },
            },
          },
        );
      } else {
        await client.request(client.tablePath(tableId) + '/fields', {
          method: 'POST',
          body: { field_name: name, type },
        });
      }
    } catch (error) {
      if (!(await confirm())) throw error;
    }
    assert(await confirm(), `未能核对 ${kind}/${name} 字段`);
  }
  for (const [kind, tableId] of Object.entries(ids)) {
    const after = await client.records(tableId);
    assert.deepEqual(
      after.map((record) => record.record_id).sort(),
      before[kind].records.map((record) => record.record_id).sort(),
      `${kind} 原记录发生变化`,
    );
  }
  return {
    applied: pending,
    recordCounts: Object.fromEntries(
      Object.entries(before).map(([kind, value]) => [kind, value.records.length]),
    ),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert(
    process.argv.slice(2).every((arg) => arg === '--apply'),
    '仅支持 --apply；省略时预览',
  );
  const env = connectionEnvironment();
  assert.equal(env.FEISHU_APP_TOKEN, 'Xat4bgUFuaL6tBsXqRccnYaknEf', '目标不是领导原建的 Base');
  const client = new FeishuClient({ env });
  const result = await extendOperationalSchema(client, {
    apply: process.argv.includes('--apply'),
    backup: async (snapshot) => {
      const folder = join(dirname(env.CONNECTIONS_PATH || '.data/api-connections.json'), 'backups');
      mkdirSync(folder, { recursive: true });
      const path = join(folder, 't7-t11-schema-' + snapshot.at.replace(/[:.]/g, '-') + '.json');
      writeFileSync(path, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
      console.log('字段备份：' + path);
    },
  });
  console.log(JSON.stringify(result));
}
