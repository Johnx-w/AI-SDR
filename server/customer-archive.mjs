import { createHash } from 'node:crypto';
import { fieldText, mapFeishuRecord } from './feishu.mjs';
import { fieldValue, customerWebsite, encodeCustomerFields } from './customer-fields.mjs';
import { domainKey } from './website-identity.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const sameFields = (record, fields) =>
  Object.entries(fields).every(
    ([name, value]) => fieldText(fieldValue(record.fields, name)) === fieldText(value),
  );

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
  async ready() {
    if (this.closed) throw fail(503, '客户档案正在关闭');
    if (!this.library.meta) await this.library.refresh();
  }
  async fields(tableId) {
    if (tableId) return this.remote.fields(tableId);
    const row = this.library.db
      .prepare('SELECT data FROM customer_archive_schema WHERE scope=?')
      .get(this.library.scope);
    if (row) return JSON.parse(row.data);
    const fields = await this.remote.fields();
    this.library.db
      .prepare('INSERT OR REPLACE INTO customer_archive_schema VALUES(?,?)')
      .run(this.library.scope, JSON.stringify(fields));
    return fields;
  }
  async records(tableId, filter) {
    if (tableId || filter) return this.remote.records(tableId, filter);
    await this.ready();
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
  async record(id, tableId) {
    if (tableId) return this.remote.record(id, tableId);
    await this.ready();
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
  async write(action, fields, recordId, clientToken, tableId) {
    if (tableId) return this.remote.write(action, fields, recordId, clientToken, tableId);
    await this.ready();
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
        const fields = encodeCustomerFields(queued.fields, definitions);
        let remoteId = queued.remoteId;
        if (!remoteId) {
          // Reconcile every insert before creating, including responses lost across a restart.
          const domain = domainKey(customerWebsite(queued.record));
          const matches = (await this.remote.records()).filter(
            (record) => domainKey(customerWebsite(record)) === domain,
          );
          if (matches.length > 1) throw fail(409, '飞书存在相同官网的重复客户，请核对');
          if (matches.length && !sameFields(matches[0], fields))
            throw fail(409, '飞书已有相同官网但内容不同的客户，本地档案已保留，请核对后再同步');
          remoteId = matches[0]?.record_id;
        }
        let saved = remoteId ? await this.remote.record(remoteId) : null;
        if (
          saved &&
          domainKey(customerWebsite(queued.record)) &&
          domainKey(customerWebsite(saved)) !== domainKey(customerWebsite(queued.record))
        )
          throw fail(409, '飞书客户官网已变更，本地档案已保留，请核对客户身份');
        if (!saved || !sameFields(saved, fields)) {
          const written = await this.remote.write(
            remoteId ? 'update' : 'insert',
            fields,
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
