import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { domainKey } from './website-identity.mjs';
import { searchPlan } from './search-plan.mjs';
import { locationOptions } from './search-target.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const researchUsageKeys = [
  'model_calls',
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
export function validateCount(value = 20) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 200)
    throw fail(400, '本次新增客户目标必须是 1–200 的整数');
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
  customs_budget: '已达到本轮海关逐票读取预算；未读取的分页保留供下轮继续',
  stopped: '已停止，已入库客户保留',
  interrupted: '服务中断，继续前需核对当前企业',
  uncertain: '执行结果待确认，已暂停，未自动重复写入',
  qualification_retracted: '交接结果经复核撤销，企业档案与原始评估已保留',
};
export class BatchJobs {
  constructor({
    path = ':memory:',
    discover,
    research,
    status,
    readLeads,
    now = Date.now,
    schedule = true,
    provider = 'n8n',
    scope = '',
  }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs((1)) WHERE json_extract(data,'$.status') IN ('running','stopping','paused');",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS handoff_entities (
      scope TEXT NOT NULL, record_id TEXT NOT NULL, domain TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(scope,record_id), UNIQUE(scope,domain)
    ); CREATE TABLE IF NOT EXISTS handoff_baselines(scope TEXT PRIMARY KEY, created_at TEXT NOT NULL);`);
    this.discover = discover;
    this.research = research;
    this.remoteStatus = status;
    this.readLeads = readLeads;
    this.now = now;
    this.schedule = schedule;
    this.provider = provider;
    this.scope = scope || provider;
    this.busy = false;
    for (const job of this.list())
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
  }
  save(job) {
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
    const relatedJobs = new Set(
      entities.flatMap((row) => [row.data.created_job, row.data.qualified_job]).filter(Boolean),
    );
    const jobs = this.db
      .prepare('SELECT data FROM jobs ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(row.data))
      .filter((job) => job.scope === this.scope || (!job.scope && relatedJobs.has(job.id)))
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
    return { jobs, captures, scope: this.scope };
  }
  active() {
    return this.list().find((j) => ['running', 'stopping', 'paused'].includes(j.status));
  }
  findByKey(key) {
    const row = this.db.prepare('SELECT data FROM jobs WHERE idem=?').get(key);
    return row ? JSON.parse(row.data) : null;
  }
  create(input, key) {
    locationOptions(input.country, input.region);
    input = { ...input, target_count: validateCount(input.target_count) };
    const researchBudget = validateResearchBudget(input.research_budget, input.target_count);
    if (typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key))
      throw fail(400, '无效的 Idempotency-Key');
    const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const old = this.db.prepare('SELECT * FROM jobs WHERE idem=?').get(key);
    if (old) {
      if (old.hash !== hash) throw fail(409, '同一请求编号不能使用不同参数');
      return JSON.parse(old.data);
    }
    if (this.active()) throw fail(409, '已有未结束任务，请先继续或停止该任务');
    const job = {
      id: randomUUID(),
      provider: this.provider,
      scope: this.scope,
      input,
      status: 'running',
      reason: '',
      createdAt: new Date(this.now()).toISOString(),
      elapsedMs: 0,
      target: input.target_count,
      inserted: 0,
      countPolicy: 'broad-business-v1',
      updated: 0,
      skipped: 0,
      rejected: 0,
      failed: 0,
      pending: 0,
      searches: 0,
      customsUsedRecords: 0,
      researched: 0,
      review: 0,
      queryPlan: searchPlan(input),
      searchStats: [],
      cursor: 0,
      queue: [],
      seen: [],
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
    this.kick(job.id);
    return job;
  }
  kick(id) {
    if (this.schedule)
      setImmediate(() =>
        this.work(id).catch(() => {
          const j = this.get(id);
          j.status = 'paused';
          j.reason = 'uncertain';
          this.save(j);
        }),
      );
  }
  finish(job, reason) {
    job.reason = reason;
    job.status = reason === 'target_reached' ? 'completed' : 'partial';
    job.completedAt = new Date(this.now()).toISOString();
    return this.save(job);
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
    // Reuse the existing persistent identity ledger. Legacy readiness claims
    // remain auditable, but a new target can only count a new company once.
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
  // Deliberately local-only: there is no HTTP route for invalidating a business
  // result. The operator must archive the job before calling this method.
  retractQualification(jobId, operationId, reason) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000)
      throw fail(400, '撤销交接认领必须填写1–2000字的复核原因');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const job = this.get(jobId);
      const rows = job.rows.filter((row) => row.operation_id === operationId);
      if (rows.length !== 1) throw fail(409, '未找到唯一的原始交接认领明细');
      const row = rows[0];
      if (row.qualification_retraction && row.qualified_new === false) {
        this.db.exec('COMMIT');
        return job;
      }
      if (this.busy || this.resuming || this.active())
        throw fail(409, '仍有未结束任务，停止或核对后才能撤销交接认领');
      if (!['completed', 'partial'].includes(job.status) || job.current)
        throw fail(409, '只能复核已结束且没有待确认写入的任务');
      if (row.qualified_new !== true || !Number.isSafeInteger(job.qualified) || job.qualified < 1)
        throw fail(409, '该明细没有可撤销的交接认领');
      const entry = this.db
        .prepare('SELECT data FROM handoff_entities WHERE scope=? AND record_id=? AND domain=?')
        .get(this.scope, row.record_id, row.domain);
      const state = entry && JSON.parse(entry.data);
      if (!state || state.qualified_job !== jobId || state.qualified_operation !== operationId)
        throw fail(409, '当前认领所属任务或表格不一致，未撤销其他任务的认领');
      const metric = job.searchStats?.find((item) => item.id === row.search_id);
      if (metric && (!Number.isSafeInteger(metric.qualified) || metric.qualified < 1))
        throw fail(409, '搜索统计与原始交接认领不一致，未自动扣减');
      const audit = {
        at: new Date(this.now()).toISOString(),
        reason: reason.trim(),
        previous_qualified_new: row.qualified_new,
        previous_qualification_reason: row.qualification_reason,
        claim: {
          qualified_job: state.qualified_job,
          qualified_operation: state.qualified_operation,
          qualified_at: state.qualified_at,
        },
      };
      state.qualification_retractions ||= [];
      state.qualification_retractions.push(audit);
      delete state.qualified_job;
      delete state.qualified_operation;
      delete state.qualified_at;
      this.db
        .prepare('UPDATE handoff_entities SET data=? WHERE scope=? AND record_id=? AND domain=?')
        .run(JSON.stringify(state), this.scope, row.record_id, row.domain);
      job.qualified--;
      if (metric) metric.qualified--;
      row.qualified_new = false;
      row.qualification_reason = 'qualification_retracted';
      row.qualification_retraction = audit;
      job.qualificationRetractions ||= [];
      job.qualificationRetractions.push({
        operation_id: operationId,
        record_id: row.record_id,
        reason: audit.reason,
        at: audit.at,
      });
      if (job.qualified < job.target) {
        job.status = 'partial';
        job.reason = 'qualification_retracted';
      }
      this.save(job);
      this.db.exec('COMMIT');
      return job;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  async resume(id) {
    if (this.busy || this.resuming) throw fail(409, '当前企业仍在处理中');
    this.resuming = true;
    try {
      let job = this.get(id);
      if (job.status !== 'paused') throw fail(409, '只有暂停任务可以继续');
      if ((job.provider || 'n8n') !== this.provider)
        throw fail(409, '该任务由其他执行引擎创建，请切回原引擎核对后继续');
      await this.reconcile(job);
      job = this.get(id);
      // Reconcile any prior write first, then forbid new work in retired markets.
      locationOptions(job.input.country, job.input.region);
      job.status = 'running';
      job.reason = '';
      this.save(job);
      this.kick(id);
      return job;
    } finally {
      this.resuming = false;
    }
  }
  stop(id) {
    const j = this.get(id);
    if (j.status === 'paused' && j.current) throw fail(409, '当前写入待确认，请先核对后再停止');
    if (['running', 'stopping'].includes(j.status)) {
      j.status = 'stopping';
      this.save(j);
    } else if (j.status === 'paused') this.finish(j, 'stopped');
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
          preferenceEvidence: output.research?.preference_evidence || [],
          handoff: output.handoff || null,
          inserted_new: claim.newRecord,
          qualification_reason: claim.reason,
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
        });
      } else if (output?.outcome === 'review' || output?.research?.review_required) {
        job.review = (job.review || 0) + 1;
        job.rows.push({
          ...item,
          result: 'review',
          reason: output.reason,
          requirementChecks: output.research?.requirement_checks || [],
        });
      } else if (
        output?.research &&
        (['rejected', 'insufficient_evidence'].includes(output.research.eligibility?.status) ||
          [
            'product_match',
            'country_match',
            'audience_match',
            'customer_type_match',
            'profile_match',
            'required_match',
          ].some(
            (key) =>
              ['not_matched', 'unknown'].includes(output.research[key]) &&
              (key !== 'audience_match' || output.research[key] === 'not_matched'),
          ))
      ) {
        job.rejected++;
        job.rows.push({ ...item, result: 'rejected', reason: output.reason });
      } else if (output?.outcome === 'failed' && output.stage !== 'persist') {
        job.failed++;
        job.rows.push({ ...item, result: 'failed', reason: output.reason });
      } else {
        throw new Error('写入结果无法确认');
      }
      const acceptedRow = job.rows.at(-1);
      if (item.customs_buyer_key && ['inserted', 'duplicate'].includes(acceptedRow.result))
        job.queue = job.queue.filter(
          (candidate) => candidate.customs_buyer_key !== item.customs_buyer_key,
        );
      const metric = job.searchStats?.find((entry) => entry.id === item.search_id);
      if (metric) {
        metric.researched++;
        const key = {
          inserted: 'inserted',
          duplicate: 'updated',
          rejected: 'rejected',
          review: 'review',
          failed: 'failed',
        }[acceptedRow.result];
        if (key && !(key === 'inserted' && acceptedRow.inserted_new === false)) metric[key]++;
        if (acceptedRow.result === 'inserted') {
          const grade = acceptedRow.assessment?.grade;
          metric.ratings[['A', 'B', 'C'].includes(grade) ? grade : 'unrated']++;
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
  }
  async work(id) {
    if (this.busy) return;
    this.busy = true;
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
        locationOptions(j.input.country, j.input.region);
        if (j.elapsedMs >= j.limits.timeMs) {
          this.finish(j, 'time_limit');
          return;
        }
        if (j.searches >= j.limits.searches) {
          this.finish(j, 'search_limit');
          return;
        }
        if (j.researched >= j.limits.research) {
          this.finish(j, 'research_limit');
          return;
        }
        const initialSource =
          j.input.acquisition_channel === 'dual'
            ? ['customs', 'web'].find(
                (source) =>
                  !(j.searchStats || []).some(
                    (entry) => entry.source_kind === source && entry.status === 'completed',
                  ),
              )
            : null;
        const preferredSource =
          initialSource ||
          (j.input.acquisition_channel === 'dual' && j.lastDiscoverySource
            ? j.lastDiscoverySource === 'customs'
              ? 'web'
              : 'customs'
            : null);
        if (!j.queue.length || initialSource) {
          const plan = j.queryPlan || searchPlan(j.input);
          j.searchSignatures ||= [];
          let search = j.pendingSearch;
          // Revisit a query only when excluded domains have changed. This can
          // discover >100 companies without repeating an identical paid search.
          for (let i = 0; !search && i < plan.length * (preferredSource ? 2 : 1); i++) {
            const candidate = plan[j.cursor++ % plan.length];
            if (
              preferredSource &&
              i < plan.length &&
              (candidate.source_kind || 'web') !== preferredSource
            )
              continue;
            if (
              candidate.source_kind === 'customs' &&
              (j.customsUsedRecords || 0) >= (j.input.customs_record_budget || 300)
            )
              continue;
            const signature = createHash('sha256')
              .update(
                JSON.stringify([
                  candidate,
                  candidate.source_kind === 'customs' ? [] : j.seen.slice(-150),
                ]),
              )
              .digest('hex');
            if (!j.searchSignatures.includes(signature)) {
              j.searchSignatures.push(signature);
              search = candidate;
              break;
            }
          }
          if (!search) {
            this.finish(
              j,
              (j.customsBudgetExhausted ||
                (j.customsUsedRecords || 0) >= (j.input.customs_record_budget || 300)) &&
                plan.some((s) => s.source_kind === 'customs')
                ? 'customs_budget'
                : 'exhausted',
            );
            return;
          }
          j.searches++;
          j.pendingSearch = search;
          j.searchStats ||= [];
          const metric = {
            id: `${j.id}:search:${j.searches}`,
            query: search.query,
            country: search.country,
            source_kind: search.source_kind || 'web',
            family: search.family,
            startedAt: new Date(this.now()).toISOString(),
            status: 'running',
            discovered: 0,
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
          checkpoint(j);
          let found;
          try {
            found = await this.discover(
              j.input,
              {
                ...search,
                run_id: j.id,
                remaining_budget: Math.max(
                  0,
                  (j.input.customs_record_budget || 300) - (j.customsUsedRecords || 0),
                ),
              },
              j.seen,
            );
          } catch (error) {
            metric.status = 'failed';
            metric.error = error.status ? error.message : '本次搜索未取得结果';
            metric.completedAt = new Date(this.now()).toISOString();
            checkpoint(j);
            throw error;
          }
          metric.status = 'completed';
          j.lastDiscoverySource = search.source_kind || 'web';
          metric.completedAt = new Date(this.now()).toISOString();
          metric.usage = found.usage || null;
          if (found.usage?.budget_exhausted) j.customsBudgetExhausted = true;
          j.pendingSearch = null;
          j.customsUsedRecords = Math.max(
            j.customsUsedRecords || 0,
            found.usage?.run_used_records || 0,
          );
          if (
            found.next_search &&
            !plan.some((s) => JSON.stringify(s) === JSON.stringify(found.next_search))
          ) {
            j.queryPlan ||= plan;
            // These three packs are customs-primary. Continue paginating them
            // before the web fallback, without starving the other first pages.
            const webIndex = j.queryPlan.findIndex((s) => s.source_kind === 'web');
            if (webIndex < 0) j.queryPlan.push(found.next_search);
            else j.queryPlan.splice(webIndex, 0, found.next_search);
          }
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
            (found.review_candidates || []).length;
          const fresh = this.get(id);
          j.status = fresh.status;
          for (const c of found.skipped_existing || []) {
            metric.duplicates++;
            const d = domainKey(c.url);
            if (d && !j.skippedDomains.includes(d)) {
              j.skippedDomains.push(d);
              j.skipped++;
            }
          }
          for (const c of found.candidates || []) {
            const domain = domainKey(c.source_url);
            if (domain && !j.seen.includes(domain)) {
              j.seen.push(domain);
              j.queue.push({
                ...c,
                source_kind: search.source_kind || 'web',
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
          checkpoint(j);
          continue;
        }
        if (j.input.acquisition_channel === 'dual' && j.lastResearchSource) {
          const next = j.queue.findIndex((item) => item.source_kind !== j.lastResearchSource);
          if (next > 0) j.queue.unshift(...j.queue.splice(next, 1));
        }
        const item = j.queue.shift();
        j.lastResearchSource = item.source_kind || 'web';
        j.current = { ...item, operation_id: `${j.id}-${j.researched + 1}` };
        j.researched++;
        checkpoint(j);
        try {
          const output = await this.research(j.input, j.current);
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
      this.busy = false;
    }
  }
  view(job) {
    return {
      ...job,
      queue: undefined,
      seen: undefined,
      skippedDomains: undefined,
      searchSignatures: undefined,
      message: labels[job.reason] || '正在搜索与研究客户',
      queued: job.queue.length,
    };
  }
  close() {
    this.db.close();
  }
}
