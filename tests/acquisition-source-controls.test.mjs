import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { AcquisitionSchedules } from '../server/acquisition-schedules.mjs';
const input = {
  country: 'United States',
  region: '',
  product: 'zip screens',
  search_query: 'zip screens',
  acquisition_channel: 'tavily_web',
  target_count: 3,
  auto_first_touch: true,
};
const timing = {
  repeat: 'weekly',
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  startDate: '2030-01-01',
  times: ['09:00'],
  timezone: 'Asia/Shanghai',
};
test('删除关联触达只暂停目标来源，关闭两处首发并保留队列；旧检查点和重启不撤销', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'source-controls-'));
  let jobs, plans;
  const open = () => {
    jobs = new BatchJobs({
      path: join(dir, 'jobs.sqlite'),
      schedule: false,
      discover: async () => ({ candidates: [] }),
      research: async () => ({}),
      status: async () => ({ settled: false }),
      readLeads: async () => [],
    });
    plans = new AcquisitionSchedules({
      path: join(dir, 'plans.sqlite'),
      jobs: () => jobs,
      ready: () => true,
      available: () => true,
      now: () => Date.parse('2030-01-01T00:00:00Z'),
    });
  };
  open();
  try {
    const plan = plans.create({ name: '来源A', input, timing }, 'source-plan-a');
    const a = jobs.create(input, 'source-job-a', { scheduleId: plan.id });
    const b = jobs.create({ ...input, country: 'Canada' }, 'source-job-b', {
      scheduleId: 'other-plan',
    });
    a.queue = [
      { domain: 'one.example', source_url: 'https://one.example' },
      { domain: 'two.example', source_url: 'https://two.example' },
    ];
    jobs.save(a);
    const stale = jobs.get(a.id);
    const result = plans.pauseSourceForOutreach(a.id, {
      outreachPlanId: 'outreach-a',
      reason: '关联触达计划已删除',
    });
    assert.equal(result.job.manualPaused, true);
    assert.equal(result.job.input.auto_first_touch, false);
    assert.equal(result.schedule.input.auto_first_touch, false);
    assert.equal(result.schedule.status, 'paused');
    jobs.save(stale);
    await jobs.resumeInterrupted();
    await jobs.resume(a.id, { automatic: true });
    assert.equal(jobs.get(a.id).manualPaused, true);
    assert.equal(jobs.get(a.id).queue.length, 2);
    assert.equal(jobs.get(a.id).input.auto_first_touch, false);
    assert.equal(jobs.get(b.id).input.auto_first_touch, true);
    const revision = jobs.get(a.id).sourceControlRevision;
    plans.pauseSourceForOutreach(a.id, {
      outreachPlanId: 'outreach-a',
      reason: '关联触达计划已删除',
    });
    assert.equal(jobs.get(a.id).sourceControlRevision, revision);
    plans.close();
    jobs.close();
    open();
    assert.equal(jobs.get(a.id).manualPaused, true);
    assert.equal(plans.get(plan.id).input.auto_first_touch, false);
    const resumed = await jobs.resume(a.id);
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.input.auto_first_touch, false);
    jobs.delete(a.id);
    assert.equal(jobs.get(a.id).reason, 'source_deleted');
    await assert.rejects(jobs.resume(a.id), { status: 409 });
  } finally {
    plans.close();
    jobs.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('当前企业保存期间暂停：只接受该企业结果，不启动下家，人工继续才消费剩余队列', async () => {
  let release, entered;
  const gate = new Promise((r) => {
    release = r;
  });
  const started = new Promise((r) => {
    entered = r;
  });
  const leads = [];
  let calls = 0;
  const jobs = new BatchJobs({
    schedule: false,
    discover: async () => ({
      candidates: [{ source_url: 'https://alpha.example' }, { source_url: 'https://beta.example' }],
    }),
    research: async (_input, item) => {
      calls++;
      if (calls === 1) {
        entered();
        await gate;
      }
      leads.push({ id: item.domain, website: item.source_url });
      return {
        新增: 1,
        明细: [{ source_url: item.source_url, result: 'inserted', record_id: item.domain }],
      };
    },
    status: async () => ({ settled: false }),
    readLeads: async () => leads,
  });
  try {
    const job = jobs.create({ ...input, target_count: 2 }, 'pause-inflight-source');
    const running = jobs.work(job.id);
    await started;
    jobs.pause(job.id, { outreachPlanId: 'deleted-inflight', disableFirstTouch: true });
    release();
    await running;
    const paused = jobs.get(job.id);
    assert.equal(paused.inserted, 1);
    assert.equal(paused.queue.length, 1);
    assert.equal(paused.current, null);
    assert.equal(paused.status, 'paused');
    assert.equal(calls, 1);
    assert.equal(paused.input.auto_first_touch, false);
    await jobs.resumeInterrupted();
    assert.equal(calls, 1);
    await jobs.resume(job.id);
    await jobs.work(job.id);
    assert.equal(jobs.get(job.id).inserted, 2);
    assert.equal(calls, 2);
    assert.equal(jobs.get(job.id).input.auto_first_touch, false);
  } finally {
    release();
    jobs.close();
  }
});

test('定时来源暂停后旧调度检查点不能恢复开关，人工恢复只为未来轮次继承关闭值', () => {
  let now = Date.parse('2030-01-01T00:00:00Z');
  const jobs = new BatchJobs({
    schedule: false,
    discover: async () => ({ candidates: [] }),
    research: async () => ({}),
    status: async () => ({ settled: false }),
    readLeads: async () => [],
  });
  const plans = new AcquisitionSchedules({
    jobs: () => jobs,
    ready: () => true,
    available: () => true,
    now: () => now,
  });
  try {
    const plan = plans.create({ name: '定时来源', input, timing }, 'future-source-plan');
    const job = jobs.create(input, 'future-source-round', { scheduleId: plan.id });
    const stale = plans.get(plan.id);
    plans.pauseSourceForOutreach(job.id, { outreachPlanId: 'outreach-future' });
    plans.save(stale);
    assert.equal(plans.get(plan.id).status, 'paused');
    assert.equal(plans.get(plan.id).input.auto_first_touch, false);
    jobs.delete(job.id);
    plans.control(plan.id, 'resume');
    now = Date.parse('2030-01-01T01:00:00Z');
    plans.tick();
    const next = jobs.get(plans.get(plan.id).lastJobId);
    assert.notEqual(next.id, job.id);
    assert.equal(next.input.auto_first_touch, false);
    plans.control(plan.id, 'delete');
    assert.equal(jobs.get(next.id).reason, 'source_deleted');
    assert.throws(() => plans.control(plan.id, 'resume'), { status: 409 });
  } finally {
    plans.close();
    jobs.close();
  }
});

test('删除旧定时轮次关联触达时暂停当前轮；已结束旧轮保留结果且不可继续', async () => {
  const jobs = new BatchJobs({
    schedule: false,
    discover: async () => ({ candidates: [] }),
    research: async () => ({}),
    status: async () => ({ settled: false }),
    readLeads: async () => [],
  });
  const plans = new AcquisitionSchedules({
    jobs: () => jobs,
    ready: () => true,
    available: () => true,
    now: () => Date.parse('2030-01-01T00:00:00Z'),
  });
  try {
    const plan = plans.create({ name: '跨轮来源', input, timing }, 'cross-round-source');
    const old = jobs.create(input, 'old-source-round', { scheduleId: plan.id });
    jobs.finish(old, 'target_reached');
    const current = jobs.create(input, 'current-source-round', { scheduleId: plan.id });
    plans.save({ ...plan, lastJobId: current.id });
    plans.pauseSourceForOutreach(old.id, { outreachPlanId: 'deleted-old-round' });
    assert.equal(jobs.get(old.id).status, 'completed');
    assert.equal(jobs.get(old.id).input.auto_first_touch, false);
    assert.equal(jobs.get(current.id).status, 'paused');
    assert.equal(jobs.get(current.id).input.auto_first_touch, false);
    await jobs.work(current.id);
    assert.equal(jobs.get(current.id).searches, 0);
    await assert.rejects(jobs.resume(old.id), { status: 409 });
  } finally {
    plans.close();
    jobs.close();
  }
});

test('正常HTTP入口读取来源、暂停、继续、删除与不存在对象校验', async () => {
  const { withApp } = await import('./helpers/http.mjs');
  const { createHash } = await import('node:crypto');
  const dir = mkdtempSync(join(tmpdir(), 'source-http-'));
  const path = join(dir, 'jobs.sqlite');
  const seed = new BatchJobs({
    path,
    schedule: false,
    scope: createHash('sha256')
      .update(JSON.stringify(['fixture-base', 'fixture-table']))
      .digest('hex'),
    discover: async () => ({ candidates: [] }),
    research: async () => ({}),
    status: async () => ({ settled: false }),
    readLeads: async () => [],
  });
  const a = seed.create({ ...input, auto_first_touch: false }, 'http-source-target');
  seed.pause(a.id);
  seed.close();
  try {
    await withApp(
      {
        env: {
          TAVILY_API_KEY: 'fixture',
          DEEPSEEK_API_KEY: 'fixture',
          FEISHU_APP_ID: 'fixture',
          FEISHU_APP_SECRET: 'fixture',
          FEISHU_APP_TOKEN: 'fixture-base',
          FEISHU_TABLE_ID: 'fixture-table',
          BATCH_DB_PATH: path,
          OUTREACH_DATA_DIR: dir,
          OUTREACH_DB_PATH: ':memory:',
        },
        fetchImpl: async () =>
          Response.json({
            code: 0,
            tenant_access_token: 'fixture',
            expire: 7200,
            data: { items: [], has_more: false },
          }),
        nativeImpl: {
          discover: async () => ({ candidates: [] }),
          decorateLeads: (v) => v,
          close() {},
        },
      },
      async (base) => {
        const url = `${base}/api/v1/acquisition/jobs/${a.id}`;
        const post = (action) => fetch(`${url}/${action}`, { method: 'POST' });
        assert.equal((await post('pause')).status, 200);
        const resumed = await post('resume');
        assert.equal(resumed.status, 200);
        assert.equal((await resumed.json()).input.auto_first_touch, false);
        const deleted = await post('delete');
        assert.equal(deleted.status, 200);
        assert.ok((await deleted.json()).sourceDeletedAt);
        const read = await (await fetch(url)).json();
        assert.equal(read.reason, 'source_deleted');
        assert.equal((await post('resume')).status, 409);
        assert.equal(
          (await fetch(`${base}/api/v1/acquisition/jobs/missing/pause`, { method: 'POST' })).status,
          404,
        );
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
