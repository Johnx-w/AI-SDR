import { createHash } from 'node:crypto';
import { FeishuClient } from './feishu-direct.mjs';

const categories = {
  ventilation: '透气窗',
  shutters: '百叶窗',
  indoor: '室内成品帘',
  outdoor: '户外遮阳',
  other: '其他',
};
const directions = { finished: '成品', materials: '材料配件', samples: '样本展示' };
const statuses = { draft: '待审核', approved: '已审核', archived: '已归档' };
const select = (field_name, names) => ({
  field_name,
  type: 3,
  property: { options: names.map((name) => ({ name })) },
});

// Ordered for creation: 产品编号 is the primary field. No business facts are seeded.
export const PRODUCT_KNOWLEDGE_FEISHU_FIELDS = [
  { field_name: '产品编号', type: 1 },
  { field_name: '产品名称', type: 1 },
  { field_name: '英文名称', type: 1 },
  select('品类', Object.values(categories)),
  select('供货方向', Object.values(directions)),
  { field_name: '采购形态', type: 1 },
  { field_name: '产品别名', type: 1 },
  { field_name: '已核实参数', type: 1 },
  { field_name: 'MOQ', type: 1 },
  { field_name: '常规交期', type: 1 },
  { field_name: '适用品牌', type: 1 },
  { field_name: '适用市场', type: 1 },
  { field_name: '来源链接', type: 15 },
  { field_name: '附件链接', type: 1 },
  select('审核状态', Object.values(statuses)),
  { field_name: '资料版本', type: 2 },
  { field_name: '生效日期', type: 1 },
  { field_name: '审核人', type: 1 },
  { field_name: '审核时间', type: 5 },
  { field_name: '最近更新时间', type: 5 },
  { field_name: '备注', type: 1 },
];

const locks = new Map();
const pending = (error, details = {}) => ({ status: 'pending', ...details, error });
const problem = (message) => new Error(message);
const text = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'object') return value.text || value.link || value.name || '';
  return String(value);
};
const empty = (value) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
const comparable = (value, type) => {
  if (empty(value)) return null;
  if ([2, 5].includes(type)) return Number(value);
  if (type === 15)
    return typeof value === 'object' && !Array.isArray(value)
      ? value.link || value.url || text(value)
      : text(value);
  return text(value).replace(/\r\n/g, '\n');
};

function encoded(product) {
  if (
    !product ||
    typeof product.id !== 'string' ||
    !product.id ||
    product.id.length > 200 ||
    !Number.isInteger(product.version) ||
    product.version < 1 ||
    !categories[product.category] ||
    !directions[product.direction] ||
    !statuses[product.status] ||
    !product.name ||
    !Number.isFinite(Date.parse(product.updatedAt))
  )
    throw problem('本地产品资料不完整，尚不能同步 T5');
  const lines = (items) => (items || []).join('\n') || null;
  const date = (value) => {
    if (!value) return null;
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) throw problem('本地产品审核时间无效，尚不能同步 T5');
    return parsed;
  };
  return {
    产品编号: product.id,
    产品名称: product.name,
    英文名称: product.englishName || null,
    品类: categories[product.category],
    供货方向: directions[product.direction],
    采购形态: lines(product.deliveryForms),
    产品别名: lines(product.aliases),
    已核实参数: product.specifications || null,
    MOQ: product.moq || null,
    常规交期: product.leadTime || null,
    适用品牌: lines(product.brands),
    适用市场: lines(product.markets),
    来源链接: product.sourceUrl ? { text: product.sourceUrl, link: product.sourceUrl } : null,
    附件链接: lines(product.attachments),
    审核状态: statuses[product.status],
    资料版本: product.version,
    生效日期: product.effectiveDate || null,
    审核人: product.approvedBy || null,
    审核时间: date(product.approvedAt),
    最近更新时间: date(product.updatedAt),
    备注: product.notes || null,
  };
}

function matches(record, expected) {
  return PRODUCT_KNOWLEDGE_FEISHU_FIELDS.every(({ field_name, type }) =>
    Object.is(
      comparable(record.fields?.[field_name], type),
      comparable(expected[field_name], type),
    ),
  );
}

function clientToken(product) {
  const hash = createHash('sha256')
    .update(product.id + ':' + product.version)
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// The website's local product facts are authoritative. This module only mirrors
// their current state; it never imports table edits or creates tables itself.
export class ProductKnowledgeFeishu {
  constructor({ env = {}, fetchImpl = fetch, client } = {}) {
    this.env = env;
    this.client = client || new FeishuClient({ env, fetchImpl });
    this.configured =
      Boolean(client) ||
      ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_APP_TOKEN', 'FEISHU_TABLE_ID'].every(
        (key) => typeof env[key] === 'string' && env[key].trim(),
      );
  }
  async info() {
    if (!this.configured)
      return {
        configured: false,
        status: 'not_configured',
        error: '尚未配置飞书连接，产品资料已保存在本地',
      };
    try {
      const tables = (await this.client.tables()).filter((table) => table.name === 'T5 产品资料库');
      if (!tables.length)
        return {
          configured: false,
          status: 'not_configured',
          error: '尚未建立 T5 产品资料库，产品资料已保存在本地',
        };
      if (tables.length !== 1)
        return { configured: false, ...pending('发现多张同名 T5 产品资料库，请先核对表格') };
      const tableId = tables[0].table_id;
      const fields = await this.client.fields(tableId);
      for (const expected of PRODUCT_KNOWLEDGE_FEISHU_FIELDS) {
        const field = fields.find((item) => item.field_name === expected.field_name);
        if (!field || field.type !== expected.type)
          return {
            configured: false,
            ...pending('T5 字段“' + expected.field_name + '”缺失或类型不符', { tableId }),
          };
        if (expected.type === 3) {
          const names = new Set((field.property?.options || []).map((option) => option.name));
          if (expected.property.options.some((option) => !names.has(option.name)))
            return {
              configured: false,
              ...pending('T5 字段“' + expected.field_name + '”选项不完整', { tableId }),
            };
        }
      }
      return { configured: true, tableId, status: 'ready' };
    } catch {
      return { configured: false, ...pending('读取 T5 配置失败，请检查飞书连接及表格权限') };
    }
  }
  async sync(product) {
    let snapshot;
    try {
      snapshot = structuredClone(product);
    } catch {
      return pending('本地产品资料无效，尚不能同步 T5');
    }
    const key = String(this.env.FEISHU_APP_TOKEN || '') + '/' + String(snapshot?.id || '');
    const previous = locks.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.syncCurrent(snapshot));
    locks.set(key, operation);
    try {
      return await operation;
    } finally {
      if (locks.get(key) === operation) locks.delete(key);
    }
  }
  async syncCurrent(product) {
    const config = await this.info();
    const version = product?.version;
    if (!config.configured)
      return {
        status: config.status === 'pending' ? 'pending' : 'not_configured',
        ...(config.tableId ? { tableId: config.tableId } : {}),
        version,
        error: config.error,
      };
    const tableId = config.tableId;
    const details = { tableId, version };
    let expected;
    try {
      expected = encoded(product);
    } catch {
      return pending('本地产品资料不完整，尚不能同步 T5', details);
    }
    const find = async () => {
      const records = (await this.client.records(tableId)).filter(
        (record) => text(record.fields?.['产品编号']) === product.id,
      );
      if (records.length > 1) throw problem('发现重复产品编号，请先核对 T5 后再同步');
      return records[0] || null;
    };
    let existing;
    try {
      existing = await find();
    } catch {
      return pending('读取 T5 产品记录失败或发现重复产品编号，请核对后再同步', details);
    }
    if (existing && Number(existing.fields?.['资料版本']) > product.version)
      return pending('T5 已有更高版本资料，请刷新本地产品后核对', {
        ...details,
        recordId: existing.record_id,
      });
    if (existing && matches(existing, expected)) {
      try {
        const readback = await this.client.record(existing.record_id, tableId);
        if (matches(readback, expected))
          return { status: 'synced', ...details, recordId: readback.record_id };
      } catch {
        /* A read is insufficiently verified; leave an actionable pending state. */
      }
      return pending('T5 产品读回未能核对，请稍后重新同步', {
        ...details,
        recordId: existing.record_id,
      });
    }
    const fields = existing
      ? expected
      : Object.fromEntries(Object.entries(expected).filter(([, value]) => value !== null));
    try {
      const written = await this.client.write(
        existing ? 'update' : 'insert',
        fields,
        existing?.record_id,
        clientToken(product),
        tableId,
      );
      const readback = await this.client.record(written.record_id, tableId);
      if (!matches(readback, expected))
        return pending('T5 写入后字段核对不一致，请核对后重新同步', {
          ...details,
          recordId: written.record_id,
        });
      return { status: 'synced', ...details, recordId: readback.record_id };
    } catch {
      // The remote write may have succeeded. Reconcile with reads only; never
      // issue a second write in this attempt or trust a partial write response.
      try {
        const reconciled = await find();
        if (reconciled) {
          const readback = await this.client.record(reconciled.record_id, tableId);
          if (matches(readback, expected))
            return { status: 'synced', ...details, recordId: readback.record_id };
        }
      } catch {
        /* Preserve pending when identity or readback remains uncertain. */
      }
      return pending('T5 写入结果尚未确认，本地资料已保存；请核对后重新同步', {
        ...details,
        ...(existing ? { recordId: existing.record_id } : {}),
      });
    }
  }
}
