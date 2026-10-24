import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { FeishuClient } from './feishu-direct.mjs';
import { assertBusinessMigrationIdle, businessSchemaDigest } from './business-schema-migration.mjs';
import { PRODUCT_KNOWLEDGE_FEISHU_FIELDS } from './product-knowledge-feishu.mjs';

const categories = {
  ventilation: '透气窗',
  shutters: '百叶窗',
  indoor: '室内成品帘',
  outdoor: '户外遮阳',
  other: '其他',
};
const directions = { finished: '成品', materials: '材料配件', samples: '样本展示' };
const channels = {
  email: '邮件',
  whatsapp: 'WhatsApp',
  form: '网页留言',
  phone: '电话',
  other: '其他',
};
const stages = {
  new: '新需求',
  clarifying: '补充规格',
  quoting: '报价',
  sampling: '样品',
  negotiating: '商务沟通',
  won: '已成交',
  lost: '未成交',
  closed: '已关闭',
};
const taskTypes = {
  first_contact: '首次联系',
  clarify_specs: '补问规格',
  quote_followup: '报价跟进',
  sample: '样品',
  manual_review: '人工审核',
  other: '其他',
};
const taskStatuses = {
  pending: '待执行',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
};
const messageDirections = { inbound: '收到', outbound: '发出', note: '纪要' };
const messageStatuses = {
  received: '已收到',
  sent: '已发送',
  failed: '发送失败',
  unknown: '结果未知',
  recorded: '已记录',
};
const messageKinds = {
  normal: '普通消息',
  auto_reply: '自动回复',
  unsubscribe: '拒绝联系',
  hard_bounce: '硬退信',
  complaint: '投诉',
};
const scalar = (field_name, type = 1) => ({ field_name, type });
const select = (field_name, choices) => ({
  field_name,
  type: 3,
  property: { options: Object.values(choices).map((name) => ({ name })) },
});
const relation = (field_name, table_id, multiple) => ({
  field_name,
  type: 18,
  property: { table_id, multiple },
});

export const BUSINESS_TABLES = Object.freeze({
  demands: { name: 'T1 采购需求表', primary: '需求编号' },
  messages: { name: 'T3 多渠道沟通记录表', primary: '沟通编号' },
  tasks: { name: 'T4 跟进任务表', primary: '任务编号' },
});

export function buildBusinessTableFields(ids = {}) {
  const schema = {
    demands: [
      scalar('需求编号'),
      scalar('需求标题'),
      scalar('会话编号'),
      select('品类', categories),
      select('供货方向', directions),
      scalar('需求产品'),
      scalar('规格要求'),
      scalar('数量'),
      scalar('单位'),
      select('需求阶段', stages),
      scalar('负责人'),
      select('接待归属', { automatic: '自动接待', human: '人工负责' }),
      scalar('客户原文依据'),
      scalar('产品资料版本'),
      scalar('记录版本', 2),
      scalar('创建时间', 5),
      scalar('最近更新时间', 5),
    ],
    messages: [
      scalar('沟通编号'),
      scalar('会话编号'),
      select('渠道', channels),
      select('方向', messageDirections),
      scalar('主题'),
      scalar('正文'),
      scalar('发送方'),
      scalar('接收方'),
      scalar('对外账号'),
      scalar('发生时间', 5),
      select('发送结果', messageStatuses),
      select('消息分类', messageKinds),
      scalar('渠道消息编号'),
      scalar('附件链接'),
      scalar('记录来源'),
      scalar('记录版本', 2),
      scalar('创建时间', 5),
    ],
    tasks: [
      scalar('任务编号'),
      scalar('任务标题'),
      scalar('会话编号'),
      select('任务类型', taskTypes),
      select('执行方式', { manual: '人工执行', automatic: '系统计划' }),
      select('渠道', channels),
      scalar('计划执行时间', 5),
      select('任务状态', taskStatuses),
      scalar('负责人'),
      scalar('任务说明'),
      scalar('执行前检查'),
      scalar('记录版本', 2),
      scalar('完成时间', 5),
      scalar('实际执行记录'),
      scalar('创建时间', 5),
      scalar('最近更新时间', 5),
    ],
  };
  for (const key of Object.keys(schema))
    if (ids.customers) schema[key].push(relation('客户', ids.customers, false));
  if (ids.products) {
    schema.demands.push(relation('产品资料', ids.products, true));
    schema.tasks.push(relation('产品资料', ids.products, true));
  }
  if (ids.messages) {
    schema.demands.push(relation('来源沟通', ids.messages, false));
    schema.tasks.push(
      relation('关联沟通', ids.messages, true),
      relation('执行结果沟通', ids.messages, false),
    );
  }
  if (ids.demands) {
    schema.messages.push(relation('关联需求', ids.demands, true));
    schema.tasks.push(relation('关联需求', ids.demands, true));
  }
  return schema;
}

const text = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  if (typeof value === 'object') return value.text || value.link || value.name || '';
  return String(value);
};
const idsOf = (value) =>
  (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap((item) =>
      typeof item === 'string' ? [item] : item?.record_ids || [item?.record_id || item?.id],
    )
    .filter(Boolean);
const unique = (value) => [...new Set(idsOf(value))];
const nullable = (value) => (value == null || value === '' ? null : String(value));
const date = (value) => {
  if (value == null || value === '') return null;
  const result = typeof value === 'number' ? value : Date.parse(value);
  assert(Number.isFinite(result), '业务记录时间无效');
  return result;
};
const choice = (choices, value, label) => {
  assert(Object.hasOwn(choices, value), label + '无效，请先核对本地业务记录');
  return choices[value];
};
const pending = (error, extra = {}) => ({ status: 'pending', ...extra, error });
const locks = new Map();
const recordOrder = (records) =>
  [...records].sort((left, right) => left.record_id.localeCompare(right.record_id));

function sameFields(record, expected, definitions) {
  return Object.entries(expected).every(([name, value]) => {
    const definition = definitions.find((field) => field.field_name === name);
    assert(definition, '镜像字段不存在：' + name);
    const actual = record.fields?.[name];
    if (definition.type === 18)
      return (
        businessSchemaDigest(unique(actual).sort()) === businessSchemaDigest(unique(value).sort())
      );
    if ([2, 5].includes(definition.type))
      return value == null ? !text(actual) : Number(actual) === Number(value);
    return text(actual) === text(value);
  });
}

async function safeWrite({ journal, checkpoint }, key, write, confirm) {
  const previous = journal.filter((event) => event.key === key).at(-1);
  const save = async (state) => {
    journal.push({ at: new Date().toISOString(), key, state });
    await checkpoint?.(journal);
  };
  if (await confirm()) {
    if (previous && ['pending', 'uncertain'].includes(previous.state)) await save('done');
    return;
  }
  if (previous && ['pending', 'uncertain'].includes(previous.state))
    throw new Error('上次写入仍待核对，未重复执行：' + key);
  await save('pending');
  try {
    await write();
  } catch {
    /* Reconcile uncertain external writes by reading only. */
  }
  try {
    if (await confirm()) {
      await save('done');
      return;
    }
  } catch {
    /* Preserve uncertainty. */
  }
  await save('uncertain');
  throw new Error('飞书写入结果尚未核对，未重复执行：' + key);
}

function assertSchema(fields, expected) {
  for (const item of expected) {
    const actual = fields.find((field) => field.field_name === item.field_name);
    assert(actual && actual.type === item.type, '字段缺失或类型不符：' + item.field_name);
    if (item.type === 3) {
      const options = new Set((actual.property?.options || []).map((option) => option.name));
      assert(
        item.property.options.every((option) => options.has(option.name)),
        '单选选项不完整：' + item.field_name,
      );
    }
    if (item.type === 18)
      assert(
        actual.property?.table_id === item.property.table_id &&
          Boolean(actual.property?.multiple) === item.property.multiple,
        '关联字段目标或多选配置不符：' + item.field_name,
      );
  }
}

export class CustomerBusinessFeishu {
  constructor({ env = {}, fetchImpl = fetch, client, journal, checkpoint, journalPath } = {}) {
    this.env = env;
    this.client = client || new FeishuClient({ env, fetchImpl });
    this.configured =
      Boolean(client) ||
      ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_APP_TOKEN', 'FEISHU_TABLE_ID'].every(
        (key) => typeof env[key] === 'string' && env[key].trim(),
      );
    const chosenPath =
      journalPath || env.BUSINESS_MIRROR_JOURNAL_PATH || env.CUSTOMER_BUSINESS_FEISHU_JOURNAL_PATH;
    this.journalPath =
      chosenPath === ':memory:'
        ? null
        : chosenPath || (!client ? '.data/customer-business-feishu-journal.json' : null);
    this.journal = journal;
    this.checkpoint = checkpoint;
    if (!this.journal) {
      try {
        this.journal = this.journalPath ? JSON.parse(readFileSync(this.journalPath, 'utf8')) : [];
      } catch (error) {
        if (error.code !== 'ENOENT') throw new Error('业务表同步日志无法读取');
        this.journal = [];
      }
    }
    assert(Array.isArray(this.journal), '业务表同步日志无效');
    this.scope = createHash('sha256')
      .update(String(env.FEISHU_APP_TOKEN || '') + '/' + String(env.FEISHU_TABLE_ID || ''))
      .digest('hex')
      .slice(0, 24);
  }
  async persistJournal() {
    if (this.checkpoint) return this.checkpoint(this.journal);
    if (!this.journalPath) return;
    mkdirSync(dirname(this.journalPath), { recursive: true });
    writeFileSync(this.journalPath + '.tmp', JSON.stringify(this.journal, null, 2));
    renameSync(this.journalPath + '.tmp', this.journalPath);
  }
  async tableIds() {
    const tables = await this.client.tables();
    const ids = { customers: this.env.FEISHU_TABLE_ID };
    assert(
      ids.customers &&
        tables.some((table) => table.table_id === ids.customers && /^T2(?:\s|$)/.test(table.name)),
      '未找到配置中的T2客户主表',
    );
    for (const [key, definition] of [
      ...Object.entries(BUSINESS_TABLES),
      ['products', { name: 'T5 产品资料库' }],
    ]) {
      const matches = tables.filter((table) => table.name === definition.name);
      assert(matches.length <= 1, '发现同名重复表：' + definition.name);
      ids[key] = matches[0]?.table_id || null;
    }
    return ids;
  }
  async info() {
    if (!this.configured)
      return {
        configured: false,
        status: 'not_configured',
        tables: {},
        error: '尚未配置飞书业务表，本地记录已保存',
      };
    try {
      const ids = await this.tableIds();
      const tables = Object.fromEntries(Object.keys(BUSINESS_TABLES).map((key) => [key, ids[key]]));
      if (!ids.products || Object.values(tables).some((id) => !id))
        return {
          configured: false,
          status: 'not_configured',
          tables,
          error: '请先建立T1、T3、T4及T5业务表',
        };
      const expected = buildBusinessTableFields(ids);
      for (const key of Object.keys(BUSINESS_TABLES))
        assertSchema(await this.client.fields(ids[key]), expected[key]);
      assertSchema(await this.client.fields(ids.products), PRODUCT_KNOWLEDGE_FEISHU_FIELDS);
      return { configured: true, status: 'ready', tables, productsTableId: ids.products };
    } catch (error) {
      return { configured: false, ...pending(error.message), tables: {} };
    }
  }
  async provision({ backup, readApi, journal = [], checkpoint } = {}) {
    assert(this.configured, '请先配置飞书连接');
    assert.equal(typeof backup, 'function', '建立业务表前必须配置持久备份');
    await assertBusinessMigrationIdle(readApi);
    const all = await this.client.tables();
    assert(!all.some((table) => /^T12(?:\s|$)/.test(table.name)), '请先完成T12删除');
    const ids = await this.tableIds();
    assert(ids.products, '请先建立T5产品资料库');
    const protectedState = await Promise.all(
      [ids.customers, ids.products].map(async (tableId) => ({
        tableId,
        fields: await this.client.fields(tableId),
        records: await this.client.records(tableId),
      })),
    );
    assert.equal(protectedState[0].fields.length, 26, 'T2应已完成26列迁移');
    assert(
      [
        '初评结果',
        '企业经营产品',
        '主营产品概况',
        '公开采购需求',
        '企业服务客群',
        '企业官网',
        '主要供货机会',
        '待确认事项',
      ].every((name) => protectedState[0].fields.some((field) => field.field_name === name)),
      'T2字段迁移尚未完成',
    );
    assert.equal(
      protectedState[1].fields.length,
      PRODUCT_KNOWLEDGE_FEISHU_FIELDS.length,
      'T5字段数不符合当前方案',
    );
    assertSchema(protectedState[1].fields, PRODUCT_KNOWLEDGE_FEISHU_FIELDS);
    const snapshot = {
      at: new Date().toISOString(),
      scope: this.scope,
      tables: all,
      contents: await Promise.all(
        all.map(async (table) => ({
          ...table,
          fields: await this.client.fields(table.table_id),
          records: await this.client.records(table.table_id),
        })),
      ),
    };
    await backup(snapshot);
    const operation = { journal, checkpoint };
    const appTablesPath = this.client.tablePath(ids.customers).split('/tables/')[0] + '/tables';
    for (const [key, definition] of Object.entries(BUSINESS_TABLES)) {
      const confirm = async () => {
        const current = await this.tableIds();
        ids[key] = current[key];
        return Boolean(ids[key]);
      };
      await safeWrite(
        operation,
        this.scope + ':table:' + key,
        () =>
          this.client.request(appTablesPath, {
            method: 'POST',
            body: {
              table: {
                name: definition.name,
                default_view_name: '业务记录',
                fields: buildBusinessTableFields()[key],
              },
            },
          }),
        confirm,
      );
    }
    const expected = buildBusinessTableFields(ids);
    for (const key of Object.keys(BUSINESS_TABLES)) {
      const existingFields = await this.client.fields(ids[key]);
      for (const definition of expected[key]) {
        const existingField = existingFields.find(
          (field) => field.field_name === definition.field_name,
        );
        if (existingField) {
          assertSchema([existingField], [definition]);
          const operationKey = this.scope + ':field:' + key + ':' + definition.field_name;
          const previous = journal.filter((event) => event.key === operationKey).at(-1);
          if (previous && ['pending', 'uncertain'].includes(previous.state))
            await safeWrite(
              operation,
              operationKey,
              () => {
                throw new Error('已有字段不应重复创建');
              },
              async () => true,
            );
          continue;
        }
        const confirm = async () => {
          const fields = await this.client.fields(ids[key]);
          const found = fields.find((field) => field.field_name === definition.field_name);
          if (found) assertSchema([found], [definition]);
          return Boolean(found);
        };
        await safeWrite(
          operation,
          this.scope + ':field:' + key + ':' + definition.field_name,
          () =>
            this.client.request(this.client.tablePath(ids[key]) + '/fields', {
              method: 'POST',
              body: definition,
            }),
          confirm,
        );
      }
    }
    for (const original of protectedState) {
      assert.equal(
        businessSchemaDigest(await this.client.fields(original.tableId)),
        businessSchemaDigest(original.fields),
        'T2/T5字段在建表期间发生变化',
      );
      assert.equal(
        businessSchemaDigest(recordOrder(await this.client.records(original.tableId))),
        businessSchemaDigest(recordOrder(original.records)),
        'T2/T5数据在建表期间发生变化',
      );
    }
    const result = await this.info();
    assert(result.configured, result.error || '业务表结构读回失败');
    return { ...result, createdRecords: 0 };
  }
  async sync(workspace, { products = [] } = {}) {
    let snapshot;
    try {
      snapshot = structuredClone({ workspace, products });
    } catch {
      return pending('本地业务记录无效，尚不能同步');
    }
    const previous = locks.get(this.scope) || Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(() => this.syncCurrent(snapshot.workspace, snapshot.products));
    locks.set(this.scope, operation);
    try {
      return await operation;
    } finally {
      if (locks.get(this.scope) === operation) locks.delete(this.scope);
    }
  }
  async syncCurrent(workspace, products) {
    const config = await this.info();
    if (!config.configured)
      return { ...config, status: config.status === 'pending' ? 'pending' : 'not_configured' };
    try {
      assert(
        workspace && ['demands', 'messages', 'tasks'].every((key) => Array.isArray(workspace[key])),
        '本地业务数据不完整',
      );
      const tableIds = {
        ...config.tables,
        customers: this.env.FEISHU_TABLE_ID,
        products: config.productsTableId,
      };
      const definitions = buildBusinessTableFields(tableIds);
      const remote = {},
        index = {},
        local = {};
      for (const key of Object.keys(BUSINESS_TABLES)) {
        remote[key] = await this.client.records(tableIds[key]);
        index[key] = new Map();
        local[key] = new Map();
        for (const record of remote[key]) {
          const id = text(record.fields?.[BUSINESS_TABLES[key].primary]);
          assert(!index[key].has(id), '飞书存在重复业务编号');
          index[key].set(id, record);
        }
        for (const entry of workspace[key]) {
          assert(entry.id && !local[key].has(entry.id), '本地业务编号缺失或重复');
          local[key].set(entry.id, entry);
        }
      }
      const customers = new Set(
        (await this.client.records(tableIds.customers)).map((record) => record.record_id),
      );
      const productRecords = new Map();
      for (const record of await this.client.records(tableIds.products)) {
        const id = text(record.fields?.['产品编号']);
        assert(!productRecords.has(id), 'T5存在重复产品编号');
        productRecords.set(id, record.record_id);
      }
      const productVersions = new Map(products.map((product) => [product.id, product.version]));
      const customer = (entry) => {
        assert(customers.has(entry.customerId), '业务记录关联的客户不在T2中');
        return [entry.customerId];
      };
      const productIds = (entry) => unique(entry.productIds || []);
      const productLinks = (entry) =>
        productIds(entry).map((id) => {
          assert(
            productRecords.has(id) && productVersions.has(id),
            '关联产品尚未同步T5或本地资料缺失',
          );
          return productRecords.get(id);
        });
      const mapReferences = (key, ids, entry) =>
        unique(ids).map((id) => {
          const related = local[key].get(id);
          assert(
            related &&
              related.customerId === entry.customerId &&
              related.conversationId === entry.conversationId,
            '关联业务记录缺失或属于其他客户/会话',
          );
          assert(index[key].has(id), '关联业务记录尚未同步');
          return index[key].get(id).record_id;
        });
      const bases = { demands: new Map(), messages: new Map(), tasks: new Map() };
      for (const [key, entries] of Object.entries(local))
        for (const entry of entries.values()) {
          assert(Number.isInteger(entry.version) && entry.version >= 1, '业务记录版本无效');
          if (key === 'messages')
            assert(
              entry.actualConfirmed === true && entry.origin === 'manual',
              '沟通记录尚未确认实际发生，不能同步为真实沟通',
            );
          const common = {
            [BUSINESS_TABLES[key].primary]: entry.id,
            会话编号: nullable(entry.conversationId),
            客户: customer(entry),
            记录版本: entry.version,
            创建时间: date(entry.createdAt),
          };
          let fields;
          if (key === 'demands')
            fields = {
              ...common,
              需求标题: nullable(entry.title),
              品类: choice(categories, entry.category, '需求品类'),
              供货方向: choice(directions, entry.direction, '供货方向'),
              需求产品: nullable(entry.productText),
              规格要求: nullable(entry.specifications),
              数量: nullable(entry.quantity),
              单位: nullable(entry.unit),
              需求阶段: choice(stages, entry.stage, '需求阶段'),
              负责人: nullable(entry.owner),
              接待归属:
                entry.ownership === 'human' ||
                (workspace.conversations || []).some(
                  (conversation) =>
                    conversation.id === entry.conversationId && conversation.ownership === 'human',
                )
                  ? '人工负责'
                  : '自动接待',
              客户原文依据: nullable(entry.evidenceQuote),
              产品资料版本:
                productIds(entry)
                  .map((id) => id + '@v' + (entry.productVersions?.[id] ?? productVersions.get(id)))
                  .join('\n') || null,
              产品资料: productLinks(entry),
              最近更新时间: date(entry.updatedAt),
            };
          if (key === 'messages')
            fields = {
              ...common,
              渠道: choice(channels, entry.channel, '沟通渠道'),
              方向: choice(messageDirections, entry.direction, '沟通方向'),
              主题: nullable(entry.subject),
              正文: nullable(entry.body),
              发送方: nullable(entry.sender || entry.from),
              接收方: nullable(entry.recipient || entry.to),
              对外账号: nullable(entry.account || entry.outboundAccount),
              发生时间: date(entry.occurredAt),
              发送结果: choice(messageStatuses, entry.deliveryStatus, '发送结果'),
              消息分类: choice(
                messageKinds,
                entry.classification || entry.kind || 'normal',
                '消息分类',
              ),
              渠道消息编号: nullable(entry.externalId || entry.channelMessageId),
              附件链接:
                (entry.attachments || [])
                  .map((item) => (typeof item === 'string' ? item : item.url))
                  .filter(Boolean)
                  .join('\n') || null,
              记录来源: '人工补录',
            };
          if (key === 'tasks')
            fields = {
              ...common,
              任务标题: nullable(entry.title),
              任务类型: choice(taskTypes, entry.kind, '任务类型'),
              执行方式: choice(
                { manual: '人工执行', automatic: '系统计划' },
                entry.executionMode || 'manual',
                '任务执行方式',
              ),
              渠道: choice(channels, entry.channel, '任务渠道'),
              计划执行时间: date(entry.dueAt),
              任务状态: choice(taskStatuses, entry.status, '任务状态'),
              负责人: nullable(entry.owner),
              任务说明: nullable(entry.notes || entry.description),
              执行前检查: entry.preflight
                ? (entry.preflight.reasons || []).join('；') || '当前检查通过'
                : entry.status === 'paused'
                  ? [...(entry.audit || [])]
                      .reverse()
                      .find((event) => event.action === 'auto_pause')
                      ?.reasons?.join('；') || '任务已暂停，恢复前需核对当前会话与资料'
                  : entry.status === 'completed'
                    ? '已登记执行结果，详见关联沟通和实际执行记录'
                    : '执行前需重新核对当前会话与产品资料',
              完成时间: date(entry.completedAt),
              实际执行记录:
                (entry.audit || [])
                  .map(
                    (event) =>
                      [
                        event.at || event.createdAt,
                        event.type || event.action,
                        event.notes ||
                          event.note ||
                          event.reason ||
                          (event.reasons || []).join('；') ||
                          event.result,
                      ]
                        .filter(Boolean)
                        .join(' · ') || JSON.stringify(event),
                  )
                  .join('\n') || null,
              产品资料: productLinks(entry),
              最近更新时间: date(entry.updatedAt),
            };
          bases[key].set(entry.id, fields);
        }
      // Validate all local references before any remote business record is written.
      for (const key of Object.keys(local))
        for (const entry of local[key].values()) {
          const refs =
            key === 'demands'
              ? { messages: entry.sourceMessageId ? [entry.sourceMessageId] : [] }
              : key === 'messages'
                ? { demands: entry.demandIds || [] }
                : {
                    demands: entry.demandIds || [],
                    messages: [
                      ...(entry.messageIds || []),
                      ...(entry.basisMessageId ? [entry.basisMessageId] : []),
                      ...(entry.resultMessageId ? [entry.resultMessageId] : []),
                    ],
                  };
          for (const [relatedKey, ids] of Object.entries(refs))
            for (const id of unique(ids)) {
              const related = local[relatedKey].get(id);
              assert(
                related &&
                  related.customerId === entry.customerId &&
                  related.conversationId === entry.conversationId,
                '关联业务记录缺失或跨客户/会话',
              );
            }
        }
      const upsert = async (key, entry, expected, pass) => {
        const operationKey =
          this.scope + ':record:' + key + ':' + entry.id + ':' + entry.version + ':' + pass;
        const cached = index[key].get(entry.id);
        // The graph was just read completely. Unchanged records need no further
        // per-record requests; changed writes still require direct readback.
        if (cached && sameFields(cached, expected, definitions[key])) {
          const previous = this.journal.filter((event) => event.key === operationKey).at(-1);
          if (previous && ['pending', 'uncertain'].includes(previous.state))
            await safeWrite(
              { journal: this.journal, checkpoint: () => this.persistJournal() },
              operationKey,
              () => {
                throw new Error('已核对的记录不应重复写入');
              },
              async () => true,
            );
          return;
        }
        const find = async () => {
          const matches = (await this.client.records(tableIds[key])).filter(
            (record) => text(record.fields?.[BUSINESS_TABLES[key].primary]) === entry.id,
          );
          assert(matches.length <= 1, '存在重复业务编号');
          const record = matches[0];
          if (record) {
            assert(Number(record.fields['记录版本']) <= entry.version, '飞书业务记录已有更高版本');
            index[key].set(entry.id, record);
          }
          return record;
        };
        let existing = await find();
        const confirm = async () => {
          const record = await find();
          if (!record) return false;
          const readback = await this.client.record(record.record_id, tableIds[key]);
          if (!sameFields(readback, expected, definitions[key])) return false;
          index[key].set(entry.id, readback);
          return true;
        };
        const token = createHash('sha256')
          .update(this.scope + ':' + key + ':' + entry.id + ':' + entry.version)
          .digest('hex');
        const uuid = `${token.slice(0, 8)}-${token.slice(8, 12)}-4${token.slice(13, 16)}-a${token.slice(17, 20)}-${token.slice(20, 32)}`;
        const values = existing
          ? expected
          : Object.fromEntries(Object.entries(expected).filter(([, value]) => value !== null));
        await safeWrite(
          { journal: this.journal, checkpoint: () => this.persistJournal() },
          operationKey,
          () =>
            this.client.write(
              existing ? 'update' : 'insert',
              values,
              existing?.record_id,
              uuid,
              tableIds[key],
            ),
          confirm,
        );
      };
      for (const key of ['messages', 'demands', 'tasks'])
        for (const entry of local[key].values())
          await upsert(key, entry, bases[key].get(entry.id), 'base');
      for (const key of ['messages', 'demands', 'tasks'])
        for (const entry of local[key].values()) {
          const expected = { ...bases[key].get(entry.id) };
          if (key === 'demands')
            expected['来源沟通'] = mapReferences(
              'messages',
              entry.sourceMessageId ? [entry.sourceMessageId] : [],
              entry,
            );
          if (key === 'messages')
            expected['关联需求'] = mapReferences(
              'demands',
              [
                ...(entry.demandIds || []),
                ...workspace.demands
                  .filter((demand) => demand.sourceMessageId === entry.id)
                  .map((demand) => demand.id),
              ],
              entry,
            );
          if (key === 'tasks') {
            expected['关联需求'] = mapReferences('demands', entry.demandIds || [], entry);
            expected['关联沟通'] = mapReferences(
              'messages',
              [
                ...(entry.messageIds || []),
                ...(entry.basisMessageId ? [entry.basisMessageId] : []),
              ],
              entry,
            );
            expected['执行结果沟通'] = mapReferences(
              'messages',
              entry.resultMessageId ? [entry.resultMessageId] : [],
              entry,
            );
          }
          await upsert(key, entry, expected, 'relations');
        }
      return {
        status: 'synced',
        tables: config.tables,
        counts: Object.fromEntries(Object.keys(local).map((key) => [key, local[key].size])),
      };
    } catch (error) {
      return pending(error.message, { tables: config.tables });
    }
  }
}
