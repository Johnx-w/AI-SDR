import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateAutoFirstTouch } from './batch-jobs.mjs';
import { validateTiming, nextOccurrence } from '../src/domain/schedule-timing.mjs';
export { validateTiming, nextOccurrence } from '../src/domain/schedule-timing.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });

export class AcquisitionSchedules {
  constructor({
    path = ':memory:',
    jobs,
    ready,
    available,
    checkInput = () => {},
    now = Date.now,
    scope = '',
    onOutreachChange = () => {},
    isMaintaining = () => false,
  }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL);',
    );
    this.jobs = jobs;
    this.ready = ready;
    this.available = available;
    this.checkInput = checkInput;
    this.now = now;
    this.scope = scope;
    this.onOutreachChange = onOutreachChange;
    this.isMaintaining = isMaintaining;
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS outreach_authorizations(id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    );
    this.recoverAuthorizations();
  }
  recoverAuthorizations() {
    for (const row of this.db.prepare('SELECT data FROM outreach_authorizations').all()) {
      const { plan, job } = JSON.parse(row.data);
      // A crash before completion rolls the unacknowledged authorization back.
      if (job) {
        const manager = this.jobs();
        const current = manager.get(job.id);
        if ((current.sourceControlRevision || 0) <= (job.sourceControlRevision || 0) + 1) {
          for (const key of [
            'sourceControlRevision',
            'sourceResumeRevision',
            'outreachGeneration',
            'outreachAuthorizationRevision',
            'autoFirstTouchPaused',
          ]) {
            if (Object.hasOwn(job, key)) current[key] = job[key];
            else delete current[key];
          }
          current.input.auto_first_touch = job.input.auto_first_touch;
          current.input.auto_follow_up = job.input.auto_follow_up;
          manager.db
            .prepare('UPDATE jobs SET data=? WHERE id=?')
            .run(JSON.stringify(current), job.id);
        }
        manager.outreachSnapshot = null;
      }
      const stored = this.db.prepare('SELECT data FROM schedules WHERE id=?').get(plan.id);
      const latest = stored && JSON.parse(stored.data);
      if (latest && (latest.sourceControlRevision || 0) <= (plan.sourceControlRevision || 0) + 1)
        this.db
          .prepare('UPDATE schedules SET data=? WHERE id=?')
          .run(JSON.stringify(plan), plan.id);
      this.db.prepare('DELETE FROM outreach_authorizations WHERE id=?').run(plan.id);
    }
  }
  list() {
    this.recoverAuthorizations();
    return this.db
      .prepare('SELECT data FROM schedules ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(row.data));
  }
  get(id) {
    this.recoverAuthorizations();
    const row = this.db.prepare('SELECT data FROM schedules WHERE id=?').get(id);
    if (!row) throw fail(404, '定时计划不存在');
    return JSON.parse(row.data);
  }
  save(plan) {
    const row = this.db.prepare('SELECT data FROM schedules WHERE id=?').get(plan.id);
    const latest = row && JSON.parse(row.data);
    if ((latest?.sourceControlRevision || 0) > (plan.sourceControlRevision || 0)) {
      for (const key of [
        'sourceControlRevision',
        'outreachAuthorizationRevision',
        'sourcePause',
        'sourceDeletedAt',
        'status',
        'nextRunAt',
        'lastError',
      ])
        plan[key] = latest[key];
      plan.input.auto_first_touch = latest.input.auto_first_touch;
      plan.input.auto_follow_up = latest.input.auto_follow_up;
    }
    plan.updatedAt = new Date(this.now()).toISOString();
    this.db.prepare('UPDATE schedules SET data=? WHERE id=?').run(JSON.stringify(plan), plan.id);
    return plan;
  }
  view(plan, { summary = false } = {}) {
    let lastJob = null;
    if (plan.lastJobId) {
      try {
        lastJob = this.jobs().view(this.jobs().get(plan.lastJobId), { summary });
      } catch {
        /* Retain schedule history if an old job was archived. */
      }
    }
    return { ...plan, lastJob };
  }
  create({ name, input, timing }, key) {
    this.checkInput(input);
    validateAutoFirstTouch(input.auto_first_touch);
    validateAutoFirstTouch(input.auto_follow_up);
    if (typeof key !== 'string' || !/^[\w-]{8,100}$/.test(key))
      throw fail(400, '无效的 Idempotency-Key');
    if (typeof name !== 'string' || !name.trim() || name.length > 80)
      throw fail(400, '计划名称须为 1–80 字符');
    const payload = { name: name.trim(), input, timing };
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const old = this.db.prepare('SELECT hash,data FROM schedules WHERE idem=?').get(key);
    if (old) {
      if (old.hash !== hash) throw fail(409, '同一请求编号不能使用不同参数');
      return JSON.parse(old.data);
    }
    const createdAt = this.now();
    const normalized = validateTiming(timing, createdAt);
    if (this.list().filter((p) => p.status !== 'closed' && p.status !== 'completed').length >= 100)
      throw fail(409, '最多保留 100 个未结束的定时计划，请先关闭不需要的计划');
    const plan = {
      id: randomUUID(),
      scope: typeof this.scope === 'function' ? this.scope() : this.scope,
      name: name.trim(),
      input,
      timing: normalized,
      status: 'enabled',
      nextRunAt: nextOccurrence(normalized, createdAt),
      createdAt: new Date(createdAt).toISOString(),
      lastRunAt: null,
      lastJobId: null,
      lastError: '',
      runs: 0,
    };
    this.db
      .prepare('INSERT INTO schedules VALUES(?,?,?,?)')
      .run(plan.id, key, hash, JSON.stringify(plan));
    return plan;
  }
  update(id, { name, input, timing, sourceControlRevision }) {
    let plan = this.get(id);
    if (
      plan.sourcePause?.outreachPlanId &&
      sourceControlRevision !== (plan.sourceControlRevision || 0)
    )
      throw fail(409, '来源已更新，请刷新后重新编辑');
    if (!['enabled', 'paused'].includes(plan.status)) throw fail(409, '该计划已结束');
    if (typeof name !== 'string' || !name.trim() || name.length > 80)
      throw fail(400, '计划名称须为 1–80 字符');
    this.checkInput(input);
    validateAutoFirstTouch(input.auto_first_touch);
    validateAutoFirstTouch(input.auto_follow_up);
    const normalized = validateTiming(timing, this.now());
    const nextRunAt = plan.status === 'enabled' ? nextOccurrence(normalized, this.now()) : null;
    if (plan.status === 'enabled' && !nextRunAt) throw fail(400, '所选日期已没有未到的执行时间');
    if (
      plan.sourcePause?.outreachPlanId &&
      input.auto_first_touch !== plan.input.auto_first_touch
    ) {
      return this.controlOutreach(id, input.auto_first_touch === true, {
        sourceControlRevision,
        changes: { name: name.trim(), input, timing: normalized, nextRunAt, lastError: '' },
      });
    }
    plan.name = name.trim();
    plan.input = input;
    plan.timing = normalized;
    plan.nextRunAt = nextRunAt;
    plan.lastError = '';
    this.save(plan);
    this.onOutreachChange();
    return plan;
  }
  control(id, action, { sourceControlRevision } = {}) {
    const plan = this.get(id);
    if (!['pause', 'resume', 'close', 'delete'].includes(action))
      throw fail(400, '不支持的计划操作');
    if (plan.sourceDeletedAt) {
      if (action === 'delete') return plan;
      throw fail(409, '来源计划已删除');
    }
    if (
      (plan.status === 'closed' && !['resume', 'delete'].includes(action)) ||
      (plan.status === 'completed' && !['close', 'delete'].includes(action))
    )
      throw fail(409, '该计划已结束');
    if (action === 'resume') {
      if (
        plan.sourcePause?.outreachPlanId &&
        sourceControlRevision !== (plan.sourceControlRevision || 0) &&
        !(
          sourceControlRevision !== undefined &&
          plan.status === 'enabled' &&
          sourceControlRevision === plan.sourceResumeRevision
        )
      )
        throw fail(409, '来源已更新，请刷新后继续');
      plan.sourceResumeRevision = plan.sourceControlRevision || 0;
      if (plan.sourcePause?.outreachPlanId && plan.status === 'enabled') return plan;
      if (!['paused', 'closed'].includes(plan.status))
        throw fail(409, '只有暂停或关闭的计划可以恢复');
      this.checkInput(plan.input);
      if (
        plan.status === 'closed' &&
        this.list().filter((p) => !['closed', 'completed'].includes(p.status)).length >= 100
      )
        throw fail(409, '最多保留 100 个未结束的定时计划，请先关闭不需要的计划');
      plan.nextRunAt = nextOccurrence(plan.timing, this.now());
      if (!plan.nextRunAt) throw fail(409, '所选日期已没有未到的执行时间，请重新创建计划');
      plan.status = 'enabled';
      plan.lastError = '';
    } else {
      plan.status = ['close', 'delete'].includes(action) ? 'closed' : 'paused';
      if (action === 'delete') {
        plan.sourceDeletedAt = new Date(this.now()).toISOString();
        plan.input.auto_first_touch = false;
      }
      plan.nextRunAt = null;
    }
    plan.sourceControlRevision = (plan.sourceControlRevision || 0) + 1;
    this.save(plan);
    if (action !== 'resume' && plan.lastJobId) {
      try {
        const job = this.jobs().get(plan.lastJobId);
        if (action === 'delete') this.jobs().delete(job.id);
        else if (action === 'pause' && ['running', 'stopping', 'paused'].includes(job.status))
          this.jobs().pause(job.id);
        else if (['running', 'stopping'].includes(job.status)) this.jobs().stop(job.id);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    this.onOutreachChange();
    return plan;
  }
  controlOutreach(id, enabled, { sourceControlRevision, changes } = {}) {
    if (typeof enabled !== 'boolean') throw fail(400, '请明确选择开启或关闭自动首发');
    this.recoverAuthorizations();
    const plan = this.get(id);
    const original = structuredClone(plan);
    if (plan.status === 'closed' || plan.sourceDeletedAt) throw fail(409, '该计划已关闭');
    if (plan.sourcePause?.outreachPlanId) {
      const revision = plan.sourceControlRevision || 0;
      if (sourceControlRevision !== revision) {
        if (
          enabled &&
          plan.input.auto_first_touch &&
          plan.outreachAuthorizationRevision === sourceControlRevision
        )
          return plan;
        throw fail(409, '来源已更新，请刷新后重新保存自动首发授权');
      }
      if (plan.input.auto_first_touch === enabled) return plan;
      if (enabled) plan.outreachAuthorizationRevision = revision;
      plan.sourceControlRevision = revision + 1;
    }
    const manager = this.jobs();
    const job =
      plan.sourcePause?.outreachPlanId && plan.lastJobId ? manager.get(plan.lastJobId) : null;
    this.db
      .prepare('INSERT INTO outreach_authorizations VALUES(?,?)')
      .run(id, JSON.stringify({ plan: original, job }));
    try {
      if (job)
        manager.controlOutreach(job.id, enabled, {
          sourceControlRevision: job.sourceControlRevision || 0,
          fromSchedule: true,
          notify: false,
        });
      if (changes) Object.assign(plan, changes);
      if (!enabled || (!changes && !original.input.auto_first_touch))
        plan.input.auto_follow_up = false;
      plan.input.auto_first_touch = validateAutoFirstTouch(enabled);
      this.save(plan);
      this.db.prepare('DELETE FROM outreach_authorizations WHERE id=?').run(id);
    } catch (error) {
      this.recoverAuthorizations();
      throw error;
    }
    this.onOutreachChange();
    return plan;
  }
  pauseSourceForOutreach(jobId, { outreachPlanId, reason = '关联触达计划已删除' } = {}) {
    if (typeof outreachPlanId !== 'string' || !outreachPlanId.trim())
      throw fail(400, '请提供关联触达计划编号');
    const manager = this.jobs();
    const source = manager.get(jobId);
    let schedule = null;
    if (source.scheduleId) {
      schedule = this.get(source.scheduleId);
      if (
        schedule.sourcePause?.outreachPlanId !== outreachPlanId ||
        schedule.input.auto_first_touch ||
        schedule.status === 'enabled'
      ) {
        schedule.input.auto_first_touch = false;
        schedule.status = schedule.status === 'closed' ? 'closed' : 'paused';
        schedule.nextRunAt = null;
        schedule.sourcePause = { outreachPlanId, reason };
        schedule.sourceControlRevision = (schedule.sourceControlRevision || 0) + 1;
        schedule.lastError = reason;
        this.save(schedule);
      }
    }
    const job = source.sourceDeletedAt
      ? source
      : manager.pause(jobId, { outreachPlanId, reason, disableFirstTouch: true });
    if (schedule?.lastJobId && schedule.lastJobId !== jobId) {
      if (!manager.get(schedule.lastJobId).sourceDeletedAt)
        manager.pause(schedule.lastJobId, { outreachPlanId, reason, disableFirstTouch: true });
    }
    this.onOutreachChange();
    return { job, schedule };
  }
  tick() {
    if (this.isMaintaining()) return;
    for (const plan of this.list()
      .filter((p) => p.status === 'enabled')
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))) {
      const currentScope = typeof this.scope === 'function' ? this.scope() : this.scope;
      // Keep an explicitly scoped plan dormant while another customer table is
      // selected. Returning to its table resumes its own persisted schedule.
      if (plan.scope && plan.scope !== currentScope) continue;
      const now = this.now();
      const minuteStart = Math.floor(now / 60000) * 60000;
      while (plan.nextRunAt && Date.parse(plan.nextRunAt) <= now) {
        const manager = this.jobs();
        const key = `schedule-${plan.id}-${Date.parse(plan.nextRunAt)}`;
        // Recover a crash between job creation and schedule bookkeeping without replaying it.
        let job = manager.findByKey(key);
        if (!job) {
          // A retained slot keeps its original time and idempotency key while waiting.
          const missed = Date.parse(plan.nextRunAt) < minuteStart;
          const blocker = manager.blockingJob(plan.input, plan.id);
          if (plan.timing.waitForPrevious && (!this.ready() || !this.available() || blocker)) {
            const waiting = !this.ready()
              ? '等待 API 连接恢复'
              : blocker?.status === 'paused'
                ? '排队中，等待上一轮结果确认'
                : '排队中，等待当前任务结束';
            if (plan.lastError !== waiting) this.save({ ...plan, lastError: waiting });
            break;
          }
          const skipped =
            missed && !plan.timing.waitForPrevious
              ? '执行时点已错过'
              : !this.ready()
                ? 'API 连接尚未配置'
                : !this.available() || blocker
                  ? blocker?.status === 'paused'
                    ? '当前任务执行结果待确认'
                    : '当前任务尚未完成'
                  : '';
          if (skipped) {
            plan.lastError = `${skipped}，已跳过本次执行，不补跑`;
            plan.nextRunAt = nextOccurrence(plan.timing, missed ? minuteStart - 1 : now);
            if (!plan.nextRunAt) plan.status = 'completed';
            this.save(plan);
            continue;
          }
          try {
            // The connection may have changed since this plan was saved. Never
            // dispatch a preserved scope to an engine that cannot honor it.
            this.checkInput(plan.input);
            job = manager.create(plan.input, key, { scheduleId: plan.id });
          } catch (error) {
            const reason = error.status ? error.message : '计划启动失败，请检查本机服务';
            if (error.code === 'INVALID_COUNTRY_SCOPE') {
              this.save({ ...plan, status: 'paused', nextRunAt: null, lastError: reason });
            } else if (plan.lastError !== reason) this.save({ ...plan, lastError: reason });
            break;
          }
        }
        plan.lastJobId = job.id;
        plan.lastScheduledAt = plan.nextRunAt;
        plan.lastRunAt = job.createdAt;
        plan.runs++;
        plan.lastError = '';
        plan.nextRunAt = nextOccurrence(
          plan.timing,
          plan.timing.waitForPrevious
            ? Date.parse(plan.nextRunAt)
            : Math.max(Date.parse(plan.nextRunAt), minuteStart - 1),
        );
        if (!plan.nextRunAt) plan.status = 'completed';
        this.save(plan);
        if (plan.input.auto_first_touch) this.onOutreachChange();
      }
    }
  }
  start() {
    if (this.timer) return;
    const tick = () => {
      try {
        this.tick();
      } catch {
        /* Persisted plans will be retried on the next tick. */
      }
    };
    this.timer = setInterval(tick, 15000);
    this.timer.unref();
    tick();
  }
  close() {
    clearInterval(this.timer);
    this.db.close();
  }
}
