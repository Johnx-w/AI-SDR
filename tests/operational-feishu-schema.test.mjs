import test from 'node:test';
import assert from 'node:assert/strict';
import { extendOperationalSchema } from '../scripts/extend-operational-feishu.mjs';

test('T7/T11 字段扩展先备份并保留原选项与记录，重复执行不增加字段', async () => {
  const definitions = {
    tblH2qBpcxE1LDvW: [
      {
        field_id: 'relation',
        field_name: '关联关键词组',
        type: 18,
        property: { table_id: 'tblkpGzQTkz5Daxa', multiple: true },
      },
      ...['任务类型', '采集渠道', '任务状态'].map((field_name) => ({
        field_id: field_name,
        field_name,
        type: 3,
        property: { options: [{ name: '原选项', id: 'kept' }] },
      })),
    ],
    tblkpGzQTkz5Daxa: [
      {
        field_id: 'channel',
        field_name: '适用采集渠道',
        type: 3,
        property: { options: [{ name: '原选项', id: 'kept' }] },
      },
    ],
  };
  const originals = {
    tblH2qBpcxE1LDvW: [{ record_id: 't7-1', fields: { 任务名称: '原任务' } }],
    tblkpGzQTkz5Daxa: [],
  };
  const writes = [];
  const client = {
    env: { FEISHU_APP_TOKEN: 'formal-base' },
    tables: async () => [
      { name: 'T7｜定时触发调度表', table_id: 'tblH2qBpcxE1LDvW' },
      { name: 'T11｜区域市场搜索词表', table_id: 'tblkpGzQTkz5Daxa' },
    ],
    fields: async (id) => structuredClone(definitions[id]),
    records: async (id) => structuredClone(originals[id]),
    tablePath: (id) => `/tables/${id}`,
    request: async (path, { method, body }) => {
      writes.push({ path, method, body });
      const id = path.split('/')[2];
      if (method === 'POST') definitions[id].push({ field_id: 'research', ...body });
      else {
        const field = definitions[id].find(
          (item) => item.field_id === decodeURIComponent(path.split('/').at(-1)),
        );
        Object.assign(field, body);
      }
    },
  };
  const preview = await extendOperationalSchema(client);
  assert.equal(preview.pending.length, 6);
  assert.equal(writes.length, 0);
  let backup;
  await extendOperationalSchema(client, {
    apply: true,
    backup: async (snapshot) => {
      assert.equal(writes.length, 0);
      backup = snapshot;
    },
  });
  assert.equal(writes.length, 6);
  assert.equal(backup.before.T7.records[0].record_id, 't7-1');
  assert(definitions.tblH2qBpcxE1LDvW.find((item) => item.field_name === '实际研究候选数'));
  assert.deepEqual(
    definitions.tblH2qBpcxE1LDvW
      .find((item) => item.field_name === '任务状态')
      .property.options.map((item) => item.name),
    ['原选项', '已停止', '研究上限结束'],
  );
  assert.equal((await extendOperationalSchema(client)).pending.length, 0);
  await extendOperationalSchema(client, { apply: true, backup: async () => {} });
  assert.equal(writes.length, 6);
});
