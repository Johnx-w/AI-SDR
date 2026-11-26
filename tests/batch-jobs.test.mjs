import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchJobs, validateCount } from '../server/batch-jobs.mjs';
import { acquisitionOutreachSources } from '../server/acquisition-outreach.mjs';
import { domainKey } from '../server/website-identity.mjs';
import { searchPlan } from '../server/search-plan.mjs';
const input = {
  country: 'United States',
  region: '',
  product: 'outdoor zip screens, pergolas',
  search_query: 'outdoor zip screens United States',
  acquisition_channel: 'tavily_web',
  target_count: 20,
};
const readyHandoff = (source_url) => ({
  policy: 'sales-handoff-v1',
  ready: true,
  reasons: [],
  identity_verified: true,
  opportunity_qualified: true,
  contact_verified: true,
  contacts: [
    {
      kind: 'email',
      value: 'sales@' + domainKey(source_url),
      source_url,
      quote: 'Public business contact',
    },
  ],
});
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
        handoff: readyHandoff(item.source_url),
        明细: [{ source_url: item.source_url, result: 'inserted', record_id: id }],
      };
    },
    status: async () => ({ settled: false }),
    readLeads: async () => leads,
    ...extra,
  });
  return { manager, leads };
}

test('同一计划重启后先研究剩余候选，消费完才从下一条查询接续', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'batch-continuation-'));
  const path = join(dir, 'jobs.sqlite');
  const queries = [];
  const sites = [];
  const open = () =>
    harness({
      path,
      discover: async (_input, search) => {
        queries.push(search.query);
        return {
          candidates: Array.from({ length: 20 }, (_, n) => ({
            source_url: `https://candidate-${queries.length}-${n}.example.org`,
          })),
        };
      },
    }).manager;
  let manager = open();
  const run = async (key, target, options = { scheduleId: 'weekly' }) => {
    const job = manager.create({ ...input, target_count: target }, key, options);
    await manager.work(job.id);
    const result = manager.get(job.id);
    sites.push(...result.rows.map((r) => r.domain));
    return result;
  };
  try {
    const first = await run('carry-first', 1);
    assert.equal(first.inserted, 1);
    manager.close();
    manager = open();
    const second = await run('carry-second', 19);
    assert.equal(second.searches, 0);
    assert.equal(second.inserted, 19);
    assert.equal(new Set(sites).size, 20);
    assert.equal(
      manager.create({ ...input, target_count: 19 }, 'carry-second', { scheduleId: 'weekly' }).id,
      second.id,
    );
    assert.equal((await run('carry-third', 1)).inserted, 1);
    assert.deepEqual(
      queries,
      searchPlan(input)
        .slice(0, 2)
        .map((entry) => entry.query),
    );
    const other = await run('other-plan', 1, { scheduleId: 'independent' });
    assert.equal(other.searches, 1);
    assert.equal(queries.at(-1), first.queryPlan[0].query);
  } finally {
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('升级后的首轮接续原定时计划搜索游标，不向不同产品或客户库承接', async () => {
  const { manager } = harness();
  const schedule = { scheduleId: 'original-plan' };
  try {
    const first = manager.create({ ...input, target_count: 1 }, 'upgrade-first', schedule);
    await manager.work(first.id);
    // Previous releases only kept the completed job and discarded its backlog.
    manager.db.exec('DELETE FROM discovery_progress');
    const next = manager.create(input, 'upgrade-second', schedule);
    assert.equal(next.cursor, 1);
    assert.equal(next.carriedCandidates, 0);
    manager.finish(next, 'stopped');
    const changed = manager.create(
      { ...input, product: 'roller shades' },
      'changed-products',
      schedule,
    );
    assert.equal(changed.cursor, 0);
    assert.equal(changed.carriedCandidates, 0);
    manager.finish(changed, 'stopped');
    manager.scope = 'another-library';
    const other = manager.create(input, 'another-library', schedule);
    assert.equal(other.cursor, 0);
    assert.equal(other.carriedCandidates, 0);
  } finally {
    manager.close();
  }
});

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
    assert.equal(result.rejected, 12);
    assert.equal(result.pending, 0);
    assert.equal(result.reason, 'research_limit');
    assert.ok(result.rows.every((row) => row.result === 'rejected'));
    assert.ok(result.rows.every((row) => !('source_url' in row) && !('domain' in row)));
  } finally {
    manager.close();
  }
});

test('明确排除只保留统计明细，终态清除待处理候选', async () => {
  const usage = { model_calls: 1, cache_hits: 0, input_chars: 100 };
  const { manager } = harness({
    discover: async () => ({
      candidates: [
        { source_url: 'https://rejected.example/', source_title: 'Rejected' },
        { source_url: 'https://queued.example/', source_title: 'Queued' },
      ],
      skipped_existing: [{ url: 'https://known.example/' }],
    }),
    research: async () => ({
      outcome: 'rejected',
      reason: '产品不匹配',
      research: { ok: false, reason: '产品不匹配' },
      research_usage: usage,
    }),
  });
  try {
    const created = manager.create(
      { ...input, target_count: 1, research_budget: 1 },
      'rejected-redaction',
    );
    await manager.work(created.id);
    const job = manager.get(created.id);
    assert.equal(job.reason, 'research_limit');
    assert.equal(job.rejected, 1);
    assert.equal(job.searchStats[0].rejected, 1);
    assert.deepEqual(job.rows, [
      {
        search_id: job.searchStats[0].id,
        operation_id: `${job.id}-1`,
        result: 'rejected',
        reason: '产品不匹配',
        research_usage: usage,
      },
    ]);
    assert.deepEqual(job.researchUsage, usage);
    assert.deepEqual(job.queue, []);
    assert.deepEqual(job.seen, []);
    assert.deepEqual(job.skippedDomains, []);
    assert.deepEqual(job.searchSignatures, []);
    assert.equal(job.pendingSearch, null);
    assert.equal(job.current, null);
    assert.equal(manager.view(job).queued, 0);
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
    assert.equal(manager.stop(job.id).reason, 'stopped');
  } finally {
    manager.close();
  }
});
test('数量仅接受1–200整数，域名规范化并保留地域', () => {
  for (const n of [1, 20, 200]) assert.equal(validateCount(n), n);
  for (const n of [0, 201, 1.5, '20', null, NaN]) assert.throws(() => validateCount(n), /整数/);
  assert.equal(domainKey('https://WWW.Example.com/contact?x=1'), 'example.com');
  assert.equal(domainKey('http://127.0.0.1/'), '');
  const plan = searchPlan(input);
  assert.ok(plan.every((p) => p.query.includes('United States')));
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
        return { research: { product_match: 'not_matched' }, reason: '不匹配' };
      records.push({ id: 'r1', website: c.source_url, name: 'New' });
      return {
        新增: 1,
        handoff: readyHandoff(c.source_url),
        明细: [{ source_url: c.source_url, result: 'inserted', record_id: 'r1' }],
      };
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
      filtered_sources: [
        { url: 'https://www.cpsc.gov/safety', reason: '监管或统计资料' },
        {
          url: 'https://www.mydeal.com.au/seller/window-coverings',
          reason: '第三方平台或目录',
        },
      ],
    }),
    research: async (_target, item) => {
      if (item.domain === 'review.example')
        return {
          outcome: 'review',
          reason: '客户类型待核实',
          research: {
            review_required: true,
            customer_type_match: 'unknown',
          },
        };
      records.push({ id: 'rec-accepted', name: 'Accepted', website: item.source_url });
      return {
        新增: 1,
        明细: [{ source_url: item.source_url, result: 'inserted', record_id: 'rec-accepted' }],
        assessment: { grade: 'A', score: 80, status: '优先开发' },
        handoff: readyHandoff(item.source_url),
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
        filtered: job.searchStats[0].filtered,
        filterReasons: job.searchStats[0].filterReasons,
        filteredSources: job.searchStats[0].filteredSources,
        duplicates: job.searchStats[0].duplicates,
        queued: job.searchStats[0].queued,
        researched: job.searchStats[0].researched,
        inserted: job.searchStats[0].inserted,
        review: job.searchStats[0].review,
        ratings: job.searchStats[0].ratings,
      },
      {
        discovered: 5,
        filtered: 2,
        filterReasons: { 监管或统计资料: 1, 第三方平台或目录: 1 },
        filteredSources: [
          { domain: 'cpsc.gov', reason: '监管或统计资料' },
          { domain: 'mydeal.com.au', reason: '第三方平台或目录' },
        ],
        duplicates: 1,
        queued: 2,
        researched: 2,
        inserted: 1,
        review: 1,
        ratings: { A: 0, B: 0, C: 0, unrated: 0, A: 1 },
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
test('已知抓取失败占研究次数，不计新增，达到有界研究预算后部分完成', async () => {
  const { manager } = harness({
    research: async () => ({ outcome: 'failed', stage: 'extract', reason: '空正文' }),
  });
  try {
    const j = manager.create({ ...input, target_count: 1 }, 'research-limit');
    await manager.work(j.id);
    const done = manager.get(j.id);
    assert.equal(done.reason, 'research_limit');
    assert.equal(done.failed, 12);
    assert.equal(done.inserted, 0);
  } finally {
    manager.close();
  }
});
test('最后一次搜索的候选继续处理，仍遵守新增目标和研究预算且不追加搜索', async () => {
  for (const [target, budget, inserted, reason] of [
    [1, 3, 1, 'target_reached'],
    [3, 3, 2, 'search_limit'],
    [3, 1, 1, 'research_limit'],
  ]) {
    let searches = 0;
    const { manager } = harness({
      discover: async () => ({
        candidates:
          ++searches === 2
            ? [
                { source_url: 'https://last-one.example.org/' },
                { source_url: 'https://last-two.example.org/' },
              ]
            : [],
      }),
    });
    try {
      const job = manager.create(
        { ...input, target_count: target, research_budget: budget },
        'last-search-candidates',
      );
      job.limits.searches = 2;
      manager.save(job);
      await manager.work(job.id);
      const result = manager.get(job.id);
      assert.equal(result.inserted, inserted);
      assert.equal(result.researched, inserted);
      assert.equal(result.searchStats.at(-1).researched, inserted);
      assert.equal(result.reason, reason);
      assert.equal(searches, 2);
    } finally {
      manager.close();
    }
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
    handoff: readyHandoff('https://company1.com/'),
    明细: [{ source_url: 'https://company1.com/', result: 'inserted', record_id: 'r1' }],
  };
  const { manager } = harness({
    research: async () => {
      count++;
      throw new Error('timeout');
    },
    status: async () => ({ settled, output: row }),
    readLeads: async () =>
      count ? [{ id: 'r1', website: 'https://company1.com/', name: 'Company' }] : [],
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

for (const hasCurrent of [false, true])
  test(`切换客户库后禁止自动和手动恢复${hasCurrent ? '有' : '无'}待确认企业的任务，切回原库可继续`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shade-batch-scope-'));
    const path = join(dir, 'jobs.sqlite');
    let manager;
    try {
      manager = harness({ path, scope: 'table-a' }).manager;
      const job = manager.create({ ...input, target_count: 1 }, 'scope-recovery');
      if (hasCurrent) {
        job.current = {
          domain: 'interrupted.example.com',
          source_url: 'https://interrupted.example.com/',
          operation_id: `${job.id}-1`,
        };
        job.researched = 1;
        manager.save(job);
      }
      manager.close();
      let calls = 0;
      const unexpected = async () => {
        calls++;
        return { settled: false };
      };
      manager = harness({
        path,
        scope: 'table-b',
        status: unexpected,
        discover: unexpected,
        research: unexpected,
        readLeads: unexpected,
      }).manager;
      const paused = manager.get(job.id);
      await manager.resumeInterrupted();
      assert.deepEqual(manager.get(job.id), paused);
      await assert.rejects(manager.resume(job.id), { status: 409, message: /客户库/ });
      assert.equal(calls, 0);
      assert.deepEqual(manager.get(job.id), paused);
      manager.close();
      manager = harness({
        path,
        scope: 'table-a',
        status: async () => ({ settled: true, output: { outcome: 'failed', stage: 'select' } }),
      }).manager;
      await manager.resumeInterrupted();
      await manager.work(job.id);
      assert.equal(manager.get(job.id).status, 'completed');
      assert.equal(manager.get(job.id).inserted, 1);
    } finally {
      manager?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('读阶段服务中断经核对后自动重试一次并继续下一候选', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shade-batch-recovery-'));
  const path = join(dir, 'jobs.sqlite');
  let manager;
  try {
    manager = harness({ path, provider: 'native' }).manager;
    const job = manager.create({ ...input, target_count: 1 }, 'recover-read-stage');
    const original = {
      source_url: 'https://interrupted.example.com/',
      domain: 'interrupted.example.com',
      operation_id: `${job.id}-1`,
    };
    job.current = original;
    job.researched = 1;
    job.queue = [{ source_url: 'https://next.example.com/', domain: 'next.example.com' }];
    manager.save(job);
    manager.close();
    const leads = [];
    const attempts = [];
    manager = harness({
      path,
      provider: 'native',
      status: async () => ({
        settled: true,
        output: {
          stage: 'extract',
          outcome: 'failed',
          reason: '服务在写入前中断；本次企业未入库',
          retryable_before_write: true,
        },
      }),
      research: async (_target, item) => {
        attempts.push(item);
        leads.push({ id: 'recovered', name: 'Recovered', website: item.source_url });
        return {
          新增: 1,
          明细: [{ source_url: item.source_url, result: 'inserted', record_id: 'recovered' }],
        };
      },
      readLeads: async () => leads,
    }).manager;
    assert.equal(manager.get(job.id).status, 'paused');
    await manager.resumeInterrupted();
    await manager.work(job.id);
    const recovered = manager.get(job.id);
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.failed, 1);
    assert.equal(recovered.inserted, 1);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].source_url, original.source_url);
    assert.notEqual(attempts[0].operation_id, original.operation_id);
    assert.equal(attempts[0].interruptionRetries, 1);
    assert.equal(recovered.queue.length, 0);
  } finally {
    await manager?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('原生任务重启时自动恢复写入前中断，无需人工点继续', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shade-batch-auto-resume-'));
  const path = join(dir, 'jobs.sqlite');
  let manager;
  try {
    manager = harness({ path, provider: 'native' }).manager;
    const job = manager.create({ ...input, target_count: 1 }, 'auto-resume-read-stage');
    job.current = {
      source_url: 'https://interrupted.example.com/',
      domain: 'interrupted.example.com',
      operation_id: `${job.id}-1`,
    };
    job.researched = 1;
    manager.save(job);
    manager.close();
    const leads = [];
    manager = harness({
      path,
      provider: 'native',
      schedule: true,
      status: async () => ({
        settled: true,
        output: { stage: 'extract', outcome: 'failed', retryable_before_write: true },
      }),
      research: async (_target, item) => {
        leads.push({ id: 'resumed', name: 'Resumed', website: item.source_url });
        return {
          新增: 1,
          明细: [{ source_url: item.source_url, result: 'inserted', record_id: 'resumed' }],
        };
      },
      readLeads: async () => leads,
    }).manager;
    for (let i = 0; i < 50 && manager.get(job.id).status !== 'completed'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const resumed = manager.get(job.id);
    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.inserted, 1);
    assert.equal(resumed.rows.length, 2);
  } finally {
    await manager?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('运行时结果不明由后台按原操作编号自动核对并继续，无需人工点击', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shade-batch-auto-reconcile-'));
  const path = join(dir, 'jobs.sqlite');
  let manager;
  try {
    manager = harness({ path, provider: 'native' }).manager;
    const job = manager.create({ ...input, target_count: 1 }, 'auto-reconcile-uncertain');
    const operationId = `${job.id}-1`;
    job.status = 'paused';
    job.reason = 'uncertain';
    job.current = {
      source_url: 'https://uncertain.example.com/',
      domain: 'uncertain.example.com',
      operation_id: operationId,
    };
    job.researched = 1;
    job.queue = [{ source_url: 'https://next.example.com/', domain: 'next.example.com' }];
    manager.save(job);
    manager.close();
    const statusIds = [];
    const leads = [];
    manager = harness({
      path,
      provider: 'native',
      schedule: true,
      recoveryIntervalMs: 5,
      status: async (id) => {
        statusIds.push(id);
        return statusIds.length === 1
          ? { settled: false, reason: '写入尚未确认，未自动重试' }
          : {
              settled: true,
              output: { stage: 'select', outcome: 'failed', reason: '原操作已确认失败' },
            };
      },
      research: async (_target, item) => {
        leads.push({ id: 'next', name: 'Next', website: item.source_url });
        return {
          新增: 1,
          明细: [{ source_url: item.source_url, result: 'inserted', record_id: 'next' }],
        };
      },
      readLeads: async () => leads,
    }).manager;
    for (let i = 0; i < 100 && manager.get(job.id).status !== 'completed'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const resumed = manager.get(job.id);
    assert.equal(resumed.status, 'completed');
    assert.ok(statusIds.length >= 2);
    assert.ok(statusIds.every((id) => id === operationId));
    assert.deepEqual(
      resumed.rows.map((row) => row.result),
      ['failed', 'inserted'],
    );
  } finally {
    await manager?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('操作记录缺失时不重放当前企业，记为失败并自动继续剩余队列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shade-batch-missing-operation-'));
  const path = join(dir, 'jobs.sqlite');
  let manager;
  try {
    manager = harness({ path, provider: 'native' }).manager;
    const job = manager.create(
      { ...input, target_count: 1, auto_first_touch: true, auto_follow_up: false },
      'missing-operation-resume',
    );
    const operationId = `${job.id}-1`;
    job.current = {
      source_url: 'https://missing.example.com/',
      domain: 'missing.example.com',
      operation_id: operationId,
    };
    job.researched = 1;
    job.queue = [{ source_url: 'https://next.example.com/', domain: 'next.example.com' }];
    manager.save(job);
    manager.close();
    const researched = [];
    const leads = [];
    manager = harness({
      path,
      provider: 'native',
      schedule: true,
      recoveryIntervalMs: 5,
      status: async (id) => ({
        settled: false,
        missing: id === operationId,
        reason: '操作记录不存在，未自动重放',
      }),
      research: async (_target, item) => {
        researched.push(item.source_url);
        leads.push({ id: 'next', name: 'Next', website: item.source_url });
        return {
          新增: 1,
          明细: [{ source_url: item.source_url, result: 'inserted', record_id: 'next' }],
        };
      },
      readLeads: async () => leads,
    }).manager;
    for (let i = 0; i < 100 && manager.get(job.id).status !== 'completed'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const resumed = manager.get(job.id);
    assert.equal(resumed.status, 'completed');
    assert.deepEqual(researched, ['https://next.example.com/']);
    assert.equal(resumed.failed, 1);
    assert.equal(resumed.rows.filter((row) => row.operation_id === operationId).length, 1);
    assert.equal(resumed.rows[0].operation_id, operationId);
    assert.equal(resumed.rows[0].result, 'failed');
    assert.match(resumed.rows[0].reason, /操作记录不存在|未重放/);
    assert.deepEqual(acquisitionOutreachSources(manager, { list: () => [] })[0].customerIds, [
      'next',
    ]);
  } finally {
    await manager?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('真正写入未确认时后台只轮询原操作，保持暂停且不研究其他企业', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shade-batch-write-unconfirmed-'));
  const path = join(dir, 'jobs.sqlite');
  let manager;
  try {
    manager = harness({ path, provider: 'native' }).manager;
    const job = manager.create(
      { ...input, target_count: 1, auto_first_touch: true, auto_follow_up: false },
      'write-unconfirmed-poll',
    );
    const operationId = `${job.id}-1`;
    job.status = 'paused';
    job.reason = 'uncertain';
    job.current = {
      source_url: 'https://uncertain.example.com/',
      domain: 'uncertain.example.com',
      operation_id: operationId,
    };
    job.researched = 1;
    job.queue = [{ source_url: 'https://next.example.com/', domain: 'next.example.com' }];
    manager.save(job);
    manager.close();
    const statusIds = [];
    let researchCalls = 0;
    manager = harness({
      path,
      provider: 'native',
      schedule: true,
      recoveryIntervalMs: 5,
      status: async (id) => {
        statusIds.push(id);
        return { settled: false, reason: '写入尚未确认，未自动重试' };
      },
      research: async () => {
        researchCalls++;
        assert.fail('写入未确认时不得研究下一企业');
      },
    }).manager;
    for (let i = 0; i < 20 && statusIds.length < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    const paused = manager.get(job.id);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.current.operation_id, operationId);
    assert.ok(statusIds.length >= 2);
    assert.ok(statusIds.every((id) => id === operationId));
    assert.equal(researchCalls, 0);
    assert.deepEqual(acquisitionOutreachSources(manager, { list: () => [] })[0].customerIds, []);
  } finally {
    await manager?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('后台核对保持单飞，关闭时等待慢状态查询且不再改写任务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shade-batch-recovery-close-'));
  const path = join(dir, 'jobs.sqlite');
  let manager;
  try {
    manager = harness({ path, provider: 'native' }).manager;
    const job = manager.create({ ...input, target_count: 1 }, 'recovery-close-safety');
    const operationId = `${job.id}-1`;
    job.status = 'paused';
    job.reason = 'uncertain';
    job.current = {
      source_url: 'https://uncertain.example.com/',
      domain: 'uncertain.example.com',
      operation_id: operationId,
    };
    job.researched = 1;
    manager.save(job);
    manager.close();

    let active = 0;
    let calls = 0;
    let maximumActive = 0;
    let releaseStatus;
    manager = harness({
      path,
      provider: 'native',
      schedule: true,
      recoveryIntervalMs: 5,
      status: async (id) => {
        calls++;
        active++;
        maximumActive = Math.max(maximumActive, active);
        const result = await new Promise((resolve) => {
          releaseStatus = resolve;
        });
        active--;
        assert.equal(id, operationId);
        return result;
      },
    }).manager;

    for (let i = 0; i < 50 && calls < 1; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    assert.equal(maximumActive, 1);

    releaseStatus({ settled: false, reason: '写入尚未确认，未自动重试' });
    for (let i = 0; i < 50 && calls < 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(calls, 2);
    const closing = manager.close();
    releaseStatus({ settled: false, missing: true, reason: '操作记录不存在，未自动重放' });
    await closing;
    manager = harness({ path, provider: 'native' }).manager;
    const unchanged = manager.get(job.id);
    assert.equal(unchanged.status, 'paused');
    assert.equal(unchanged.current.operation_id, operationId);
    assert.equal(unchanged.failed, 0);
    assert.deepEqual(unchanged.rows, []);
  } finally {
    await manager?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('发布维护期间不发起核对，维护在查询中开启也不恢复任务', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shade-batch-recovery-maintenance-'));
  const path = join(dir, 'jobs.sqlite');
  let manager;
  try {
    manager = harness({ path, provider: 'native' }).manager;
    const job = manager.create({ ...input, target_count: 1 }, 'recovery-maintenance-safety');
    const operationId = `${job.id}-1`;
    job.status = 'paused';
    job.reason = 'uncertain';
    job.current = {
      source_url: 'https://uncertain.example.com/',
      domain: 'uncertain.example.com',
      operation_id: operationId,
    };
    job.researched = 1;
    job.queue = [{ source_url: 'https://next.example.com/', domain: 'next.example.com' }];
    manager.save(job);
    manager.close();

    let maintaining = false;
    let calls = 0;
    let releaseFirst;
    const leads = [];
    manager = harness({
      path,
      provider: 'native',
      schedule: true,
      recoveryIntervalMs: 5,
      isMaintaining: () => maintaining,
      status: async (id) => {
        calls++;
        assert.equal(id, operationId);
        if (calls === 1) await new Promise((resolve) => (releaseFirst = resolve));
        return {
          settled: true,
          output: { stage: 'select', outcome: 'failed', reason: '原操作已确认失败' },
        };
      },
      research: async (_target, item) => {
        leads.push({ id: 'next', name: 'Next', website: item.source_url });
        return {
          新增: 1,
          明细: [{ source_url: item.source_url, result: 'inserted', record_id: 'next' }],
        };
      },
      readLeads: async () => leads,
    }).manager;

    for (let i = 0; i < 50 && calls < 1; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(calls, 1);
    maintaining = true;
    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const paused = manager.get(job.id);
    assert.equal(calls, 1);
    assert.equal(paused.status, 'paused');
    assert.equal(paused.current.operation_id, operationId);
    assert.deepEqual(paused.rows, []);

    maintaining = false;
    for (let i = 0; i < 100 && manager.get(job.id).status !== 'completed'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(manager.get(job.id).status, 'completed');
    assert.ok(calls >= 2);
  } finally {
    await manager?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kick 前进入维护会暂停新研究，用户已停止的任务不会在维护后复活', async () => {
  const leads = [];
  let maintaining = true;
  let researchCalls = 0;
  const { manager } = harness({
    schedule: true,
    recoveryIntervalMs: 5,
    isMaintaining: () => maintaining,
    research: async (_target, item) => {
      researchCalls++;
      const id = `rec-${researchCalls}`;
      leads.push({ id, name: item.domain, website: item.source_url });
      return {
        新增: 1,
        明细: [{ source_url: item.source_url, result: 'inserted', record_id: id }],
      };
    },
    readLeads: async () => leads,
  });
  try {
    const paused = manager.create({ ...input, target_count: 1 }, 'maintenance-before-kick');
    for (let i = 0; i < 50 && manager.get(paused.id).status === 'running'; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(manager.get(paused.id).status, 'paused');
    assert.equal(researchCalls, 0);

    maintaining = false;
    for (let i = 0; i < 100 && manager.get(paused.id).status !== 'completed'; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(manager.get(paused.id).status, 'completed');
    assert.equal(researchCalls, 1);

    maintaining = true;
    const stopping = manager.create({ ...input, target_count: 1 }, 'maintenance-after-stop');
    manager.stop(stopping.id);
    for (let i = 0; i < 50 && manager.get(stopping.id).status === 'stopping'; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    maintaining = false;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const stopped = manager.get(stopping.id);
    assert.equal(stopped.status, 'partial');
    assert.equal(stopped.reason, 'stopped');
    assert.equal(researchCalls, 1);
  } finally {
    await manager.close();
  }
});

test('已结算的 select 阶段操作自动对账并继续队列', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shade-batch-select-resume-'));
  const path = join(dir, 'jobs.sqlite');
  let manager;
  try {
    manager = harness({ path, provider: 'native' }).manager;
    const job = manager.create({ ...input, target_count: 1 }, 'resume-settled-select');
    job.current = {
      source_url: 'https://select.example.com/',
      domain: 'select.example.com',
      operation_id: `${job.id}-1`,
    };
    job.researched = 1;
    job.queue = [{ source_url: 'https://next.example.com/', domain: 'next.example.com' }];
    manager.save(job);
    manager.close();
    const leads = [];
    manager = harness({
      path,
      provider: 'native',
      schedule: true,
      status: async () => ({
        settled: true,
        output: { stage: 'select', outcome: 'failed', reason: '候选未取得有效信息' },
      }),
      research: async (_target, item) => {
        leads.push({ id: 'next', name: 'Next', website: item.source_url });
        return {
          新增: 1,
          明细: [{ source_url: item.source_url, result: 'inserted', record_id: 'next' }],
        };
      },
      readLeads: async () => leads,
    }).manager;
    for (let i = 0; i < 50 && manager.get(job.id).status !== 'completed'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const resumed = manager.get(job.id);
    assert.equal(resumed.status, 'completed');
    assert.deepEqual(
      resumed.rows.map((row) => row.result),
      ['failed', 'inserted'],
    );
    assert.equal(resumed.researched, 2);
  } finally {
    await manager?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('不确定写入和重复读阶段中断均不无限重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shade-batch-safety-'));
  const path = join(dir, 'jobs.sqlite');
  let manager;
  try {
    manager = harness({ path, provider: 'native' }).manager;
    const job = manager.create({ ...input, target_count: 1 }, 'recover-safety');
    job.current = {
      source_url: 'https://interrupted.example.com/',
      domain: 'interrupted.example.com',
      operation_id: `${job.id}-1`,
      interruptionRetries: 1,
    };
    job.researched = 1;
    manager.save(job);
    manager.close();
    manager = harness({
      path,
      provider: 'native',
      status: async () => ({
        settled: false,
        reason: '写入结果待核对',
      }),
    }).manager;
    await manager.resumeInterrupted();
    assert.equal(manager.get(job.id).status, 'paused');
    manager.remoteStatus = async () => ({
      settled: true,
      output: {
        stage: 'extract',
        outcome: 'failed',
        retryable_before_write: true,
      },
    });
    await manager.resumeInterrupted();
    const resumed = manager.get(job.id);
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.queue.length, 0);
  } finally {
    manager?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('全国查询遇到重复且没有新增时按本国地区补搜，只有核实入库才计入目标', async () => {
  for (const [country, regions] of [
    ['Canada', ['Alberta', 'British Columbia']],
    ['Australia', ['Australian Capital Territory', 'New South Wales']],
    ['United States', ['Alabama', 'Alaska']],
    ['Japan', []],
  ]) {
    const queries = [];
    const { manager, leads } = harness({
      discover: async (target, search) => {
        assert.equal(target.country, country);
        assert.equal(target.region, '');
        assert.equal(search.country, country);
        queries.push(search.query);
        const index = regions.findIndex((region) => search.query.endsWith(' ' + region));
        return index < 0
          ? { skipped_existing: [{ url: 'https://known.example/' }] }
          : {
              candidates: Array.from({ length: index === 0 ? 20 : 15 }, (_, n) => ({
                source_url: 'https://regional-' + index + '-' + n + '.example.org/',
              })),
            };
      },
    });
    try {
      const job = manager.create(
        { ...input, country, query_mode: 'auto', target_count: 35 },
        'region-replenish',
      );
      await manager.work(job.id);
      const result = manager.get(job.id);
      const expected = regions.length ? 35 : 0;
      assert.equal(result.inserted, expected);
      assert.equal(new Set(leads.map((row) => row.website)).size, expected);
      if (regions.length) {
        assert.deepEqual(queries, [
          job.queryPlan[0].query,
          job.queryPlan[0].query + ' ' + regions[0],
          job.queryPlan[1].query,
          job.queryPlan[1].query + ' ' + regions[1],
        ]);
        assert.equal(result.cursor, 2);
      } else {
        assert.ok(result.searchStats.some((stat) => stat.searchRegion === 'Hokkaidō'));
      }
    } finally {
      manager.close();
    }
  }
});

test('地区补搜中断后停止，下一轮从下一条全国词继续', async () => {
  const calls = [];
  const { manager } = harness({
    discover: async (_target, search) => {
      calls.push(search.query);
      if (calls.length === 2) throw new Error('搜索中断');
      return { skipped_existing: [{ url: 'https://known.example/' }] };
    },
  });
  try {
    const target = { ...input, country: 'Canada', query_mode: 'auto' };
    const first = manager.create(target, 'region-interrupted', { scheduleId: 'weekly' });
    await manager.work(first.id);
    assert.equal(manager.get(first.id).pendingSearch.query, first.queryPlan[0].query + ' Alberta');
    manager.stop(first.id);
    const second = manager.create(target, 'region-continued', { scheduleId: 'weekly' });
    second.limits.searches = 1;
    manager.save(second);
    await manager.work(second.id);
    assert.equal(calls[2], first.queryPlan[1].query);
    assert.equal(calls.length, 3);
    assert.equal(manager.get(second.id).reason, 'search_limit');
  } finally {
    manager.close();
  }
});
