import assert from 'node:assert/strict';
import { BUSINESS_TABLES, buildBusinessTableFields } from './customer-business-feishu.mjs';

export const CUSTOMER_MIRROR_FIELDS = [
  { field_name: '评级依据摘要', type: 1 },
  { field_name: '最近联系时间', type: 5 },
  { field_name: '最近回复时间', type: 5 },
];
export const CUSTOMER_VISIBLE_FIELDS = [
  '公司名称',
  '国家',
  '客户类型',
  '企业经营产品',
  '初评结果',
  '开发状态',
  '主要供货机会',
  '邮箱',
  '电话',
  '企业官网',
  '最近联系时间',
  '最近回复时间',
];
export const MESSAGE_VISIBLE_FIELDS = [
  '客户',
  '发生时间',
  '渠道',
  '方向',
  '主题',
  '发送结果',
  '消息分类',
  '发送方',
  '接收方',
  '对外账号',
];

// Run during the explicit migration, never on ordinary reads or every timer tick.
export async function configureMirrorSchema(client) {
  const tableId = client.env.FEISHU_TABLE_ID;
  let fields = await client.fields(tableId);
  for (const definition of CUSTOMER_MIRROR_FIELDS) {
    const existing = fields.find((field) => field.field_name === definition.field_name);
    if (existing) assert.equal(existing.type, definition.type, '客户摘要字段类型不符');
    else {
      // A lost response is reconciled by the next run's field lookup.
      await client.request(client.tablePath(tableId) + '/fields', {
        method: 'POST',
        body: definition,
      });
    }
  }
  fields = await client.fields(tableId);
  const options = async (id, definitions, name, choices) => {
    const field = definitions.find((item) => item.field_name === name);
    assert(field?.type === 3, '缺少单选字段：' + name);
    const current = field.property?.options || [];
    if (JSON.stringify(current.map((item) => item.name)) === JSON.stringify(choices)) return;
    await client.request(client.tablePath(id) + '/fields/' + field.field_id, {
      method: 'PUT',
      body: {
        field_name: name,
        type: 3,
        property: {
          ...field.property,
          options: choices.map((name) => current.find((item) => item.name === name) || { name }),
        },
      },
    });
  };
  await options(tableId, fields, '初评结果', ['A', 'B', 'C']);
  await options(tableId, fields, '开发状态', [
    '待开发',
    '已联系',
    '已回复',
    '跟进中',
    '已成交',
    '停止开发',
  ]);
  const tables = await client.tables();
  const messages = tables.find((table) => table.name === BUSINESS_TABLES.messages.name);
  assert(messages, '缺少 T3 沟通记录表');
  const messageFields = await client.fields(messages.table_id);
  const expected = buildBusinessTableFields().messages.find(
    (field) => field.field_name === '发送结果',
  );
  await options(
    messages.table_id,
    messageFields,
    '发送结果',
    expected.property.options.map((item) => item.name),
  );

  for (const [id, visible, customerView] of [
    [tableId, CUSTOMER_VISIBLE_FIELDS, true],
    [messages.table_id, MESSAGE_VISIBLE_FIELDS, false],
  ]) {
    const definitions = await client.fields(id);
    const data = await client.request(client.tablePath(id) + '/views?page_size=100');
    const view = data.items?.find((item) => item.view_type === 'grid');
    assert(view, '缺少表格视图');
    const property = {
      hidden_fields: definitions
        .filter((field) => !field.is_primary && !visible.includes(field.field_name))
        .map((field) => field.field_id),
    };
    if (customerView)
      property.filter_info = {
        conjunction: 'and',
        conditions: [
          {
            field_id: definitions.find((field) => field.field_name === '初评结果').field_id,
            operator: 'isNotEmpty',
          },
        ],
      };
    await client.request(client.tablePath(id) + '/views/' + view.view_id, {
      method: 'PATCH',
      body: { property },
    });
    const readback = await client.request(client.tablePath(id) + '/views/' + view.view_id);
    assert.deepEqual(
      [...(readback.view?.property?.hidden_fields || [])].sort(),
      [...property.hidden_fields].sort(),
      '视图隐藏字段读回不一致',
    );
  }
  return { customers: tableId, messages: messages.table_id };
}
