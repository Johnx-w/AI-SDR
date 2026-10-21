import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { domainKey } from './website-identity.mjs';
import { searchPlan } from './search-plan.mjs';
import { locationOptions } from './search-target.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
export function validateCount(value = 20) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 200)
    throw fail(400, '本次新增客户目标必须是 1–200 的整数');
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
  }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL); CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs((1)) WHERE json_extract(data,'$.status') IN ('running','stopping','paused');",
    );
    this.discover = discover;
    this.research = research;
    this.remoteStatus = status;
    this.readLeads = readLeads;
    this.now = now;
    this.schedule = schedule;
    this.provider = provider;
    this.busy = false;
    for (const job of this.list())
      if (['running', 'stopping'].includes(job.status)) {
        job.status = 'paused';
        job.reason = 'interrupted';
        job.pending = job.current ? 1 : 0;
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
      input,
      status: 'running',
      reason: '',
      createdAt: new Date(this.now()).toISOString(),
      elapsedMs: 0,
      target: input.target_count,
      inserted: 0,
      updated: 0,
      skipped: 0,
      rejected: 0,
      failed: 0,
      pending: 0,
      searches: 0,
      researched: 0,
      cursor: 0,
      queue: [],
      seen: [],
      skippedDomains: [],
      rows: [],
      current: null,
      limits: {
        research: input.target_count * 3,
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
    const rows = output?.明细 || [];
    const row = rows.find((r) => domainKey(r.source_url) === item.domain);
    if (output?.新增 === 1 && row?.result === 'inserted' && row.record_id) {
      const leads = await this.readLeads();
      const records = leads.filter(
        (l) => l.id === row.record_id && domainKey(l.website) === item.domain,
      );
      if (records.length !== 1) throw new Error('飞书读回核验失败');
      job.inserted++;
      job.rows.push({
        ...item,
        result: 'inserted',
        record_id: row.record_id,
        name: records[0].name,
        executionId: output.execution_id,
      });
    } else if (output?.更新 === 1 || output?.skipped_existing_count > 0) {
      job.skipped++;
      if (output?.更新 === 1) job.updated++;
      job.rows.push({ ...item, result: 'duplicate', reason: output.reason });
    } else if (
      output?.research &&
      (['rejected', 'insufficient_evidence'].includes(output.research.eligibility?.status) ||
        [
          'product_match',
          'country_match',
          'audience_match',
          'customer_type_match',
          'profile_match',
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
    const latest = this.get(job.id);
    if (latest.status === 'stopping') job.status = 'stopping';
    job.current = null;
    job.pending = 0;
    this.save(job);
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
      while (true) {
        const j = this.get(id);
        checkpoint(j);
        if (!['running', 'stopping'].includes(j.status)) return;
        if (j.inserted >= j.target) {
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
        if (!j.queue.length) {
          const plan = searchPlan(j.input);
          j.searchSignatures ||= [];
          let search;
          // Revisit a query only when excluded domains have changed. This can
          // discover >100 companies without repeating an identical paid search.
          for (let i = 0; i < plan.length; i++) {
            const candidate = plan[j.cursor++ % plan.length];
            const signature = createHash('sha256')
              .update(JSON.stringify([candidate, j.seen.slice(-150)]))
              .digest('hex');
            if (!j.searchSignatures.includes(signature)) {
              j.searchSignatures.push(signature);
              search = candidate;
              break;
            }
          }
          if (!search) {
            this.finish(j, 'exhausted');
            return;
          }
          j.searches++;
          checkpoint(j);
          const found = await this.discover(j.input, search, j.seen);
          const fresh = this.get(id);
          j.status = fresh.status;
          for (const c of found.skipped_existing || []) {
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
                domain,
                source_url: c.source_url,
                source_title: c.source_title || '',
              });
            }
          }
          checkpoint(j);
          continue;
        }
        const item = j.queue.shift();
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
