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
import { acquisitionUrl, subjectName } from './acquisition-subject.mjs';
import { checkMirrorMaintenance } from './mirror-maintenance.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const sameFields = (record, fields) =>
  Object.entries(fields).every(
    ([name, value]) => fieldText(fieldValue(record.fields, name)) === fieldText(value),
  );

const companyName = (record) => fieldText(record.fields.公司名称 || record.fields.客户名称).trim();
const recordCustomerId = (record) => fieldText(record.fields.customer_id);
const unclearMirror = (record) =>
  fail(409, `客户「${companyName(record)}」的飞书经营主体归属不明确，请核对`);
const ownedMirror = (record) =>
  fail(409, `客户「${companyName(record)}」的飞书记录已属于另一份本地档案，请核对`);
const reportColumns = new Set(['评级依据摘要', '最近联系时间', '最近回复时间', '邮箱有效性']);

function matchesMirrorInsert(record, fields, customerId) {
  const savedId = recordCustomerId(record);
  return fields && (!savedId || savedId === customerId) && sameFields(record, fields);
}

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
  constructor({ library, remote, decorate = (data) => data, isMaintaining = () => false }) {
    this.getLibrary = library;
    this.remote = remote;
    this.decorate = decorate;
    this.localFirst = true;
    this.isMaintaining = isMaintaining;
  }
  get library() {
    if (!this.currentLibrary) {
      this.currentLibrary = this.getLibrary();
      this.currentLibrary.db.function('acquisition_subject_name', subjectName);
      this.currentLibrary.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS archive_registered_operator
        ON customer_archive_sync(scope,json_extract(data,'$.acquisition.registration.key'))
        WHERE json_extract(data,'$.acquisition.registration.key') IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS archive_acquisition_owner
        ON customer_archive_sync(scope,json_extract(data,'$.acquisition.operation_id'))
        WHERE json_extract(data,'$.acquisition.operation_id') IS NOT NULL;
        CREATE INDEX IF NOT EXISTS archive_confirmed_acquisition ON customer_archive_sync(scope)
        WHERE json_extract(data,'$.acquisition.confirmed_at') IS NOT NULL;
        CREATE TABLE IF NOT EXISTS acquisition_archive_sources (
          scope TEXT NOT NULL, record_id TEXT NOT NULL, operation_id TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(scope,record_id,operation_id)
        ); CREATE INDEX IF NOT EXISTS acquisition_source_content ON acquisition_archive_sources
          (scope,json_extract(data,'$.content_key')) WHERE json_extract(data,'$.content_key') IS NOT NULL;`);
    }
    return this.currentLibrary;
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
      .prepare(
        `INSERT INTO customer_archive_sync VALUES(?,?,?)
        ON CONFLICT(scope,record_id) DO UPDATE SET data=excluded.data`,
      )
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
  acquisitionMatch({ source_url, name, registration }) {
    const url = acquisitionUrl(source_url);
    const normalizedName = subjectName(name);
    if (registration) {
      const owner = this.library.db
        .prepare(
          `SELECT record_id,json_extract(data,'$.acquisition.name') AS name FROM customer_archive_sync
          WHERE scope=? AND json_extract(data,'$.acquisition.registration.key')=?`,
        )
        .get(this.library.scope, registration.key);
      if (owner) {
        return subjectName(owner.name) === normalizedName
          ? { record_id: owner.record_id }
          : { conflict: '相同登记编号对应不同经营法人名称，主体待核实' };
      }
    }
    const potential = this.library.db
      .prepare(
        `SELECT c.record_id, json_extract(c.summary,'$.name') AS name,
        json_extract(c.summary,'$.website') AS website,
        json_extract(a.data,'$.acquisition.registration.key') AS registration_key,
        json_extract(a.data,'$.acquisition.registration.kind') AS registration_kind
      FROM lead_library_customers c LEFT JOIN customer_archive_sync a
        ON a.scope=c.scope AND a.record_id=c.record_id
      WHERE c.scope=? AND (json_extract(c.summary,'$.domain')=?
        OR acquisition_subject_name(json_extract(c.summary,'$.name'))=?)`,
      )
      .all(this.library.scope, domainKey(url), normalizedName);
    for (const lead of potential) {
      if (lead.registration_key && registration) {
        if (
          subjectName(lead.name) === normalizedName &&
          (lead.registration_kind === 'registered_office' ||
            registration.kind === 'registered_office')
        )
          return { conflict: '同名企业的登记证据或注册地址不一致，主体待核实' };
        continue;
      }
      if (
        acquisitionUrl(lead.website) === url &&
        subjectName(lead.name) === normalizedName &&
        !(lead.registration_key && !registration)
      )
        return { record_id: lead.record_id };
      return { conflict: '同域或名称相近的既有企业缺少可区分的登记依据，主体待核实' };
    }
    return {};
  }
  acquisitionWrite(operationId) {
    return this.library.db
      .prepare(
        `SELECT record_id FROM customer_archive_sync
        WHERE scope=? AND json_extract(data,'$.acquisition.operation_id')=?`,
      )
      .get(this.library.scope, operationId)?.record_id;
  }
  confirmAcquisition(id, operationId) {
    const entry = this.entry(id);
    if (entry?.acquisition?.operation_id !== operationId)
      throw fail(409, '客户档案新增归属与原操作不一致');
    if (!entry.acquisition.confirmed_at) {
      entry.acquisition.confirmed_at = new Date().toISOString();
      this.put(entry);
    }
    return {
      record_id: id,
      operation_id: operationId,
      confirmed_at: entry.acquisition.confirmed_at,
      mode: entry.acquisition.mode,
      job_id: entry.acquisition.job_id,
    };
  }
  acquisitionCaptures() {
    return this.library.db
      .prepare(
        `SELECT record_id AS customerId,
      json_extract(data,'$.acquisition.source_url') AS url,
      json_extract(data,'$.acquisition.confirmed_at') AS capturedAt,
      coalesce(json_extract(data,'$.acquisition.job_id'),'') AS jobId,
      json_extract(data,'$.acquisition.mode') AS mode
      FROM customer_archive_sync WHERE scope=? AND json_extract(data,'$.acquisition.confirmed_at') IS NOT NULL`,
      )
      .all(this.library.scope)
      .map(({ url, ...row }) => ({ ...row, domain: domainKey(url) }));
  }
  observeAcquisition(id, operationId, source) {
    this.library.db
      .prepare('INSERT OR IGNORE INTO acquisition_archive_sources VALUES(?,?,?,?)')
      .run(this.library.scope, id, operationId, JSON.stringify(source));
  }
  acquisitionSources(id) {
    return this.library.db
      .prepare(
        'SELECT data FROM acquisition_archive_sources WHERE scope=? AND record_id=? ORDER BY rowid',
      )
      .all(this.library.scope, id)
      .map(({ data }) => JSON.parse(data));
  }
  acquisitionSourcesByContent(key) {
    return this.library.db
      .prepare(
        `SELECT s.record_id, s.data FROM acquisition_archive_sources s
      JOIN customer_archive_sync a ON a.scope=s.scope AND a.record_id=s.record_id
      WHERE s.scope=? AND json_extract(s.data,'$.content_key')=?
      AND json_extract(a.data,'$.acquisition.confirmed_at') IS NOT NULL
      ORDER BY s.rowid LIMIT 8`,
      )
      .all(this.library.scope, key)
      .map(({ record_id, data }) => ({ record_id, ...JSON.parse(data) }));
  }
  async write(action, fields, recordId, clientToken, acquisition) {
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
    if (action === 'insert' && acquisition) {
      if (prior?.acquisition?.operation_id === acquisition.operation_id) return old;
      const match = this.acquisitionMatch(acquisition);
      if (match.record_id) return { record_id: match.record_id, acquisition_duplicate: true };
      if (match.conflict) return { acquisition_conflict: match.conflict };
    }
    if (
      action === 'insert' &&
      !acquisition &&
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
      ...(acquisition ? { acquisition } : {}),
    };
    const lead = this.decorate({ leads: [mapFeishuRecord(record)] }).leads[0];
    try {
      this.library.upsert(lead, { mirror: entry });
    } catch (error) {
      if (action === 'insert' && acquisition && error.errcode === 2067) {
        const owner = this.acquisitionWrite(acquisition.operation_id);
        if (owner) return this.record(owner);
        const match = this.acquisitionMatch(acquisition);
        if (match.record_id) return { record_id: match.record_id, acquisition_duplicate: true };
        if (match.conflict) return { acquisition_conflict: match.conflict };
      }
      throw error;
    }
    return record;
  }
  remoteId(id) {
    return this.entry(id)?.remoteId || (id.startsWith('local_') ? null : id);
  }
  mirrorOwner(remoteId, id) {
    return this.library.db
      .prepare(
        `SELECT NULL AS registration_key FROM lead_library_customers WHERE scope=? AND record_id=?
        UNION ALL SELECT json_extract(data, '$.acquisition.registration.key') FROM customer_archive_sync
        WHERE scope=? AND json_extract(data, '$.remoteId')=? AND record_id<>? LIMIT 1`,
      )
      .get(this.library.scope, remoteId, this.library.scope, remoteId, id);
  }
  registeredMirror(queued, records, customerId) {
    const registration = queued.acquisition.registration.key;
    const stableMatches = records.filter((record) => recordCustomerId(record) === customerId);
    if (stableMatches.length > 1) throw unclearMirror(queued.record);
    if (stableMatches.length === 1) return stableMatches[0];
    const website = acquisitionUrl(customerWebsite(queued.record));
    const candidates = records.filter((record) => {
      if (acquisitionUrl(customerWebsite(record)) !== website) return false;
      const owner = this.mirrorOwner(record.record_id, queued.record.record_id);
      return !owner?.registration_key || owner.registration_key === registration;
    });
    if (
      candidates.length === 1 &&
      matchesMirrorInsert(candidates[0], queued.mirrorInsert, customerId)
    )
      return candidates[0];
    if (candidates.length) throw unclearMirror(queued.record);
    return null;
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
      checkMirrorMaintenance(this.isMaintaining);
      const id = queued.record.record_id;
      let insertingRegisteredMirror = false;
      try {
        definitions ??= await this.remote.fields();
        const projected = Object.fromEntries(
          Object.entries(queued.fields).filter(([name]) => resolveCustomerField(definitions, name)),
        );
        const fields = encodeCustomerFields(projected, definitions);
        const registration = queued.acquisition?.registration?.key;
        const customerId = registration && `web_${registration}`;
        let remoteId = queued.remoteId;
        if (!remoteId) {
          if (!customerWebsite(fields))
            throw fail(409, '飞书客户表缺少可写的官网字段，无法核对新增记录');
          // Reconcile every insert before creating, including responses lost across a restart.
          const records = await this.remote.records();
          if (registration) {
            if (!companyName({ fields }))
              throw fail(409, '飞书客户表缺少可写的公司名称，无法核对新增记录');
            remoteId = this.registeredMirror(queued, records, customerId)?.record_id;
          } else {
            const domain = domainKey(customerWebsite(queued.record));
            const matches = records.filter(
              (record) => domainKey(customerWebsite(record)) === domain,
            );
            if (matches.length > 1)
              throw fail(
                409,
                `客户「${companyName(queued.record)}」在飞书有多条同官网记录，请核对`,
              );
            remoteId = matches[0]?.record_id;
          }
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
          if (saved?.record_id !== remoteId) throw fail(409, '飞书候选记录已不存在，请重新核对');
          if (this.mirrorOwner(remoteId, id)) throw ownedMirror(queued.record);
          if (registration && matchesMirrorInsert(saved, queued.mirrorInsert, customerId)) {
            this.put({ ...this.entry(id), remoteId });
          } else {
            if (registration && recordCustomerId(saved) !== customerId)
              throw unclearMirror(queued.record);
            patch = firstLinkPatch(queued.record, saved, fields);
          }
        }
        if (!saved || !sameFields(saved, fields)) {
          if (registration && !remoteId) {
            if (queued.mirrorInsert)
              throw fail(409, `客户「${companyName(queued.record)}」的飞书新增结果待核对`);
            // Preserve the projected insert so a compact T2 row can be verified after a lost reply.
            this.put({ ...this.entry(id), mirrorInsert: fields });
            insertingRegisteredMirror = true;
          }
          const written = await this.remote.write(
            remoteId ? 'update' : 'insert',
            patch,
            remoteId,
            queued.clientToken,
          );
          insertingRegisteredMirror = false;
          if (registration && !remoteId && this.mirrorOwner(written.record_id, id))
            throw ownedMirror(queued.record);
          remoteId = written.record_id;
          this.put({ ...this.entry(id), remoteId });
          saved = await this.remote.record(remoteId);
        }
        if (!sameFields(saved, fields)) throw fail(502, '飞书读回与本地档案不一致');
        const { mirrorInsert, ...latest } = this.entry(id);
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
          ...(insertingRegisteredMirror && error.writeNotApplied === true
            ? { mirrorInsert: undefined }
            : {}),
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
