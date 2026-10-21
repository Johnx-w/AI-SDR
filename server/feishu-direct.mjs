import { platformJson } from './acquisition-config.mjs';
import { fieldText, mapFeishuRecord } from './feishu.mjs';
import { domainKey } from './website-identity.mjs';

const base = 'https://open.feishu.cn/open-apis';
const fail = (message) => Object.assign(new Error(message), { status: 502 });

export class FeishuClient {
  constructor({ env, fetchImpl = fetch }) {
    this.env = env;
    this.fetch = fetchImpl;
    this.token = null;
  }
  tablePath() {
    const { FEISHU_APP_TOKEN: app, FEISHU_TABLE_ID: table } = this.env;
    if (!app || !table) throw fail('飞书表格参数尚未配置');
    return '/bitable/v1/apps/' + encodeURIComponent(app) + '/tables/' + encodeURIComponent(table);
  }
  async accessToken() {
    if (this.token?.until > Date.now()) return this.token.value;
    if (this.tokenPending) return this.tokenPending;
    this.tokenPending = (async () => {
      if (!this.env.FEISHU_APP_ID || !this.env.FEISHU_APP_SECRET)
        throw fail('飞书应用凭证尚未配置');
      const body = await platformJson(
        this.fetch,
        base + '/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: this.env.FEISHU_APP_ID,
            app_secret: this.env.FEISHU_APP_SECRET,
          }),
        },
        '飞书认证',
      );
      if (body.code !== 0 || !body.tenant_access_token) throw fail('飞书应用认证失败');
      this.token = {
        value: body.tenant_access_token,
        until: Date.now() + Math.max(0, (Number(body.expire) || 0) - 60) * 1000,
      };
      return this.token.value;
    })();
    try {
      return await this.tokenPending;
    } finally {
      this.tokenPending = null;
    }
  }
  async request(path, { method = 'GET', body } = {}) {
    const token = await this.accessToken();
    const data = await platformJson(
      this.fetch,
      base + path,
      {
        method,
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      '飞书',
    );
    if (data.code !== 0) {
      if ([99991661, 99991663, 99991664, 99991668].includes(data.code)) this.token = null;
      throw fail('飞书操作失败（代码 ' + String(data.code) + '），请检查权限和字段');
    }
    return data.data;
  }
  async list(resource) {
    const rows = [],
      seen = new Set();
    let cursor = '';
    for (let page = 0; page < 10000; page++) {
      const query = new URLSearchParams({ page_size: resource === 'fields' ? '100' : '500' });
      if (cursor) query.set('page_token', cursor);
      const data = await this.request(this.tablePath() + '/' + resource + '?' + query);
      if (!Array.isArray(data?.items)) throw fail('飞书分页响应异常');
      rows.push(...data.items);
      if (!data.has_more) return rows;
      cursor = data.page_token;
      if (!cursor || seen.has(cursor)) throw fail('飞书分页不完整，已停止操作');
      seen.add(cursor);
    }
    throw fail('飞书分页超过安全上限，未使用不完整结果');
  }
  records() {
    return this.list('records');
  }
  fields() {
    return this.list('fields');
  }
  async readLeads() {
    const records = await this.records();
    return {
      leads: records.map(mapFeishuRecord),
      total: records.length,
      source: 'feishu',
      syncedAt: new Date().toISOString(),
    };
  }
  async record(id) {
    const data = await this.request(this.tablePath() + '/records/' + encodeURIComponent(id));
    if (!data?.record?.record_id) throw fail('飞书记录读回异常');
    return data.record;
  }
  async write(action, fields, recordId, clientToken) {
    const path =
      this.tablePath() +
      '/records' +
      (action === 'update' ? '/' + encodeURIComponent(recordId) : '') +
      (action === 'insert' ? '?client_token=' + encodeURIComponent(clientToken) : '');
    const data = await this.request(path, {
      method: action === 'update' ? 'PUT' : 'POST',
      body: { fields },
    });
    if (!data?.record?.record_id) throw fail('飞书写入未返回记录编号');
    return data.record;
  }
}

export function recordsForDomain(records, domain) {
  return records.filter((r) => domainKey(fieldText(r.fields?.['来源链接'])) === domain);
}

export function encodeResearchFields(raw, definitions) {
  const types = new Map(definitions.map((f) => [f.field_name, f.type]));
  for (const name of [
    '客户名称',
    '来源链接',
    'customer_id',
    '广告代码',
    '需求产品',
    '客户行业画像',
  ])
    if (!types.has(name)) throw fail('客户表缺少迁移必需字段：' + name);
  for (const name of ['广告代码', '需求产品', '客户行业画像'])
    if (types.get(name) !== 1) throw fail('客户表字段必须为文本：' + name);
  if (types.get('客户类型') !== 3) throw fail('客户类型必须为单选字段');
  const fields = {};
  for (const [name, value] of Object.entries(raw)) {
    const type = types.get(name);
    if (!type || value === undefined || value === null || value === '') continue;
    if ([1, 3, 13].includes(type) && typeof value === 'string') fields[name] = value;
    else if ([2, 5].includes(type) && typeof value === 'number') fields[name] = value;
    else if (type === 15 && typeof value === 'string') fields[name] = { text: value, link: value };
    else throw fail('客户表字段类型不兼容：' + name);
  }
  if (!fields['客户名称'] || !fields['来源链接']) throw fail('企业名称或来源链接不足，已阻止写入');
  return fields;
}
