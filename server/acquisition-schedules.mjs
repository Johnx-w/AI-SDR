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
  }
  list() {
    return this.db
      .prepare('SELECT data FROM schedules ORDER BY rowid DESC')
      .all()
      .map((row) => JSON.parse(row.data));
  }
  get(id) {
    const row = this.db.prepare('SELECT data FROM schedules WHERE id=?').get(id);
    if (!row) throw fail(404, '定时计划不存在');
    return JSON.parse(row.data);
  }
  save(plan) {
    plan.updatedAt = new Date(this.now()).toISOString();
    this.db.prepare('UPDATE schedules SET data=? WHERE id=?').run(JSON.stringify(plan), plan.id);
    return plan;
  }
  view(plan) {
    let lastJob = null;
    if (plan.lastJobId) {
      try {
        lastJob = this.jobs().view(this.jobs().get(plan.lastJobId));
      } catch {
        /* Retain schedule history if an old job was archived. */
      }
    }
    return { ...plan, lastJob };
  }
  create({ name, input, timing }, key) {
    this.checkInput(input);
    validateAutoFirstTouch(input.auto_first_touch);
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
  control(id, action) {
    const plan = this.get(id);
    if (!['pause', 'resume', 'close'].includes(action)) throw fail(400, '不支持的计划操作');
    if (plan.status === 'closed' || (plan.status === 'completed' && action !== 'close'))
      throw fail(409, '该计划已结束');
    if (action === 'resume') {
      if (plan.status !== 'paused') throw fail(409, '只有暂停的计划可以恢复');
      this.checkInput(plan.input);
      plan.nextRunAt = nextOccurrence(plan.timing, this.now());
      if (!plan.nextRunAt) throw fail(409, '所选日期已没有未到的执行时间，请重新创建计划');
      plan.status = 'enabled';
      plan.lastError = '';
    } else {
      plan.status = action === 'close' ? 'closed' : 'paused';
      plan.nextRunAt = null;
    }
    this.save(plan);
    if (action !== 'resume' && plan.lastJobId) {
      try {
        const job = this.jobs().get(plan.lastJobId);
        if (['running', 'stopping'].includes(job.status)) this.jobs().stop(job.id);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    this.onOutreachChange();
    return plan;
  }
  controlOutreach(id, enabled) {
    if (typeof enabled !== 'boolean') throw fail(400, '请明确选择开启或关闭自动首发');
    const plan = this.get(id);
    if (plan.status === 'closed') throw fail(409, '该计划已关闭');
    plan.input.auto_first_touch = validateAutoFirstTouch(enabled);
    this.save(plan);
    this.onOutreachChange();
    return plan;
  }
  tick() {
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
          // A minute-precision slot can run during that minute; missed slots never build a backlog.
          const missed = Date.parse(plan.nextRunAt) < minuteStart;
          const skipped = missed
            ? '执行时点已错过'
            : !this.ready()
              ? 'API 连接尚未配置'
              : !this.available() || manager.active()
                ? '当前任务尚未完成或待核对'
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
            if (plan.lastError !== reason) this.save({ ...plan, lastError: reason });
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
          Math.max(Date.parse(plan.nextRunAt), minuteStart - 1),
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
