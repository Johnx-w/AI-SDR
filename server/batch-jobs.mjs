import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { domainKey } from './website-identity.mjs';
import { regionalSearchAfter, searchPlan } from './search-plan.mjs';
import { exclusionConditionsKey } from './exclusion-conditions.mjs';
import { validateCountryScope } from './search-target.mjs';
import { websiteAdmissionVersion } from './customer-eligibility.mjs';
import { acquisitionUrl } from './acquisition-subject.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
function discoveryPlanKey(input, plan) {
  try {
    return createHash('sha256')
      .update(JSON.stringify([exclusionConditionsKey(input), plan]))
      .digest('hex');
  } catch (error) {
    // A retired target can still be stopped. Its backlog must not be inherited.
    if (error.status === 400) return null;
    throw error;
  }
}
const researchUsageKeys = [
  'model_calls',
  'repeat_model_calls',
  'cache_hits',
  'input_chars',
  'input_tokens',
  'output_tokens',
  'omitted_pages',
  'truncated_pages',
];
function knownResearchUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const valid = (key) => Number.isSafeInteger(value[key]) && value[key] >= 0;
  if (!['model_calls', 'cache_hits', 'input_chars'].every(valid)) return null;
  return Object.fromEntries(researchUsageKeys.filter(valid).map((key) => [key, value[key]]));
}

function mapDiscoveryContext(job) {
  const references = new Map();
  const mapOnlyUrls = new Set();
  const webUrls = new Set();
  for (const row of job.rows) {
    const url = acquisitionUrl(row.source_url);
    if (row.source_kind === 'maps' && url) mapOnlyUrls.add(url);
    else if (url) webUrls.add(url);
    for (const source of row.discovery_sources || []) {
      if (source.kind === 'maps') references.set(`${source.provider}:${source.reference}`, source);
    }
  }
  for (const url of webUrls) mapOnlyUrls.delete(url);
  return {
    jobId: job.id,
    references,
    mapOnlyUrls,
    blocked: job.mapsPaused,
    used: job.searchStats.filter(({ maps }) => maps?.attempts > 0).length,
    unknown: !!job.pendingSearch && job.searchStats.at(-1)?.maps?.status === 'running',
  };
}

function mapComparison(job) {
  const newRecords = new Set(
    job.rows.filter(({ result }) => result === 'inserted').map(({ record_id }) => record_id),
  );
  const confirmed = new Map();
  for (const row of job.rows) {
    if (!newRecords.has(row.record_id)) continue;
    if (!confirmed.has(row.record_id))
      confirmed.set(row.record_id, { web: false, maps: false, scrapling: false });
    const record = confirmed.get(row.record_id);
    record.web ||= (row.discovery_sources || [{ kind: row.source_kind }]).some(
      ({ kind }) => kind === 'web',
    );
    record.maps ||= row.discovery_sources?.some(({ kind }) => kind === 'maps');
    record.scrapling ||= row.scrapling_evidence;
  }
  const qualifiedNew = {
    websiteOnly: 0,
    mapsOnly: 0,
    both: 0,
    mapsAndScrapling: 0,
    scraplingOnly: 0,
  };
  for (const { web, maps, scrapling } of confirmed.values()) {
    if (web && maps) qualifiedNew.both++;
    else if (maps) qualifiedNew.mapsOnly++;
    else if (web) qualifiedNew.websiteOnly++;
    if (maps && !web && scrapling) qualifiedNew.mapsAndScrapling++;
    else if (scrapling) qualifiedNew.scraplingOnly++;
  }
  const metrics = job.searchStats || [];
  const usage = (source) => {
    const amounts = metrics.map(source).filter(Number.isFinite);
    return {
      reportedSearches: amounts.length,
      reportedCredits: amounts.reduce((sum, amount) => sum + amount, 0),
    };
  };
  return {
    qualifiedNew,
    ...(job.mapsPaused ? { pausedReason: job.mapsPaused } : {}),
    maps: {
      calls: metrics.reduce((sum, { maps }) => sum + (maps?.attempts || 0), 0),
      ...usage(({ maps }) => maps?.usage?.credits),
    },
    website: usage(({ usage }) => usage?.credits),
  };
}

export function validateCount(value = 20) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 200)
    throw fail(400, '本次新增客户目标必须是 1–200 的整数');
  return value;
}
export function validateAutoFirstTouch(value = false) {
  if (typeof value !== 'boolean') throw fail(400, '自动首发开关须为布尔值');
  return value;
}
export function validateResearchBudget(value, targetCount = 20) {
  if (value === undefined) return Math.min(1600, Math.max(12, validateCount(targetCount) * 8));
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 1600)
    throw fail(400, '本轮研究预算必须是 1–1600 的整数');
  return value;
}
const labels = {
  target_reached: '已达到新增目标',
  research_limit: '已达到研究次数上限',
  search_limit: '已达到搜索次数上限',
  time_limit: '已达到 6 小时运行上限',
  exhausted: '当前筛选条件下的候选已处理完',
  stopped: '已停止，已入库客户保留',
  interrupted: '服务中断，继续前需核对当前企业',
  uncertain: '执行结果待确认，已暂停，未自动重复写入',
  manual_pause: '已人工暂停，保留执行进度',
  outreach_deleted: '关联触达计划已删除，自动首发已关闭；等待人工继续获客或删除来源',
  source_deleted: '来源任务已删除，执行历史保留',
};
export class BatchJobs {
  constructor({
    path = ':memory:',
    discover,
    research,
    status,
    readLeads,
    readAcquisitionCaptures = () => [],
    now = Date.now,
    schedule = true,
    provider = 'native',
    scope = '',
    identityVersion,
    onOutreachChange = () => {},
    recoveryIntervalMs = 15000,
    isMaintaining = () => false,
  }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_active_job_per_country ON jobs(COALESCE(json_extract(data,'$.input.country'),'')) WHERE json_extract(data,'$.status') IN ('running','stopping','paused'); DROP INDEX IF EXISTS one_active_job;",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS handoff_entities (
      scope TEXT NOT NULL, record_id TEXT NOT NULL, domain TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(scope,record_id), UNIQUE(scope,domain)
    ); CREATE TABLE IF NOT EXISTS handoff_baselines(scope TEXT PRIMARY KEY, created_at TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS discovery_progress (
      scope TEXT NOT NULL, provider TEXT NOT NULL, schedule_id TEXT NOT NULL, plan_key TEXT NOT NULL,
      cursor INTEGER NOT NULL, queue TEXT NOT NULL,
      PRIMARY KEY(scope,provider,schedule_id,plan_key)
    ); CREATE INDEX IF NOT EXISTS jobs_by_schedule ON jobs(json_extract(data,'$.scheduleId'))
       WHERE json_extract(data,'$.scheduleId') IS NOT NULL`);
    this.discover = discover;
    this.research = research;
    this.remoteStatus = status;
    this.readLeads = readLeads;
    this.readAcquisitionCaptures = readAcquisitionCaptures;
    this.now = now;
    this.schedule = schedule;
    this.provider = provider;
    this.scope = scope || provider;
    this.identityVersion = identityVersion;
    this.onOutreachChange = onOutreachChange;
    this.isMaintaining = isMaintaining;
    this.working = new Set();
    this.resuming = new Set();
    this.closed = false;
    for (const job of this.activeJobs())
      if (['running', 'stopping'].includes(job.status)) {
        job.status = 'paused';
        job.reason = 'interrupted';
        job.pending = job.current ? 1 : 0;
        for (const metric of job.searchStats || [])
          if (metric.status === 'running') {
            metric.status = 'interrupted';
            metric.completedAt = new Date(this.now()).toISOString();
          }
        this.save(job);
      }
    if (this.schedule && this.provider === 'native') {
      this.recoveryTimer = setInterval(() => void this.recoverInterrupted(), recoveryIntervalMs);
      this.recoveryTimer.unref();
      void this.recoverInterrupted();
    }
  }
  save(job, { outreachControl = false } = {}) {
    this.outreachSnapshot = null;
    const stored = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(job.id);
    const latest = stored && JSON.parse(stored.data);
    // A checkpoint may finish after a newer source-control decision.
    if ((latest?.sourceControlRevision || 0) > (job.sourceControlRevision || 0)) {
      for (const key of [
        'sourceControlRevision',
        'sourceResumeRevision',
        'outreachGeneration',
        'outreachAuthorizationRevision',
        'manualPaused',
        'sourcePause',
        'sourceDeletedAt',
        'status',
        'reason',
      ])
        job[key] = latest[key];
      job.input.auto_first_touch = latest.input.auto_first_touch;
      job.autoFirstTouchPaused = latest.autoFirstTouchPaused;
    }
    if (job.manualPaused && ['running', 'stopping', 'paused'].includes(job.status)) {
      job.status = 'paused';
      job.reason = job.sourcePause?.outreachPlanId ? 'outreach_deleted' : 'manual_pause';
    }
    if (job.sourceDeletedAt) {
      job.status = 'partial';
      job.reason = 'source_deleted';
    }
    // Research checkpoints must not overwrite a newer pause from the user.
    if (job.input.auto_first_touch && !outreachControl) {
      const current = this.db
        .prepare(
          "SELECT json_extract(data,'$.autoFirstTouchPaused') AS paused, json_extract(data,'$.autoFirstTouchCancelled') AS cancelled FROM jobs WHERE id=?",
        )
        .get(job.id);
      if (current) {
        job.autoFirstTouchPaused = current.paused === 1;
        job.autoFirstTouchCancelled = current.cancelled === 1;
      }
    }
    job.updatedAt = new Date(this.now()).toISOString();
    this.db.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify(job), job.id);
    return job;
  }
  get(id) {
    const r = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id);
    if (!r) throw fail(404, '任务不存在');
    return JSON.parse(r.data);
  }
  list() {
    return this.db
      .prepare('SELECT data FROM jobs ORDER BY rowid DESC LIMIT 100')
      .all()
      .map((r) => JSON.parse(r.data));
  }
  overview() {
    // The persisted identity ledger is the source of confirmed new companies.
    // Neither the last 100 jobs nor a customer's last research time can replace it.
    const entities = this.db
      .prepare('SELECT record_id,domain,data FROM handoff_entities WHERE scope=?')
      .all(this.scope)
      .map((row) => ({ ...row, data: JSON.parse(row.data) }));
    const jobs = this.db
      .prepare('SELECT data FROM jobs ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(row.data))
      .filter((job) => job.scope === this.scope)
      .map((job) => ({
        id: job.id,
        input: job.input,
        status: job.status,
        countPolicy: job.countPolicy,
        inserted: job.inserted,
        target: job.target,
        updated: job.updated,
        pending: job.pending,
        reason: job.reason,
        message: labels[job.reason] || '',
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      }));
    const captures = entities
      .filter(
        (row) =>
          row.data.count_policy === 'broad-business-v1' &&
          Number.isFinite(Date.parse(row.data.captured_at)),
      )
      .map((row) => ({
        customerId: row.record_id,
        domain: row.domain,
        capturedAt: row.data.captured_at,
        jobId: row.data.created_job || '',
      }));
    const uniqueCaptures = new Map(captures.map((capture) => [capture.customerId, capture]));
    for (const capture of this.readAcquisitionCaptures())
      if (!uniqueCaptures.has(capture.customerId)) uniqueCaptures.set(capture.customerId, capture);
    return { jobs, captures: [...uniqueCaptures.values()], scope: this.scope };
  }
  get busy() {
    return this.working.size > 0 || this.resuming.size > 0;
  }
  activeJobs() {
    return this.db
      .prepare(
        "SELECT data FROM jobs WHERE json_extract(data,'$.status') IN ('running','stopping','paused') ORDER BY rowid DESC",
      )
      .all()
      .map((row) => JSON.parse(row.data));
  }
  active() {
    return this.activeJobs()[0];
  }
  blockingJob(input, scheduleId) {
    return this.activeJobs().find(
      (job) => !scheduleId || !job.scheduleId || job.input.country === input.country,
    );
  }
  findByKey(key) {
    const row = this.db.prepare('SELECT data FROM jobs WHERE idem=?').get(key);
    return row ? JSON.parse(row.data) : null;
  }
  outreachJobs() {
    return (this.outreachSnapshot ??= this.db
      .prepare(
        "SELECT data FROM jobs WHERE json_extract(data,'$.input.auto_first_touch')=1 ORDER BY rowid",
      )
      .all()
      .map((row) => JSON.parse(row.data)));
  }
  controlOutreach(
    id,
    enabled,
    { sourceControlRevision, fromSchedule = false, notify = true } = {},
  ) {
    if (typeof enabled !== 'boolean') throw fail(400, '请明确选择开启或暂停自动首发');
    const job = this.get(id);
    if (job.sourceDeletedAt) throw fail(409, '来源已删除');
    if (job.scheduleId && !fromSchedule) throw fail(409, '请在所属获客计划中管理自动首发');
    if (job.autoFirstTouchCancelled) throw fail(409, '自动首发已取消，不能恢复');
    if (job.sourcePause?.outreachPlanId) {
      const revision = job.sourceControlRevision || 0;
      if (sourceControlRevision !== revision) {
        if (
          enabled &&
          job.input.auto_first_touch &&
          job.outreachAuthorizationRevision === sourceControlRevision
        )
          return job;
        throw fail(409, '来源已更新，请刷新后重新保存自动首发授权');
      }
      if (enabled && !job.input.auto_first_touch) {
        job.outreachGeneration = (job.outreachGeneration || 0) + 1;
        job.outreachAuthorizationRevision = revision;
      }
      job.input.auto_first_touch = enabled;
      job.sourceControlRevision = revision + 1;
      job.autoFirstTouchPaused = !enabled;
    } else {
      if (!job.input.auto_first_touch) throw fail(409, '该任务未授权自动首发');
      job.autoFirstTouchPaused = !validateAutoFirstTouch(enabled);
    }
    this.save(job, { outreachControl: true });
    if (notify) this.onOutreachChange();
    return job;
  }
  cancelOutreach(id, confirmed) {
    if (confirmed !== true) throw fail(400, '请确认取消本轮自动首发');
    const job = this.get(id);
    if (!job.input.auto_first_touch || job.scheduleId)
      throw fail(409, '请在所属获客计划中管理自动首发');
    if (job.autoFirstTouchCancelled) return job;
    job.autoFirstTouchCancelled = true;
    this.save(job, { outreachControl: true });
    this.onOutreachChange();
    return job;
  }
  create(input, key, { scheduleId } = {}) {
    validateCountryScope(input);
    if (!['web', 'tavily_web', undefined].includes(input.acquisition_channel))
      throw fail(400, '该获客渠道已停用');
    input = { ...input, target_count: validateCount(input.target_count) };
    validateAutoFirstTouch(input.auto_first_touch);
    validateAutoFirstTouch(input.auto_follow_up);
    const researchBudget = validateResearchBudget(input.research_budget, input.target_count);
    if (typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key))
      throw fail(400, '无效的 Idempotency-Key');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const old = this.db.prepare('SELECT * FROM jobs WHERE idem=?').get(key);
    if (old) {
      if (old.hash !== hash) throw fail(409, '同一请求编号不能使用不同参数');
      return JSON.parse(old.data);
    }
    if (this.blockingJob(input, scheduleId))
      throw fail(409, '已有未结束任务，请先继续或停止该任务');
    const queryPlan = searchPlan(input);
    const planKey = discoveryPlanKey(input, queryPlan);
    const progress = this.db
      .prepare(
        'SELECT cursor,queue FROM discovery_progress WHERE scope=? AND provider=? AND schedule_id=? AND plan_key=?',
      )
      .get(this.scope, this.provider, scheduleId || '', planKey);
    const queue = progress ? JSON.parse(progress.queue) : [];
    const job = {
      id: randomUUID(),
      provider: this.provider,
      scope: this.scope,
      ...(scheduleId ? { scheduleId } : {}),
      input,
      status: 'running',
      reason: '',
      createdAt: new Date(this.now()).toISOString(),
      elapsedMs: 0,
      target: input.target_count,
      inserted: 0,
      countPolicy: 'broad-business-v1',
      admissionVersion: websiteAdmissionVersion,
      ...(this.identityVersion
        ? { identityVersion: this.identityVersion, mapComparisonVersion: 1 }
        : {}),
      updated: 0,
      skipped: 0,
      rejected: 0,
      failed: 0,
      pending: 0,
      searches: 0,
      researched: 0,
      review: 0,
      queryPlan,
      searchStats: [],
      cursor: progress?.cursor ?? this.historicalCursor(scheduleId, planKey, queryPlan),
      queue,
      carriedCandidates: queue.length,
      seen: queue.map((item) => item.domain),
      skippedDomains: [],
      rows: [],
      current: null,
      limits: {
        research: researchBudget,
        searches: Math.max(20, input.target_count * 3),
        timeMs: 21600000,
      },
    };
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(job.id, key, hash, JSON.stringify(job));
    this.outreachSnapshot = null;
    this.kick(job.id);
    if (input.auto_first_touch) this.onOutreachChange();
    return job;
  }
  historicalCursor(scheduleId, planKey, queryPlan) {
    if (!scheduleId) return 0;
    // Earlier releases discarded their queue, but retained the exact plan and cursor.
    const row = this.db
      .prepare(
        `SELECT json_extract(data,'$.input') AS input,
        json_extract(data,'$.queryPlan') AS plan, json_extract(data,'$.cursor') AS cursor
      FROM jobs WHERE json_extract(data,'$.scope')=? AND json_extract(data,'$.provider')=?
        AND json_extract(data,'$.scheduleId')=? ORDER BY rowid DESC LIMIT 1`,
      )
      .get(this.scope, this.provider, scheduleId);
    if (
      row?.plan !== JSON.stringify(queryPlan) ||
      !Number.isSafeInteger(row.cursor) ||
      row.cursor < 0
    )
      return 0;
    return discoveryPlanKey(JSON.parse(row.input), queryPlan) === planKey ? row.cursor : 0;
  }
  kick(id) {
    if (this.schedule && !this.closed)
      setImmediate(() => {
        if (this.closed) return;
        if (this.isMaintaining()) {
          const j = this.get(id);
          if (j.status === 'stopping') {
            this.finish(j, 'stopped');
          } else if (j.status === 'running') {
            j.status = 'paused';
            j.reason = j.current ? 'uncertain' : 'interrupted';
            j.pending = j.current ? 1 : 0;
            this.save(j);
          }
          return;
        }
        this.work(id).catch(() => {
          if (this.closed) return;
          const j = this.get(id);
          j.status = 'paused';
          j.reason = 'uncertain';
          this.save(j);
        });
      });
  }
  finish(job, reason) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const planKey = job.queryPlan?.length && discoveryPlanKey(job.input, job.queryPlan);
      if (job.scope === this.scope && job.provider === this.provider && planKey) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO discovery_progress
            (scope,provider,schedule_id,plan_key,cursor,queue) VALUES(?,?,?,?,?,?)`,
          )
          .run(
            job.scope,
            job.provider,
            job.scheduleId || '',
            planKey,
            Math.max(
              0,
              job.cursor - (job.pendingSearch && !job.pendingSearch.searchRegion ? 1 : 0),
            ),
            JSON.stringify(job.queue),
          );
      }
      job.reason = reason;
      job.status = reason === 'target_reached' ? 'completed' : 'partial';
      job.completedAt = new Date(this.now()).toISOString();
      job.queue = [];
      job.seen = [];
      job.skippedDomains = [];
      job.searchSignatures = [];
      job.pendingSearch = null;
      job.current = null;
      this.save(job);
      this.db.exec('COMMIT');
      return job;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async reconcile(job) {
    if (!job.current) return;
    const result = await this.remoteStatus(job.current.operation_id);
    if (!result?.settled) throw fail(409, '尚未确认当前企业的执行结果，请稍后继续；未重复执行');
    await this.accept(job, result.output);
  }
  async initializeBaseline() {
    if (this.db.prepare('SELECT 1 FROM handoff_baselines WHERE scope=?').get(this.scope)) return;
    const leads = await this.readLeads();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('SELECT 1 FROM handoff_baselines WHERE scope=?').get(this.scope)) {
        const insert = this.db.prepare('INSERT OR IGNORE INTO handoff_entities VALUES(?,?,?,?)');
        for (const lead of leads) {
          const domain = domainKey(lead.website);
          if (lead.id && domain)
            insert.run(this.scope, lead.id, domain, JSON.stringify({ baseline: true }));
        }
        this.db
          .prepare('INSERT INTO handoff_baselines VALUES(?,?)')
          .run(this.scope, new Date(this.now()).toISOString());
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  claimCapture(job, item, row) {
    if (job.identityVersion)
      return row.capture?.operation_id === item.operation_id &&
        row.capture.record_id === row.record_id &&
        row.capture.mode === 'automatic' &&
        row.capture.job_id === job.id &&
        row.capture.confirmed_at
        ? { newRecord: true, reason: 'new_business_record' }
        : { newRecord: false, reason: 'already_in_lead_library' };
    // Count a company only once across all jobs in the customer library.
    const existing = this.db
      .prepare('SELECT * FROM handoff_entities WHERE scope=? AND (record_id=? OR domain=?)')
      .all(this.scope, row.record_id, item.domain);
    if (existing.length) return { newRecord: false, reason: 'already_in_lead_library' };
    this.db.prepare('INSERT INTO handoff_entities VALUES(?,?,?,?)').run(
      this.scope,
      row.record_id,
      item.domain,
      JSON.stringify({
        created_job: job.id,
        created_operation: item.operation_id,
        count_policy: 'broad-business-v1',
        captured_at: new Date(this.now()).toISOString(),
      }),
    );
    return { newRecord: true, reason: 'new_business_record' };
  }
  async resume(id, { automatic = false, sourceControlRevision } = {}) {
    if (this.closed) throw fail(409, '服务已关闭');
    const current = this.get(id);
    if (
      !automatic &&
      current.sourcePause?.outreachPlanId &&
      sourceControlRevision !== (current.sourceControlRevision || 0) &&
      !(
        sourceControlRevision !== undefined &&
        sourceControlRevision === current.sourceResumeRevision &&
        !current.manualPaused &&
        ['running', 'completed', 'partial'].includes(current.status)
      )
    )
      throw fail(409, '来源控制已变化，请刷新后继续');
    if (
      current.sourcePause?.outreachPlanId &&
      !current.sourceDeletedAt &&
      !current.manualPaused &&
      ['running', 'completed', 'partial'].includes(current.status)
    )
      return current;
    if (this.working.has(id) || this.resuming.has(id) || (this.recovering && !automatic))
      throw fail(409, '当前企业仍在处理中');
    this.resuming.add(id);
    try {
      let job = this.get(id);
      if (job.sourceDeletedAt) throw fail(409, '来源任务已删除，不能继续');
      if (automatic && job.manualPaused) return job;
      const revision = job.sourceControlRevision || 0;
      if (job.status !== 'paused') throw fail(409, '只有暂停任务可以继续');
      if (job.scope !== this.scope) throw fail(409, '任务所属客户库已变化，请切回原客户库再继续');
      if (!['web', 'tavily_web', undefined].includes(job.input.acquisition_channel))
        throw fail(409, '该获客渠道已停用');
      if (job.provider !== this.provider)
        throw fail(409, '该任务由其他执行引擎创建，已停止支持，请核对历史结果');
      if (automatic && this.isMaintaining()) return job;
      await this.reconcile(job);
      if (automatic && (this.closed || this.isMaintaining())) return job;
      job = this.get(id);
      if ((job.sourceControlRevision || 0) !== revision)
        throw fail(409, '来源控制已变化，请刷新后继续');
      // Reconcile any prior write first, then forbid new work in retired markets.
      validateCountryScope(job.input);
      job.status = 'running';
      job.reason = '';
      job.manualPaused = false;
      if (!job.sourcePause?.outreachPlanId || job.input.auto_first_touch)
        job.autoFirstTouchPaused = false;
      job.sourceResumeRevision = revision;
      job.sourceControlRevision = revision + 1;
      this.save(job, { outreachControl: true });
      if (automatic && this.isMaintaining()) {
        job.status = 'paused';
        job.reason = 'interrupted';
        return this.save(job);
      }
      if (job.input.auto_first_touch) this.onOutreachChange();
      this.kick(id);
      return job;
    } finally {
      this.resuming.delete(id);
    }
  }
  recoverInterrupted() {
    if (this.closed || this.recovering || this.isMaintaining()) return this.recoveryPromise;
    this.recovering = true;
    const recovery = this.resumeInterrupted()
      .catch(() => {})
      .finally(() => {
        this.recovering = false;
        if (this.recoveryPromise === recovery) this.recoveryPromise = undefined;
      });
    this.recoveryPromise = recovery;
    return recovery;
  }
  async resumeInterrupted() {
    await Promise.allSettled(this.activeJobs().map((job) => this.resumeJob(job)));
  }
  async resumeJob(job) {
    if (
      this.closed ||
      this.isMaintaining() ||
      this.working.has(job.id) ||
      this.resuming.has(job.id) ||
      this.provider !== 'native' ||
      job.status !== 'paused' ||
      !['interrupted', 'uncertain'].includes(job.reason) ||
      job.provider !== this.provider ||
      job.scope !== this.scope
    )
      return;
    if (job.current) {
      const result = await this.remoteStatus(job.current.operation_id);
      if (this.closed || this.isMaintaining()) return;
      const latest = this.get(job.id);
      if (
        latest.status !== 'paused' ||
        latest.reason !== job.reason ||
        latest.current?.operation_id !== job.current.operation_id
      )
        return;
      if (result?.missing === true) {
        await this.accept(latest, {
          stage: 'status',
          outcome: 'failed',
          reason: result.reason || '操作记录不存在，未重放当前企业',
        });
      } else {
        if (!result?.settled || !result.output) return;
        if (
          result.output.retryable_before_write === true &&
          result.output.outcome === 'failed' &&
          ['extract', 'research'].includes(result.output.stage) &&
          (latest.current.interruptionRetries || 0) < 1 &&
          latest.researched < latest.limits.research
        ) {
          latest.queue.unshift({
            ...latest.current,
            interruptionRetries: (latest.current.interruptionRetries || 0) + 1,
          });
          this.save(latest);
        }
        await this.accept(latest, result.output);
      }
    }
    if (this.closed || this.isMaintaining()) return;
    await this.resume(job.id, { automatic: true });
  }
  stop(id) {
    const j = this.get(id);
    if (j.status === 'paused' && j.current) throw fail(409, '当前写入待确认，请先核对后再停止');
    if (j.input.auto_first_touch && !j.scheduleId) {
      j.autoFirstTouchPaused = true;
      this.save(j, { outreachControl: true });
    }
    if (['running', 'stopping'].includes(j.status)) {
      j.status = 'stopping';
      this.save(j);
    } else if (j.status === 'paused') this.finish(j, 'stopped');
    if (j.input.auto_first_touch) this.onOutreachChange();
    return this.get(id);
  }
  pause(id, { outreachPlanId, reason = '人工暂停', disableFirstTouch = false } = {}) {
    const job = this.get(id);
    if (job.sourceDeletedAt) throw fail(409, '来源任务已删除');
    if (
      job.manualPaused &&
      job.sourcePause?.outreachPlanId === outreachPlanId &&
      (!disableFirstTouch || !job.input.auto_first_touch)
    )
      return job;
    job.manualPaused = true;
    if (outreachPlanId || !job.sourcePause?.outreachPlanId)
      job.sourcePause = { outreachPlanId, reason };
    job.sourceControlRevision = (job.sourceControlRevision || 0) + 1;
    if (disableFirstTouch) job.input.auto_first_touch = false;
    if (disableFirstTouch || !job.scheduleId) job.autoFirstTouchPaused = true;
    this.save(job, { outreachControl: true });
    this.onOutreachChange();
    return this.get(id);
  }
  delete(id) {
    const job = this.get(id);
    if (job.sourceDeletedAt) return job;
    job.sourceDeletedAt = new Date(this.now()).toISOString();
    job.sourceControlRevision = (job.sourceControlRevision || 0) + 1;
    job.input.auto_first_touch = false;
    job.autoFirstTouchPaused = true;
    this.save(job, { outreachControl: true });
    this.onOutreachChange();
    return this.get(id);
  }
  async accept(job, output) {
    const item = job.current;
    if (!item) return;
    const stored = this.get(job.id);
    // A settled operation can be replayed by resume/status or a stale caller.
    // Restore the saved checkpoint instead of recounting either result or usage.
    if (item.operation_id && stored.rows.some((row) => row.operation_id === item.operation_id)) {
      Object.assign(job, stored);
      return;
    }
    const rows = output?.明细 || [];
    const row = rows.find((r) => domainKey(r.source_url) === item.domain);
    const written =
      row?.record_id &&
      ((output?.新增 === 1 && row.result === 'inserted') ||
        (output?.更新 === 1 && row.result === 'updated'));
    let record;
    if (written) {
      const records = (await this.readLeads()).filter(
        (lead) => lead.id === row.record_id && domainKey(lead.website) === item.domain,
      );
      if (records.length !== 1) throw new Error('飞书读回核验失败');
      record = records[0];
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const latestBeforeAccept = this.get(job.id);
      if (
        item.operation_id &&
        latestBeforeAccept.rows.some((row) => row.operation_id === item.operation_id)
      ) {
        this.db.exec('COMMIT');
        Object.assign(job, latestBeforeAccept);
        return;
      }
      if (output?.新增 === 1 && row?.result === 'inserted' && row.record_id) {
        // A target is the number of genuinely new, deduplicated company records.
        // Handoff readiness and completeness remain detail fields, not admission gates.
        const claim = this.claimCapture(job, item, row);
        if (claim.newRecord) job.inserted++;
        else job.skipped++;
        job.rows.push({
          ...item,
          result: claim.newRecord ? 'inserted' : 'duplicate',
          record_id: row.record_id,
          name: record.name,
          executionId: output.execution_id,
          assessment: output.assessment || null,
          handoff: output.handoff || null,
          inserted_new: claim.newRecord,
          qualification_reason: claim.reason,
          ...(row.capture ? { capture: row.capture } : {}),
        });
      } else if (output?.更新 === 1 || output?.skipped_existing_count > 0) {
        job.skipped++;
        if (output?.更新 === 1) job.updated++;
        job.rows.push({
          ...item,
          result: 'duplicate',
          record_id: row?.record_id,
          reason: output.reason,
          assessment: output.assessment || null,
          handoff: output.handoff || null,
          inserted_new: false,
          qualification_reason: 'already_in_lead_library',
          ...(output.research?.company_name ? { name: output.research.company_name } : {}),
        });
      } else if (
        output?.outcome === 'review' ||
        (output?.outcome !== 'rejected' && output?.research?.review_required)
      ) {
        job.review = (job.review || 0) + 1;
        job.rows.push({
          ...item,
          result: 'review',
          reason: output.reason,
        });
      } else if (
        output?.outcome === 'rejected' ||
        (output?.research &&
          (['rejected', 'insufficient_evidence'].includes(output.research.eligibility?.status) ||
            ['product_match', 'country_match', 'customer_type_match', 'profile_match'].some((key) =>
              ['not_matched', 'unknown'].includes(output.research[key]),
            )))
      ) {
        job.rejected++;
        job.rows.push({
          ...(output.collection_attempts?.length
            ? {
                source_url: item.source_url,
                domain: item.domain,
                name: output.research?.company_name || item.source_title,
              }
            : {}),
          search_id: item.search_id,
          operation_id: item.operation_id,
          result: 'rejected',
          reason: output.outcome === 'rejected' ? output.reason : '不符合本次筛选条件',
        });
      } else if (output?.outcome === 'failed' && output.stage !== 'persist') {
        job.failed++;
        job.rows.push({ ...item, result: 'failed', reason: output.reason });
      } else {
        throw new Error('写入结果无法确认');
      }
      const acceptedRow = job.rows.at(-1);
      if (output.collection_attempts) acceptedRow.collection_attempts = output.collection_attempts;
      if (output.collection_gaps) acceptedRow.collection_gaps = output.collection_gaps;
      if (output.research_trace) acceptedRow.research_trace = output.research_trace;
      if (job.mapComparisonVersion) {
        if (item.discovery_sources) acceptedRow.discovery_sources = item.discovery_sources;
        if (output.discovery_sources && acceptedRow.record_id) {
          acceptedRow.discovery_sources = output.discovery_sources;
          const unverified = item.discovery_sources.filter(
            (source) =>
              !output.discovery_sources.some(
                ({ kind, provider, reference }) =>
                  kind === source.kind &&
                  provider === source.provider &&
                  reference === source.reference,
              ),
          );
          if (unverified.length) acceptedRow.unverified_map_sources = unverified;
        }
        if (output.maps_binding) acceptedRow.maps_binding = output.maps_binding;
        if (output.maps_binding === 'mismatch') job.mapsPaused = 'binding_mismatch';
        const cited = new Set(
          [
            ...(output.research?.activity_verification?.sources || []).map(
              ({ snapshot_id }) => snapshot_id,
            ),
            ...(output.research?.company_identity?.evidence || []).map(
              ({ snapshot_id }) => snapshot_id,
            ),
          ].filter(Boolean),
        );
        if (
          acceptedRow.record_id &&
          output.collection_attempts?.some(
            ({ status, method, snapshot_id }) =>
              status === 'ok' && method === 'scrapling' && cited.has(snapshot_id),
          )
        )
          acceptedRow.scrapling_evidence = true;
      }
      if (written) acceptedRow.stored = true;
      const metric = job.searchStats?.find((entry) => entry.id === item.search_id);
      if (metric) {
        metric.researched++;
        const key = {
          inserted: 'inserted',
          duplicate: job.identityVersion && output?.更新 !== 1 ? 'duplicates' : 'updated',
          rejected: 'rejected',
          review: 'review',
          failed: 'failed',
        }[acceptedRow.result];
        if (key && !(key === 'inserted' && acceptedRow.inserted_new === false)) metric[key]++;
        if (acceptedRow.result === 'inserted') {
          const grade = acceptedRow.assessment?.grade;
          const bucket = ['A', 'B', 'C'].includes(grade) ? grade : 'unrated';
          metric.ratings[bucket] = (metric.ratings[bucket] || 0) + 1;
        }
      }
      const latest = this.get(job.id);
      const usage = knownResearchUsage(output?.research_usage);
      if (usage) {
        const total = { ...latest.researchUsage };
        for (const [key, value] of Object.entries(usage)) total[key] = (total[key] || 0) + value;
        job.researchUsage = total;
        acceptedRow.research_usage = usage;
      }
      if (latest.status === 'stopping') job.status = 'stopping';
      job.current = null;
      job.pending = 0;
      this.save(job);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    if (job.input.auto_first_touch) this.onOutreachChange();
  }
  async work(id) {
    if (this.working.has(id)) return;
    this.working.add(id);
    let tick = this.now();
    const checkpoint = (j) => {
      const t = this.now();
      j.elapsedMs += Math.max(0, t - tick);
      tick = t;
      this.save(j);
    };
    try {
      await this.initializeBaseline();
      while (true) {
        const j = this.get(id);
        checkpoint(j);
        if (!['running', 'stopping'].includes(j.status)) return;
        if ((j.inserted || 0) >= j.target) {
          this.finish(j, 'target_reached');
          return;
        }
        if (j.status === 'stopping') {
          this.finish(j, 'stopped');
          return;
        }
        validateCountryScope(j.input);
        if (j.elapsedMs >= j.limits.timeMs) {
          this.finish(j, 'time_limit');
          return;
        }
        if (j.researched >= j.limits.research) {
          this.finish(j, 'research_limit');
          return;
        }
        if (!j.queue.length) {
          if (j.searches >= j.limits.searches) {
            this.finish(j, 'search_limit');
            return;
          }
          const plan = j.queryPlan || searchPlan(j.input);
          j.searchSignatures ||= [];
          const unusedSearch = (candidate) => {
            if (!candidate) return;
            const signature = createHash('sha256')
              .update(JSON.stringify([candidate, j.seen.slice(-150)]))
              .digest('hex');
            if (j.searchSignatures.includes(signature)) return;
            j.searchSignatures.push(signature);
            return candidate;
          };
          let search = j.pendingSearch || unusedSearch(regionalSearchAfter(j));
          // Revisit a query only when excluded domains have changed. This can
          // discover >100 companies without repeating an identical paid search.
          for (let i = 0; !search && i < plan.length; i++) {
            search = unusedSearch(plan[j.cursor++ % plan.length]);
          }
          if (!search) {
            this.finish(j, 'exhausted');
            return;
          }
          const mapsContext = j.mapComparisonVersion ? mapDiscoveryContext(j) : undefined;
          j.searches++;
          j.pendingSearch = search;
          j.searchStats ||= [];
          const metric = {
            id: `${j.id}:search:${j.searches}`,
            query: search.query,
            country: search.country,
            ...(search.searchRegion ? { searchRegion: search.searchRegion } : {}),
            source_kind: search.source_kind || 'web',
            family: search.family,
            startedAt: new Date(this.now()).toISOString(),
            status: 'running',
            discovered: 0,
            filtered: 0,
            filterReasons: {},
            filteredSources: [],
            duplicates: 0,
            queued: 0,
            researched: 0,
            inserted: 0,
            updated: 0,
            rejected: 0,
            review: 0,
            failed: 0,
            ratings: { A: 0, B: 0, C: 0, unrated: 0 },
          };
          j.searchStats.push(metric);
          if (mapsContext) {
            mapsContext.beforeRequest = (attempts) => {
              metric.maps = { status: 'running', attempts, returned: 0, resolved: 0 };
              checkpoint(j);
            };
          }
          checkpoint(j);
          let found;
          try {
            found = await this.discover(j.input, search, j.seen, {
              admissionVersion: j.admissionVersion || 'legacy',
              ...(j.identityVersion ? { identityVersion: j.identityVersion } : {}),
              ...(mapsContext ? { mapsContext } : {}),
            });
          } catch (error) {
            metric.status = 'failed';
            metric.error = error.status ? error.message : '本次搜索未取得结果';
            metric.completedAt = new Date(this.now()).toISOString();
            checkpoint(j);
            throw error;
          }
          metric.status = 'completed';
          metric.completedAt = new Date(this.now()).toISOString();
          metric.usage = found.usage || null;
          if (found.maps) {
            metric.maps = found.maps;
            if (
              found.maps.status === 'paused' ||
              ['permission_denied', 'request_unknown'].includes(found.maps.reason)
            )
              j.mapsPaused = found.maps.reason;
          }
          j.pendingSearch = null;
          for (const c of found.review_candidates || []) {
            j.review++;
            metric.review++;
            j.rows.push({
              ...c,
              result: 'review',
              search_id: metric.id,
              search_query: search.query,
            });
          }
          metric.discovered =
            (found.candidates || []).length +
            (found.skipped_existing || []).length +
            (found.review_candidates || []).length +
            (found.filtered_sources || []).length;
          metric.filtered = (found.filtered_sources || []).length;
          metric.filteredSources = (found.filtered_sources || []).map((item) => ({
            domain: domainKey(item.url),
            reason: item.reason,
          }));
          for (const item of found.filtered_sources || [])
            metric.filterReasons[item.reason] = (metric.filterReasons[item.reason] || 0) + 1;
          const fresh = this.get(id);
          j.status = fresh.status;
          for (const c of found.skipped_existing || []) {
            metric.duplicates++;
            const d = j.identityVersion ? acquisitionUrl(c.url) : domainKey(c.url);
            if (d && !j.skippedDomains.includes(d)) {
              j.skippedDomains.push(d);
              j.skipped++;
            }
          }
          for (const c of found.candidates || []) {
            const domain = domainKey(c.source_url);
            const candidate = j.identityVersion ? acquisitionUrl(c.source_url) : domain;
            if (candidate && (!j.seen.includes(candidate) || c.discovery_sources?.length)) {
              if (!j.seen.includes(candidate)) j.seen.push(candidate);
              j.queue.push({
                ...c,
                source_kind: c.source_kind === 'maps' ? 'maps' : search.source_kind || 'web',
                domain,
                source_url: c.source_url,
                source_title: c.source_title || '',
                search_id: metric.id,
                search_query: search.query,
              });
              metric.queued++;
            } else if (domain) {
              metric.duplicates++;
            }
          }
          // Give the domains just returned by search priority in its bounded exclusion list.
          const repeated = new Set(
            (found.skipped_existing || [])
              .map((c) => (j.identityVersion ? acquisitionUrl(c.url) : domainKey(c.url)))
              .filter(Boolean),
          );
          if (repeated.size)
            j.seen = [...j.seen.filter((domain) => !repeated.has(domain)), ...repeated];
          checkpoint(j);
          continue;
        }
        const item = j.queue.shift();
        if (j.mapsPaused && item.discovery_sources?.some(({ kind }) => kind === 'maps')) {
          const website = item.discovery_sources.filter(({ kind }) => kind === 'web');
          if (!website.length) {
            j.review++;
            const metric = j.searchStats.find(({ id }) => id === item.search_id);
            if (metric) metric.review++;
            j.rows.push({ ...item, result: 'review', reason: '地图路径暂停，待独立核实企业官网' });
            checkpoint(j);
            continue;
          }
          item.discovery_sources = website;
        }
        j.current = {
          ...item,
          operation_id: `${j.id}-${j.researched + 1}`,
          ...(j.identityVersion ? { job_id: j.id } : {}),
        };
        j.researched++;
        checkpoint(j);
        try {
          const output = await this.research(j.input, j.current, {
            admissionVersion: j.admissionVersion || 'legacy',
            ...(j.identityVersion ? { identityVersion: j.identityVersion } : {}),
          });
          const latest = this.get(id);
          j.status = latest.status;
          await this.accept(j, output);
          checkpoint(j);
        } catch {
          j.status = 'paused';
          j.reason = 'uncertain';
          j.pending = 1;
          checkpoint(j);
          return;
        }
      }
    } catch {
      const j = this.get(id);
      j.status = 'paused';
      j.reason = j.current ? 'uncertain' : 'interrupted';
      j.pending = j.current ? 1 : 0;
      checkpoint(j);
    } finally {
      this.working.delete(id);
    }
  }
  view(job, { summary = false } = {}) {
    return {
      ...job,
      ...(summary
        ? {
            summary: true,
            rows: [],
            queryPlan: undefined,
            searchStats: undefined,
            current: undefined,
            pendingSearch: undefined,
          }
        : {}),
      queue: undefined,
      seen: undefined,
      skippedDomains: undefined,
      searchSignatures: undefined,
      ...(!summary && job.mapComparisonVersion ? { mapComparison: mapComparison(job) } : {}),
      message: labels[job.reason] || '正在搜索与研究客户',
      queued: job.queue.length,
    };
  }
  close() {
    if (this.closed) return this.closePromise;
    this.closed = true;
    clearInterval(this.recoveryTimer);
    if (this.recoveryPromise) {
      this.closePromise = this.recoveryPromise.finally(() => this.db.close());
      return this.closePromise;
    }
    this.db.close();
  }
}
