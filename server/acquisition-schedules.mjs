import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const fail = (status, message) => Object.assign(new Error(message), { status });
const day = 86400000;

// Older plans stored one `time`; new plans store a minute-precision list.
function timingTimes(timing) {
  return Array.isArray(timing.times) ? timing.times : [timing.time];
}

export function validateTiming(timing, now = Date.now()) {
  if (
    !timing ||
    !['once', 'daily', 'weekly'].includes(timing.repeat) ||
    !/^20\d\d-\d{2}-\d{2}$/.test(timing.startDate || '') ||
    (timing.timezone && timing.timezone !== 'Asia/Shanghai')
  )
    throw fail(400, '请选择有效的日期、时间和执行周期（北京时间）');
  if (timing.times !== undefined && !Array.isArray(timing.times))
    throw fail(400, '执行时间须为时间点列表');
  const selected = timingTimes(timing);
  if (
    !selected.length ||
    selected.length > 24 ||
    selected.some((time) => typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
  )
    throw fail(400, '请设置 1–24 个执行时间，精确到分钟');
  if (new Set(selected).size !== selected.length) throw fail(400, '执行时间不能重复');
  const times = [...selected].sort();
  const normalized = {
    repeat: timing.repeat,
    startDate: timing.startDate,
    times,
    timezone: 'Asia/Shanghai',
  };
  const first = Date.parse(`${normalized.startDate}T${times[0]}:00+08:00`);
  if (
    !Number.isFinite(first) ||
    new Date(first + 8 * 3600000).toISOString().slice(0, 10) !== normalized.startDate
  )
    throw fail(400, '执行日期无效');
  if (normalized.repeat === 'once' && first <= now)
    throw fail(400, '指定日期的所有执行时间必须晚于当前时间');
  return normalized;
}

export function nextOccurrence(timing, after) {
  const interval = (timing.repeat === 'weekly' ? 7 : 1) * day;
  const candidates = timingTimes(timing).flatMap((time) => {
    const first = Date.parse(`${timing.startDate}T${time}:00+08:00`);
    if (first > after) return [first];
    if (timing.repeat === 'once') return [];
    return [first + (Math.floor((after - first) / interval) + 1) * interval];
  });
  return candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;
}

export class AcquisitionSchedules {
  constructor({ path = ':memory:', jobs, ready, available, now = Date.now }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY, idem TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL);',
    );
    this.jobs = jobs;
    this.ready = ready;
    this.available = available;
    this.now = now;
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
    const times = timingTimes(plan.timing);
    return { ...plan, timing: { ...plan.timing, times, time: times[0] }, lastJob };
  }
  create({ name, input, timing }, key) {
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
    return plan;
  }
  tick() {
    for (const plan of this.list()
      .filter((p) => p.status === 'enabled')
      .sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))) {
      if (!plan.nextRunAt || Date.parse(plan.nextRunAt) > this.now()) continue;
      const manager = this.jobs();
      const key = `schedule-${plan.id}-${Date.parse(plan.nextRunAt)}`;
      // Recover a crash between job creation and schedule bookkeeping without replaying it.
      let job = manager.findByKey(key);
      if (!job) {
        const waiting = !this.ready()
          ? 'API 连接尚未配置，等待完成配置'
          : !this.available() || manager.active()
            ? '等待当前任务完成或核对后执行'
            : '';
        if (waiting) {
          if (plan.lastError !== waiting) this.save({ ...plan, lastError: waiting });
          continue;
        }
        try {
          job = manager.create(plan.input, key);
        } catch (error) {
          const reason = error.status ? error.message : '计划启动失败，请检查本机服务';
          if (plan.lastError !== reason) this.save({ ...plan, lastError: reason });
          continue;
        }
      }
      plan.lastJobId = job.id;
      plan.lastScheduledAt = plan.nextRunAt;
      plan.lastRunAt = job.createdAt;
      plan.runs++;
      plan.lastError = '';
      // Advance from the scheduled slot, not the actual launch time: if a prior
      // run is still busy, later slots remain queued and each gets its own key.
      plan.nextRunAt = nextOccurrence(plan.timing, Date.parse(plan.nextRunAt));
      if (!plan.nextRunAt) plan.status = 'completed';
      this.save(plan);
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
