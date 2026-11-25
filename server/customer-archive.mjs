import { createHash } from 'node:crypto';
import { fieldText, mapFeishuRecord } from './feishu.mjs';
import {
  fieldValue,
  customerWebsite,
  encodeCustomerFields,
  resolveCustomerField,
  CUSTOMER_FIELD_ALIASES,
} from './customer-fields.mjs';
import { domainKey } from './website-identity.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const sameFields = (record, fields) =>
  Object.entries(fields).every(
    ([name, value]) => fieldText(fieldValue(record.fields, name)) === fieldText(value),
  );

const companyName = (record) => fieldText(record.fields.公司名称 || record.fields.客户名称).trim();
const reportColumns = new Set(['评级依据摘要', '最近联系时间', '最近回复时间', '邮箱有效性']);

function firstLinkPatch(local, saved, fields) {
  const name = companyName(local);
  const conflict = (reason) =>
    fail(409, `客户「${name}」与飞书同官网记录冲突（${reason}），请核对`);
  if (!name || companyName(saved) !== name) throw conflict('公司名称');
  if (customerWebsite(local) !== customerWebsite(saved)) throw conflict('官网地址');
  const patch = {};
  const blocked = [];
  const progressTime = { 已回复: local.fields.最近回复时间, 已联系: local.fields.最近联系时间 };
  for (const [key, value] of Object.entries(fields)) {
    const current = fieldValue(saved.fields, key);
    if (fieldText(current) === fieldText(value)) continue;
    const empty = current == null || current === '' || (Array.isArray(current) && !current.length);
    if (
      (reportColumns.has(key) && empty) ||
      (key === '开发状态' && fieldText(current) === '待开发' && Number(progressTime[value]) > 0)
    )
      patch[key] = value;
    else blocked.push(key);
  }
  if (blocked.length) throw conflict(blocked.join('、'));
  return patch;
}

// Native acquisition uses local records; only this boundary knows Feishu record IDs.
export class CustomerArchive {
  constructor({ library, remote, decorate = (data) => data }) {
    this.getLibrary = library;
    this.remote = remote;
    this.decorate = decorate;
    this.localFirst = true;
  }
  get library() {
    return (this.currentLibrary ??= this.getLibrary());
  }
  entries() {
    return this.library.db
      .prepare('SELECT data FROM customer_archive_sync WHERE scope=?')
      .all(this.library.scope)
      .map((row) => JSON.parse(row.data));
  }
  entry(id) {
    const row = this.library.db
      .prepare('SELECT data FROM customer_archive_sync WHERE scope=? AND record_id=?')
      .get(this.library.scope, id);
    return row ? JSON.parse(row.data) : null;
  }
  put(entry) {
    this.library.db
      .prepare('INSERT OR REPLACE INTO customer_archive_sync VALUES(?,?,?)')
      .run(this.library.scope, entry.record.record_id, JSON.stringify(entry));
  }
  assertOpen() {
    if (this.closed) throw fail(503, '客户档案正在关闭');
  }
  fields() {
    // The local dossier keeps its complete fields even when the report has fewer columns.
    return [
      ...Object.values(CUSTOMER_FIELD_ALIASES)
        .filter((name) => name !== '初评结果')
        .map((field_name) => ({ field_name, type: 1 })),
      ...['联系人', '邮箱', '电话', '画像JSON', '评级依据', '主要供货机会', '待确认事项'].map(
        (field_name) => ({ field_name, type: 1 }),
      ),
      { field_name: '初评结果', type: 3 },
      { field_name: '最近研究时间', type: 5 },
    ];
  }
  async records() {
    this.assertOpen();
    const entries = new Map(this.entries().map((entry) => [entry.record.record_id, entry.record]));
    return this.library.snapshot(true).leads.map(
      (lead) =>
        entries.get(lead.id) || {
          record_id: lead.id,
          fields: lead.fields,
          created_time: lead.createdAt,
        },
    );
  }
  async record(id) {
    this.assertOpen();
    const { lead } = await this.library.detail(id);
    return (
      this.entry(id)?.record || { record_id: id, fields: lead.fields, created_time: lead.createdAt }
    );
  }
  persist(id) {
    const entry = this.entry(id);
    if (entry)
      this.library.upsert(this.decorate({ leads: [mapFeishuRecord(entry.record)] }).leads[0]);
  }
  async write(action, fields, recordId, clientToken) {
    this.assertOpen();
    if (
      !['insert', 'update'].includes(action) ||
      !fields ||
      typeof fields !== 'object' ||
      Array.isArray(fields)
    )
      throw fail(400, '客户档案写入参数无效');
    if (action === 'insert' && !clientToken) throw fail(400, '新增客户需要稳定操作编号');
    const id =
      action === 'insert'
        ? 'local_' + createHash('sha256').update(clientToken).digest('hex').slice(0, 40)
        : recordId;
    const prior = this.entry(id);
    const old = action === 'update' ? await this.record(id) : prior?.record;
    const record = {
      record_id: id,
      created_time: old?.created_time || Date.now(),
      fields: { ...old?.fields, ...fields },
    };
    const domain = domainKey(customerWebsite(record));
    if (action === 'insert' && !fieldText(record.fields.公司名称 || record.fields.客户名称).trim())
      throw fail(400, '客户档案缺少公司名称');
    if (action === 'insert' && !domain) throw fail(400, '客户档案缺少有效官网');
    if (
      action === 'insert' &&
      this.library
        .snapshot()
        .leads.some((lead) => lead.id !== id && domainKey(lead.website) === domain)
    )
      throw fail(409, '相同官网的客户已存在，请核对原档案');
    const entry = {
      ...prior,
      record,
      remoteId: prior?.remoteId || (action === 'update' && !id.startsWith('local_') ? id : null),
      clientToken: prior?.clientToken || clientToken,
      fields: { ...prior?.fields, ...fields },
      revision: (prior?.revision || 0) + 1,
      syncedRevision: prior?.syncedRevision || 0,
      error: '',
    };
    const lead = this.decorate({ leads: [mapFeishuRecord(record)] }).leads[0];
    this.library.upsert(lead, { mirror: entry });
    return record;
  }
  remoteId(id) {
    return this.entry(id)?.remoteId || (id.startsWith('local_') ? null : id);
  }
  sync() {
    if (this.closed) return Promise.resolve();
    if (this.syncing) return this.syncing;
    this.syncing = this.synchronize().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }
  async synchronize() {
    let definitions;
    for (const queued of this.entries().filter((entry) => entry.revision > entry.syncedRevision)) {
      const id = queued.record.record_id;
      try {
        definitions ??= await this.remote.fields();
        const projected = Object.fromEntries(
          Object.entries(queued.fields).filter(([name]) => resolveCustomerField(definitions, name)),
        );
        const fields = encodeCustomerFields(projected, definitions);
        let remoteId = queued.remoteId;
        if (!remoteId) {
          if (!customerWebsite(fields))
            throw fail(409, '飞书客户表缺少可写的官网字段，无法核对新增记录');
          // Reconcile every insert before creating, including responses lost across a restart.
          const domain = domainKey(customerWebsite(queued.record));
          const matches = (await this.remote.records()).filter(
            (record) => domainKey(customerWebsite(record)) === domain,
          );
          if (matches.length > 1)
            throw fail(409, `客户「${companyName(queued.record)}」在飞书有多条同官网记录，请核对`);
          remoteId = matches[0]?.record_id;
        }
        let saved = remoteId ? await this.remote.record(remoteId) : null;
        if (
          saved &&
          domainKey(customerWebsite(queued.record)) &&
          domainKey(customerWebsite(saved)) !== domainKey(customerWebsite(queued.record))
        )
          throw fail(409, '飞书客户官网已变更，本地档案已保留，请核对客户身份');
        let patch = fields;
        if (!queued.remoteId && remoteId) {
          if (!saved) throw fail(409, '飞书候选记录已不存在，请重新核对');
          const owner = this.library.db
            .prepare(
              `
            SELECT 1 FROM lead_library_customers WHERE scope=? AND record_id=?
            UNION ALL SELECT 1 FROM customer_archive_sync
            WHERE scope=? AND json_extract(data, '$.remoteId')=? AND record_id<>? LIMIT 1
          `,
            )
            .get(this.library.scope, remoteId, this.library.scope, remoteId, id);
          if (owner)
            throw fail(
              409,
              `客户「${companyName(queued.record)}」的飞书记录已属于另一份本地档案，请核对`,
            );
          patch = firstLinkPatch(queued.record, saved, fields);
        }
        if (!saved || !sameFields(saved, fields)) {
          const written = await this.remote.write(
            remoteId ? 'update' : 'insert',
            patch,
            remoteId,
            queued.clientToken,
          );
          remoteId = written.record_id;
          this.put({ ...this.entry(id), remoteId });
          saved = await this.remote.record(remoteId);
        }
        if (!sameFields(saved, fields)) throw fail(502, '飞书读回与本地档案不一致');
        const latest = this.entry(id);
        this.put({
          ...latest,
          remoteId,
          syncedRevision: queued.revision,
          fields: latest.revision === queued.revision ? {} : latest.fields,
          error: '',
          syncedAt: new Date().toISOString(),
        });
      } catch (error) {
        this.put({
          ...this.entry(id),
          error:
            error.status === 409
              ? error.message
              : '飞书同步未完成，本地档案已保存，稍后将自动核对重试',
        });
      }
    }
  }
  close() {
    this.closed = true;
    return this.syncing;
  }
}
