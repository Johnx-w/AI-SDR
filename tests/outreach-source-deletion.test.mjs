import test from 'node:test';
import assert from 'node:assert/strict';
import { OutreachService } from '../server/outreach-service.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { AcquisitionSchedules } from '../server/acquisition-schedules.mjs';
import { withApp } from './helpers/http.mjs';

test('正常HTTP删除来源A暂停并关闭授权，来源B和独立计划不变', async () => {
  const jobs = new BatchJobs({ schedule: false });
  const plans = new AcquisitionSchedules({
    jobs: () => jobs,
    ready: () => true,
    available: () => true,
  });
  const input = {
    country: 'United States',
    product: 'zip screens',
    search_query: 'zip screens',
    target_count: 3,
    acquisition_channel: 'tavily_web',
    auto_first_touch: true,
  };
  const timing = {
    repeat: 'weekly',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    startDate: '2030-01-01',
    times: ['09:00'],
    timezone: 'Asia/Shanghai',
  };
  const pa = plans.create({ name: '来源A', input, timing }, 'schedule-plan-a');
  const pb = plans.create(
    { name: '来源B', input: { ...input, country: 'Canada' }, timing },
    'schedule-plan-b',
  );
  const a = jobs.create(input, 'source-a', { scheduleId: pa.id });
  const b = jobs.create({ ...input, country: 'Canada' }, 'source-b', { scheduleId: pb.id });
  const service = new OutreachService({
    mailboxes: { list: () => [] },
    pauseAcquisitionSource: (id, context) => plans.pauseSourceForOutreach(id, context),
  });
  for (const [id, source] of [
    ['a', a],
    ['b', b],
    ['manual', null],
  ])
    service.putCampaign({
      id,
      name: id,
      mode: 'production',
      status: 'active',
      revision: 1,
      followUpEnabled: true,
      ...(source ? { acquisitionSource: { jobId: source.id, roundId: source.id } } : {}),
    });
  try {
    await withApp({ env: {}, outreachServiceFactory: () => service }, async (base) => {
      const result = await fetch(base + '/api/v1/outreach/campaigns/a/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ revision: 1, confirmed: true }),
      });
      assert.equal(result.status, 200);
      const deleted = await result.json();
      assert.ok(deleted.campaign.deletedAt);
      assert.equal(jobs.get(a.id).input.auto_first_touch, false);
      assert.equal(jobs.get(a.id).manualPaused, true);
      assert.equal(jobs.get(b.id).input.auto_first_touch, true);
      assert.equal(service.campaign('manual').followUpEnabled, true);
    });
  } finally {
    await service.close();
    jobs.close();
    plans.close();
  }
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
for (const failure of ['schedule', 'job'])
  test(`来源${failure}持久化失败保留处理中，跨重启重试同一请求`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'source-delete-'));
    let jobs, plans, service;
    const open = () => {
      jobs = new BatchJobs({ path: join(dir, 'jobs.sqlite'), schedule: false });
      plans = new AcquisitionSchedules({
        path: join(dir, 'plans.sqlite'),
        jobs: () => jobs,
        ready: () => true,
        available: () => true,
      });
      service = new OutreachService({
        path: join(dir, 'mail.sqlite'),
        mailboxes: { list: () => [] },
        pauseAcquisitionSource: (id, c) => plans.pauseSourceForOutreach(id, c),
      });
    };
    const close = async () => {
      await service.close();
      jobs.close();
      plans.close();
    };
    open();
    try {
      const input = {
        country: 'United States',
        product: 'zip screens',
        search_query: 'zip screens',
        target_count: 3,
        acquisition_channel: 'tavily_web',
        auto_first_touch: true,
      };
      const p = plans.create(
        {
          name: '来源A',
          input,
          timing: {
            repeat: 'weekly',
            weekdays: [1],
            startDate: '2030-01-01',
            times: ['09:00'],
            timezone: 'Asia/Shanghai',
          },
        },
        'failure-schedule',
      );
      const a = jobs.create(input, 'failure-job', { scheduleId: p.id });
      service.putCampaign({
        id: 'a',
        name: 'a',
        mode: 'production',
        status: 'active',
        revision: 1,
        followUpEnabled: true,
        acquisitionSource: { jobId: a.id, roundId: a.id },
      });
      service.putDelivery({ id: 'queued', campaignId: 'a', status: 'queued' });
      const db = failure === 'schedule' ? plans.db : jobs.db;
      db.exec(
        `CREATE TRIGGER injected_failure BEFORE UPDATE ON ${failure === 'schedule' ? 'schedules' : 'jobs'} BEGIN SELECT RAISE(FAIL,'injected storage failure'); END`,
      );
      const pending = service.deleteCampaign('a', 1, true);
      assert.ok(pending.campaign.deleteRequestedAt);
      assert.equal(pending.campaign.deletedAt, undefined);
      assert.match(pending.campaign.deletionError, /injected/);
      assert.equal(pending.deliveries[0].status, 'cancelled');
      assert.equal(service.acquisitionAllowed(pending.campaign), false);
      const requested = pending.campaign.deleteRequestedAt;
      db.exec('DROP TRIGGER injected_failure');
      await close();
      open();
      assert.equal(service.campaign('a').deleteRequestedAt, requested);

      await service.tick();
      assert.ok(service.campaign('a').deletedAt);
      assert.equal(service.campaign('a').deletionError, '');
      assert.equal(jobs.get(a.id).input.auto_first_touch, false);
      assert.equal(jobs.get(a.id).manualPaused, true);
      assert.equal(plans.get(p.id).input.auto_first_touch, false);
      assert.equal(plans.get(p.id).status, 'paused');
      assert.equal(service.deleteCampaign('a', 1, true).campaign.deleteRequestedAt, requested);
    } finally {
      await close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('来源已删除后再删除触达仍可完成并保留来源删除事实', async () => {
  const jobs = new BatchJobs({ schedule: false });
  const plans = new AcquisitionSchedules({ jobs: () => jobs });
  const job = jobs.create(
    { country: 'United States', product: 'zip screens', target_count: 3, auto_first_touch: true },
    'deleted-source',
  );
  jobs.delete(job.id);
  const service = new OutreachService({
    mailboxes: { list: () => [] },
    pauseAcquisitionSource: (id, c) => plans.pauseSourceForOutreach(id, c),
  });
  try {
    service.putCampaign({
      id: 'old',
      mode: 'production',
      status: 'completed',
      revision: 1,
      acquisitionSource: { jobId: job.id, roundId: job.id },
    });
    assert.ok(service.deleteCampaign('old', 1, true).campaign.deletedAt);
    assert.ok(jobs.get(job.id).sourceDeletedAt);
    assert.equal(jobs.get(job.id).input.auto_first_touch, false);
  } finally {
    await service.close();
    jobs.close();
    plans.close();
  }
});

test('41来源计划1203大字段来源搜索跨页与删除重试索引性能', async () => {
  const service = new OutreachService({
    mailboxes: { list: () => [] },
    loadLeads: () => assert.fail('外部读取'),
    acquisitionSources: () => assert.fail('外部读取'),
  });
  try {
    for (let i = 0; i < 41; i++)
      service.putCampaign({
        id: 'p-' + i,
        name: '来源A ' + i,
        mode: 'production',
        status: i % 2 ? 'active' : 'completed',
        revision: 1,
        acquisitionSource: { jobId: 'job-' + i, roundId: 'job-' + i },
      });
    for (let i = 0; i < 1203; i++)
      service.putDelivery({
        id: 'd-' + i,
        campaignId: 'p-' + (i % 41),
        status: i % 3 ? 'accepted' : 'unknown',
        bodyHtml: 'x'.repeat(20000),
        candidate: { evidence: 'y'.repeat(10000) },
      });
    for (let i = 0; i < 25; i++) {
      service.requestCampaignDeletion('p-' + i, 1, true);
      service.completeCampaignDeletion('p-' + i);
    }
    const measurements = [];
    for (const [view, total] of [
      ['current', 8],
      ['history', 8],
      ['deleted', 25],
    ]) {
      const times = [];
      let value;
      for (let i = 0; i < 11; i++) {
        const start = performance.now();
        value = await service.state(
          new URLSearchParams({ view, q: '来源A', page: '1', pageSize: '20' }),
        );
        times.push(performance.now() - start);
        assert.equal(value.filtered, total);
      }
      const second = await service.state(
        new URLSearchParams({ view, q: '来源A', page: '2', pageSize: '20' }),
      );
      assert.equal(second.filtered, total);
      assert.equal(second.campaigns.length, view === 'deleted' ? 5 : 8);
      measurements.push({
        view,
        total,
        coldMs: times[0],
        hotMedianMs: times.slice(1).sort((a, b) => a - b)[5],
        bytes: JSON.stringify(value).length,
      });
    }
    const plan = service.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM outreach_campaigns WHERE json_extract(data,'$.deleteRequestedAt') IS NOT NULL AND json_extract(data,'$.deletedAt') IS NULL",
      )
      .all();
    assert.match(JSON.stringify(plan), /outreach_pending_deletions/);
    console.log(
      'T6性能',
      JSON.stringify({ plans: 41, deliveries: 1203, measurements, pendingQueryPlan: plan }),
    );
  } finally {
    await service.close();
  }
});
