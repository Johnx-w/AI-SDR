import { randomUUID } from 'node:crypto';
import { AssessmentStore } from './assessment-store.mjs';
import { fieldText } from './feishu.mjs';
import {
  assertAssessmentIdentity,
  formatAssessmentEvidence,
  assessmentRating,
  ASSESSMENT_HISTORY_FORMAT,
} from './customer-assessment.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const containsRecord = (value, id) => {
  if (typeof value === 'string') return value === id;
  if (Array.isArray(value)) return value.some((v) => containsRecord(v, id));
  if (value && typeof value === 'object')
    return Object.values(value).some((v) => containsRecord(v, id));
  return false;
};
const publicEntry = (entry) => ({
  ...entry.snapshot,
  recordId: entry.recordId,
  sync: {
    status: entry.historyStatus,
    recordId: entry.historyRecordId || null,
    error: entry.error || null,
  },
});

export class AssessmentService {
  constructor({ env, feishu, store } = {}) {
    this.env = env;
    this.feishu = feishu;
    this.scope = String(env.FEISHU_APP_TOKEN) + '/' + String(env.FEISHU_TABLE_ID);
    this.store =
      store ||
      new AssessmentStore(
        env.ASSESSMENT_DB_PATH || env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH || ':memory:',
        this.scope,
      );
    this.active = new Map();
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.recoverPending().catch(() => {}), 30000);
    this.timer.unref();
    void this.recoverPending().catch(() => {});
  }
  async table() {
    if (this.tableInfo) return this.tableInfo;
    if (this.resolving) return this.resolving;
    this.resolving = (async () => {
      let tableId = this.env.FEISHU_ASSESSMENT_TABLE_ID;
      if (!tableId) {
        const tables = (await this.feishu.tables()).filter((t) => /^T12(?:\s|$)/.test(t.name));
        if (tables.length !== 1) throw fail(503, '未找到唯一T12评估历史表，请检查当前多维表格');
        tableId = tables[0].table_id;
      }
      if (tableId === this.env.FEISHU_TABLE_ID) throw fail(503, 'T12不能配置为客户主表');
      const fields = await this.feishu.fields(tableId);
      const types = new Map(fields.map((f) => [f.field_name, f.type]));
      for (const [name, type] of Object.entries({
        评估ID: 1,
        客户: 18,
        评估时间: 5,
        用户评级: 3,
        评分: 2,
        评级依据: 1,
        规则版本: 1,
      }))
        if (types.get(name) !== type) throw fail(503, 'T12字段缺失或类型不符：' + name);
      const link = fields.find((f) => f.field_name === '客户');
      if (link.property?.table_id !== this.env.FEISHU_TABLE_ID)
        throw fail(503, 'T12客户关联未指向当前T2');
      this.tableInfo = { tableId };
      return this.tableInfo;
    })();
    try {
      return await this.resolving;
    } finally {
      this.resolving = null;
    }
  }
  history(recordId) {
    return this.store.history(recordId).map(publicEntry);
  }
  summary(assessmentId) {
    const entry = this.store.get(assessmentId);
    return entry ? publicEntry(entry) : null;
  }
  latest(recordId) {
    const entry = this.store.history(recordId, 1)[0];
    return entry ? publicEntry(entry) : null;
  }
  async sync(snapshot, recordId) {
    const entry = this.store.prepare(snapshot, recordId);
    return this.syncEntry(entry.id);
  }
  async syncEntry(id) {
    if (this.active.has(id)) return this.active.get(id);
    const promise = this.performSync(id);
    this.active.set(id, promise);
    try {
      return await promise;
    } finally {
      this.active.delete(id);
    }
  }
  expected(entry) {
    return {
      评估ID: entry.id,
      客户: [entry.recordId],
      评估时间: Date.parse(entry.snapshot.evaluatedAt),
      用户评级:
        entry.historyReasonFormat === ASSESSMENT_HISTORY_FORMAT
          ? assessmentRating(entry.snapshot)
          : entry.snapshot.grade,
      评分: entry.snapshot.score,
      评级依据:
        entry.historyReasonFormat === ASSESSMENT_HISTORY_FORMAT
          ? formatAssessmentEvidence(entry.snapshot)
          : entry.snapshot.reason,
      规则版本: entry.snapshot.ruleVersion,
    };
  }
  matches(entry, record) {
    const fields = record.fields || {},
      expected = this.expected(entry);
    return (
      fieldText(fields['评估ID']) === entry.id &&
      containsRecord(fields['客户'], entry.recordId) &&
      Number(fields['评估时间']) === expected['评估时间'] &&
      fieldText(fields['用户评级']) === (expected['用户评级'] || '') &&
      fieldText(fields['评分']).trim() !== '' &&
      Number(fieldText(fields['评分'])) === entry.snapshot.score &&
      fieldText(fields['评级依据']) === expected['评级依据'] &&
      fieldText(fields['规则版本']) === entry.snapshot.ruleVersion
    );
  }
  async lookup(entry, tableId) {
    const records = await this.feishu.records(tableId, 'CurrentValue.[评估ID]="' + entry.id + '"');
    const found = records.filter((r) => fieldText(r.fields?.['评估ID']) === entry.id);
    if (found.length > 1) throw fail(409, 'T12存在相同评估ID的多条记录，需核对');
    if (found.length && !this.matches(entry, found[0]))
      throw fail(409, 'T12已有同ID但内容不同的历史，未覆盖');
    return found[0] || null;
  }
  async performSync(id) {
    const entry = this.store.get(id);
    if (!entry) throw fail(404, '评估记录不存在');
    try {
      const { tableId } = await this.table();
      if (entry.historyTableId && entry.historyTableId !== tableId)
        throw fail(409, '评估目标T12已变更，需核对');
      entry.historyTableId = tableId;
      const customer = await this.feishu.record(entry.recordId);
      assertAssessmentIdentity(entry.snapshot, customer);
      let remote = entry.historyRecordId
        ? await this.feishu.record(entry.historyRecordId, tableId)
        : await this.lookup(entry, tableId);
      if (!remote && entry.historyStatus !== 'pending')
        throw fail(409, 'T12写入结果尚未确认；仅查询核对，不重复创建历史');
      if (!remote) {
        entry.historyStatus = 'writing';
        entry.clientToken ||= randomUUID();
        // The SQLite condition also prevents a second server worker from appending this ID.
        if (!this.store.claimHistoryWrite(entry))
          throw fail(409, '该评估正在由其他任务同步，请稍后核对');
        try {
          const written = await this.feishu.write(
            'insert',
            this.expected(entry),
            null,
            entry.clientToken,
            tableId,
          );
          entry.historyRecordId = written.record_id;
          this.store.save(entry);
        } catch (error) {
          entry.historyStatus = error.remoteCode ? 'pending' : 'uncertain';
          entry.error = error.message || 'T12写入结果待确认';
          this.store.save(entry);
          throw error;
        }
        remote = await this.feishu.record(entry.historyRecordId, tableId);
      }
      if (!this.matches(entry, remote)) throw fail(409, 'T12写入读回不一致，保留待核对');
      entry.historyRecordId = remote.record_id;
      entry.historyStatus = 'synced';
      entry.error = null;
      this.store.save(entry);
      return publicEntry(entry);
    } catch (error) {
      const latest = this.store.get(id);
      if (latest && latest.historyStatus !== 'synced') {
        latest.error = error.status ? error.message : 'T12同步失败，完整评估已保存在服务端';
        this.store.save(latest);
      }
      throw error;
    }
  }
  async retry(recordId, assessmentId) {
    const entry = this.store.get(assessmentId);
    if (!entry || entry.recordId !== recordId) throw fail(404, '客户评估记录不存在');
    return this.syncEntry(entry.id);
  }
  async simplifyHistoryEvidence(id) {
    const entry = this.store.get(id);
    if (!entry || entry.historyStatus !== 'synced' || !entry.historyRecordId)
      throw fail(409, '仅清理已确认同步的历史依据');
    const { tableId } = await this.table();
    if (entry.historyTableId !== tableId) throw fail(409, 'T12已变更，停止清理');
    assertAssessmentIdentity(entry.snapshot, await this.feishu.record(entry.recordId));
    const next = { ...entry, historyReasonFormat: ASSESSMENT_HISTORY_FORMAT };
    let remote = await this.feishu.record(entry.historyRecordId, tableId);
    if (!this.matches(next, remote)) {
      if (!this.matches(entry, remote)) throw fail(409, '历史内容已改变，停止覆盖');
      await this.feishu.write(
        'update',
        { 评级依据: this.expected(next)['评级依据'], 用户评级: this.expected(next)['用户评级'] },
        entry.historyRecordId,
        null,
        tableId,
      );
      remote = await this.feishu.record(entry.historyRecordId, tableId);
      if (!this.matches(next, remote)) throw fail(409, '历史依据清理后读回不一致');
    }
    this.store.save(next);
    return publicEntry(next);
  }
  async recoverPending() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      for (const entry of this.store.pending(10)) await this.syncEntry(entry.id).catch(() => {});
    } finally {
      this.recovering = false;
    }
  }
  close() {
    clearInterval(this.timer);
    this.store.close();
  }
}
