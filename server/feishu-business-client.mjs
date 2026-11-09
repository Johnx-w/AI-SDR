import assert from 'node:assert/strict';

export const BUSINESS_TABLE_ID_ENV = Object.freeze({
  demands: 'FEISHU_DEMANDS_TABLE_ID',
  messages: 'FEISHU_MESSAGES_TABLE_ID',
  tasks: 'FEISHU_TASKS_TABLE_ID',
  products: 'FEISHU_PRODUCTS_TABLE_ID',
});

const aliases = {
  demands: { 客户: '关联客户', 产品资料: '询盘产品' },
  messages: { 客户: '关联客户', 渠道: '触达渠道', 发生时间: '发送/沟通时间', 正文: '沟通正文' },
  tasks: { 客户: '关联客户', 关联沟通: '关联沟通记录', 渠道: '任务类型' },
  products: { MOQ: 'MOQ最小起订量' },
};
const messageChannels = { 网页留言: '网站留言', 电话: '人工电话' };
const taskChannels = {
  邮件: '邮件触达',
  WhatsApp: 'WhatsApp触达',
  网页留言: '网站留言',
  电话: '人工电话外呼',
};

// Explicit target IDs opt into the existing Base's physical column names.
export function mapBusinessFeishuClient(client, env) {
  const configured = Object.entries(BUSINESS_TABLE_ID_ENV)
    .map(([kind, key]) => [env[key]?.trim(), kind])
    .filter(([id]) => id);
  if (!configured.length) return client;
  assert(
    new Set(configured.map(([id]) => id)).size === configured.length,
    '飞书业务表编号不能重复',
  );
  const kinds = new Map(configured);
  const fieldMap = (tableId) => aliases[kinds.get(tableId)] || {};
  const values = (tableId, name) =>
    name === '渠道'
      ? { messages: messageChannels, tasks: taskChannels }[kinds.get(tableId)] || {}
      : {};
  const readValue = (tableId, name, value) =>
    Object.entries(values(tableId, name)).find(([, physical]) => physical === value)?.[0] ?? value;
  const readRecord = (record, tableId) => {
    if (!record) return record;
    const fields = { ...record.fields };
    for (const [logical, physical] of Object.entries(fieldMap(tableId))) {
      delete fields[logical];
      delete fields[physical];
      if (Object.hasOwn(record.fields || {}, physical))
        fields[logical] = readValue(tableId, logical, record.fields[physical]);
    }
    return { ...record, fields };
  };
  return {
    tablePath: (...args) => client.tablePath(...args),
    tables: (...args) => client.tables(...args),
    request: (...args) => client.request(...args),
    async fields(tableId) {
      const fields = await client.fields(tableId);
      const mapping = fieldMap(tableId);
      return fields
        .filter((field) => !Object.hasOwn(mapping, field.field_name))
        .map((field) => {
          const logical = Object.entries(mapping).find(
            ([, physical]) => physical === field.field_name,
          )?.[0];
          if (!logical) return field;
          return {
            ...field,
            field_name: logical,
            ...(field.property?.options
              ? {
                  property: {
                    ...field.property,
                    options: field.property.options.map((option) => ({
                      ...option,
                      name: readValue(tableId, logical, option.name),
                    })),
                  },
                }
              : {}),
          };
        });
    },
    async records(tableId, ...args) {
      return (await client.records(tableId, ...args)).map((record) => readRecord(record, tableId));
    },
    async record(id, tableId) {
      return readRecord(await client.record(id, tableId), tableId);
    },
    async write(action, fields, id, token, tableId) {
      const physical = Object.fromEntries(
        Object.entries(fields).map(([name, value]) => {
          const choices = values(tableId, name);
          return [
            fieldMap(tableId)[name] || name,
            typeof value === 'string' && Object.hasOwn(choices, value) ? choices[value] : value,
          ];
        }),
      );
      return readRecord(await client.write(action, physical, id, token, tableId), tableId);
    },
  };
}
