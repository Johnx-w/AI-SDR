import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchJobs, validateCount } from '../server/batch-jobs.mjs';
import { domainKey } from '../server/website-identity.mjs';
import { searchPlan } from '../server/search-plan.mjs';
const input = {
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens, pergolas',
  audience: 'BC',
  search_query: 'outdoor zip screens Florida United States',
  acquisition_channel: 'tavily_web',
  target_count: 20,
};
function harness(extra = {}) {
  const leads = [];
  let num = 0;
  const manager = new BatchJobs({
    schedule: false,
    discover: async () => ({
      candidates: Array.from({ length: 20 }, () => ({
        source_url: `https://company${++num}.com/`,
      })),
    }),
    research: async (_input, item) => {
      const id = 'rec' + item.domain;
      leads.push({ id, name: item.domain, website: item.source_url });
      return {
        新增: 1,
        execution_id: '1',
        明细: [{ source_url: item.source_url, result: 'inserted', record_id: id }],
      };
    },
    status: async () => ({ settled: false }),
    readLeads: async () => leads,
    ...extra,
  });
  return { manager, leads };
}

test('全局淘汰和证据不足的候选不占新增名额，队列继续补找', async () => {
  let count = 0;
  const { manager } = harness({
    research: async () => ({
      新增: 0,
      更新: 0,
      reason: '客户未通过准入',
      research: {
        ok: false,
        eligibility: { status: count++ % 2 ? 'insufficient_evidence' : 'rejected' },
      },
    }),
  });
  try {
    const job = manager.create({ ...input, target_count: 1 }, 'policy-batch-01');
    await manager.work(job.id);
    const result = manager.get(job.id);
    assert.equal(result.inserted, 0);
    assert.equal(result.rejected, 3);
    assert.equal(result.pending, 0);
    assert.equal(result.reason, 'research_limit');
    assert.ok(result.rows.every((row) => row.result === 'rejected'));
  } finally {
    manager.close();
  }
});

test('旧市场任务禁止重新规划或恢复，已有记录不删除', async () => {
  const { manager } = harness();
  try {
    assert.throws(() => searchPlan({ ...input, country: 'Southeast Asia' }), /支持的国家/);
    assert.throws(
      () => manager.create({ ...input, country: 'Southeast Asia' }, 'retired-batch-01'),
      /支持的国家/,
    );
    const job = manager.create(input, 'retired-batch-02');
    job.status = 'paused';
    job.input.country = 'Southeast Asia';
    manager.save(job);
    await assert.rejects(manager.resume(job.id), /支持的国家/);
    assert.equal(manager.get(job.id).status, 'paused');
    assert.equal(manager.get(job.id).researched, 0);
    assert.equal(manager.get(job.id).searches, 0);
  } finally {
    manager.close();
  }
});
test('数量仅接受1–200整数，域名规范化，客群与地域保留', () => {
  for (const n of [1, 20, 200]) assert.equal(validateCount(n), n);
  for (const n of [0, 201, 1.5, '20', null, NaN]) assert.throws(() => validateCount(n), /整数/);
  assert.equal(domainKey('https://WWW.Example.com/contact?x=1'), 'example.com');
  assert.equal(domainKey('http://127.0.0.1/'), '');
  const plan = searchPlan({ ...input, audience: 'B' });
  assert.ok(plan.every((p) => p.query.includes('Florida') && p.query.includes('United States')));
  assert.ok(plan.slice(1).every((p) => p.query.includes('wholesale')));
});
for (const target of [1, 20, 200])
  test(`模拟新增${target}家，达到目标立即停止且无超额`, async () => {
    const { manager, leads } = harness();
    try {
      const j = manager.create(
        { ...input, product: 'outdoor zip screens', target_count: target },
        'count-target-' + target,
      );
      await manager.work(j.id);
      const done = manager.get(j.id);
      assert.equal(done.status, 'completed');
      assert.equal(done.inserted, target);
      assert.equal(done.researched, target);
      assert.equal(leads.length, target);
    } finally {
      manager.close();
    }
  });
test('重复提交不新增任务，不同参数冲突，已有任务禁止并行', () => {
  const { manager } = harness();
  try {
    const j = manager.create(input, 'idem-request-one');
    assert.equal(manager.create(input, 'idem-request-one').id, j.id);
    assert.throws(
      () => manager.create({ ...input, target_count: 5 }, 'idem-request-one'),
      /不同参数/,
    );
    assert.throws(() => manager.create(input, 'idem-request-two'), /未结束/);
  } finally {
    manager.close();
  }
});
test('同域不同网页只研究一次，重复与不匹配不占名额，自动补找', async () => {
  let search = 0;
  let calls = 0;
  const records = [];
  const { manager } = harness({
    discover: async () => ({
      candidates:
        search++ === 0
          ? [{ source_url: 'https://same.com/a' }, { source_url: 'https://www.same.com/b' }]
          : [{ source_url: 'https://new.com' }],
      skipped_existing: [{ url: 'https://old.com/a' }, { url: 'https://old.com/b' }],
    }),
    research: async (_i, c) => {
      calls++;
      if (c.domain === 'same.com')
        return { research: { audience_match: 'not_matched' }, reason: '不匹配' };
      records.push({ id: 'r1', website: c.source_url, name: 'New' });
      return { 新增: 1, 明细: [{ source_url: c.source_url, result: 'inserted', record_id: 'r1' }] };
    },
    readLeads: async () => records,
  });
  try {
    const j = manager.create({ ...input, target_count: 1 }, 'dedupe-test');
    await manager.work(j.id);
    const done = manager.get(j.id);
    assert.equal(done.inserted, 1);
    assert.equal(done.rejected, 1);
    assert.equal(done.skipped, 1);
    assert.equal(calls, 2);
  } finally {
    manager.close();
  }
});

test('每条实际搜索词记录发现、去重、待核实和评级产出', async () => {
  const records = [];
  const { manager } = harness({
    discover: async () => ({
      candidates: [
        { source_url: 'https://review.example/' },
        { source_url: 'https://accepted.example/' },
      ],
      skipped_existing: [{ url: 'https://known.example/' }],
    }),
    research: async (_target, item) => {
      if (item.domain === 'review.example')
        return {
          outcome: 'review',
          reason: '必需条件待核实',
          research: {
            review_required: true,
            requirement_checks: [
              { condition: '必须有商用项目', verdict: 'unknown', quote: '', source_url: '' },
            ],
          },
        };
      records.push({ id: 'rec-accepted', name: 'Accepted', website: item.source_url });
      return {
        新增: 1,
        明细: [{ source_url: item.source_url, result: 'inserted', record_id: 'rec-accepted' }],
        assessment: { grade: 'A', score: 80, status: '优先开发' },
      };
    },
    readLeads: async () => records,
  });
  try {
    const created = manager.create({ ...input, target_count: 1 }, 'search-metrics-01');
    await manager.work(created.id);
    const job = manager.get(created.id);
    assert.equal(job.status, 'completed');
    assert.equal(job.review, 1);
    assert.equal(job.searchStats.length, 1);
    assert.deepEqual(
      {
        discovered: job.searchStats[0].discovered,
        duplicates: job.searchStats[0].duplicates,
        queued: job.searchStats[0].queued,
        researched: job.searchStats[0].researched,
        inserted: job.searchStats[0].inserted,
        review: job.searchStats[0].review,
        ratings: job.searchStats[0].ratings,
      },
      {
        discovered: 3,
        duplicates: 1,
        queued: 2,
        researched: 2,
        inserted: 1,
        review: 1,
        ratings: { A: 1, B: 0, C: 0, unrated: 0 },
      },
    );
    assert.ok(job.rows.every((row) => row.search_id === job.searchStats[0].id));
  } finally {
    manager.close();
  }
});

test('服务重启把未完成的搜索指标标记为中断并保留进度', () => {
  const folder = mkdtempSync(join(tmpdir(), 'batch-search-restart-'));
  const path = join(folder, 'jobs.sqlite');
  let manager;
  try {
    manager = harness({ path }).manager;
    const created = manager.create({ ...input, target_count: 1 }, 'search-restart-01');
    created.searchStats.push({
      id: created.id + ':search:1',
      query: 'roller blinds Texas',
      country: 'United States',
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
    });
    manager.save(created);
    manager.close();
    manager = harness({ path }).manager;
    const restored = manager.get(created.id);
    assert.equal(restored.status, 'paused');
    assert.equal(restored.searchStats[0].status, 'interrupted');
    assert.ok(restored.searchStats[0].completedAt);
  } finally {
    manager?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
test('已知抓取失败占研究次数，不计新增，达到3倍上限部分完成', async () => {
  const { manager } = harness({
    research: async () => ({ outcome: 'failed', stage: 'extract', reason: '空正文' }),
  });
  try {
    const j = manager.create({ ...input, target_count: 1 }, 'research-limit');
    await manager.work(j.id);
    const done = manager.get(j.id);
    assert.equal(done.reason, 'research_limit');
    assert.equal(done.failed, 3);
    assert.equal(done.inserted, 0);
  } finally {
    manager.close();
  }
});
test('候选耗尽和搜索上限明确结束', async () => {
  const { manager } = harness({ discover: async () => ({ candidates: [] }) });
  try {
    const j = manager.create({ ...input, target_count: 1 }, 'search-limit');
    j.limits.searches = 2;
    manager.save(j);
    await manager.work(j.id);
    assert.equal(manager.get(j.id).reason, 'search_limit');
    const k = manager.create({ ...input, target_count: 1 }, 'search-exhausted');
    await manager.work(k.id);
    assert.equal(manager.get(k.id).reason, 'exhausted');
  } finally {
    manager.close();
  }
});
test('停止等待当前企业完成，保留写入；时间上限停止', async () => {
  let manager;
  const h = harness();
  manager = h.manager;
  const original = manager.research;
  manager.research = async (i, c) => {
    manager.stop(manager.active().id);
    return original(i, c);
  };
  try {
    const j = manager.create(input, 'stop-current');
    await manager.work(j.id);
    const done = manager.get(j.id);
    assert.equal(done.inserted, 1);
    assert.equal(done.reason, 'stopped');
    const k = manager.create(input, 'time-limit');
    k.elapsedMs = k.limits.timeMs;
    manager.save(k);
    await manager.work(k.id);
    assert.equal(manager.get(k.id).reason, 'time_limit');
  } finally {
    manager.close();
  }
});
test('飞书读回失败或网络结果不明先暂停，核对成功后继续，不重放企业', async () => {
  let count = 0;
  let settled = false;
  const row = {
    新增: 1,
    明细: [{ source_url: 'https://company1.com/', result: 'inserted', record_id: 'r1' }],
  };
  const { manager } = harness({
    research: async () => {
      count++;
      throw new Error('timeout');
    },
    status: async () => ({ settled, output: row }),
    readLeads: async () => [{ id: 'r1', website: 'https://company1.com/', name: 'Company' }],
  });
  try {
    const j = manager.create({ ...input, target_count: 1 }, 'unknown-result');
    await manager.work(j.id);
    assert.equal(manager.get(j.id).status, 'paused');
    await assert.rejects(manager.resume(j.id), /尚未确认/);
    settled = true;
    await manager.resume(j.id);
    await manager.work(j.id);
    assert.equal(manager.get(j.id).inserted, 1);
    assert.equal(manager.get(j.id).status, 'completed');
    assert.equal(count, 1);
  } finally {
    manager.close();
  }
});
test('读回发现记录ID不符时不计新增，继续操作不会并发核对', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let checking = 0;
  const output = {
    新增: 1,
    明细: [{ source_url: 'https://company1.com/', result: 'inserted', record_id: 'correct-id' }],
  };
  const { manager } = harness({
    research: async () => output,
    readLeads: async () => [{ id: 'wrong-id', website: 'https://company1.com/' }],
    status: async () => {
      checking++;
      await gate;
      return { settled: false };
    },
  });
  try {
    const j = manager.create({ ...input, target_count: 1 }, 'bad-readback');
    await manager.work(j.id);
    assert.equal(manager.get(j.id).inserted, 0);
    assert.equal(manager.get(j.id).status, 'paused');
    const first = manager.resume(j.id);
    await assert.rejects(manager.resume(j.id), /仍在处理中/);
    release();
    await assert.rejects(first, /尚未确认/);
    assert.equal(checking, 1);
  } finally {
    release();
    manager.close();
  }
});

test('SQLite保存队列与当前操作，重启暂停核对而非自动重放', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shade-batch-'));
  const path = join(dir, 'jobs.sqlite');
  try {
    const one = harness({ path }).manager;
    const j = one.create(input, 'restart-test');
    j.current = {
      domain: 'example.com',
      source_url: 'https://example.com/',
      operation_id: 'operation-1',
    };
    j.researched = 1;
    j.queue = [{ domain: 'next.com', source_url: 'https://next.com' }];
    one.save(j);
    one.close();
    const two = harness({ path }).manager;
    try {
      const restored = two.get(j.id);
      assert.equal(restored.status, 'paused');
      assert.equal(restored.current.operation_id, 'operation-1');
      assert.equal(restored.queue.length, 1);
      await assert.rejects(two.resume(j.id), /尚未确认/);
    } finally {
      two.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
