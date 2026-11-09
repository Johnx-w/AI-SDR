import test from 'node:test';
import assert from 'node:assert/strict';
import { mapBusinessFeishuClient } from '../server/feishu-business-client.mjs';

test('未配置显式业务表时保留原client，映射不触及T2或未指定表', async () => {
  const rows = [{ record_id: 'r1', fields: { 客户: ['customer-1'], 正文: '保留原文' } }];
  const raw = { records: async () => structuredClone(rows) };
  assert.equal(mapBusinessFeishuClient(raw, {}), raw);
  const mapped = mapBusinessFeishuClient(raw, { FEISHU_MESSAGES_TABLE_ID: 'original-t3' });
  assert.deepEqual(await mapped.records('t2'), rows);
  assert.deepEqual(await mapped.records('copy-t3'), rows);
});

test('原T3字段和渠道值双向映射，保留多客户字段定义、空值与普通字符串', async () => {
  const calls = [];
  const raw = {
    fields: async () => [
      { field_name: '关联客户', type: 18, property: { table_id: 't2', multiple: true } },
      {
        field_name: '触达渠道',
        type: 3,
        property: { options: [{ name: '网站留言' }, { name: '人工电话' }, { name: '其他' }] },
      },
    ],
    write: async (...args) => {
      calls.push(args);
      return { record_id: 'message-1', fields: args[1] };
    },
  };
  const mapped = mapBusinessFeishuClient(raw, { FEISHU_MESSAGES_TABLE_ID: 't3' });
  const definitions = await mapped.fields('t3');
  assert.deepEqual(
    definitions[1].property.options.map((option) => option.name),
    ['网页留言', '电话', '其他'],
  );
  assert.equal(definitions[0].property.multiple, true);
  const result = await mapped.write(
    'update',
    { 客户: ['customer-1'], 渠道: '电话', 正文: null, 业务员纪要: 'constructor' },
    'message-1',
    'token',
    't3',
  );
  assert.deepEqual(calls[0][1], {
    关联客户: ['customer-1'],
    触达渠道: '人工电话',
    沟通正文: null,
    业务员纪要: 'constructor',
  });
  assert.deepEqual(result.fields, {
    客户: ['customer-1'],
    渠道: '电话',
    正文: null,
    业务员纪要: 'constructor',
  });
});
