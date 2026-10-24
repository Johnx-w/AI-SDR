import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BatchJobs } from '../server/batch-jobs.mjs';

const input = {
  country: 'United States',
  region: '',
  product: 'roller blinds',
  audience: 'BC',
  search_query: 'roller blinds United States',
  acquisition_channel: 'web',
  target_count: 5,
};
function harness(extra = {}) {
  return new BatchJobs({
    schedule: false,
    provider: 'native',
    discover: async () => ({ candidates: [] }),
    research: async () => {
      throw new Error('fixture must not request a model');
    },
    status: async () => ({ settled: false }),
    readLeads: async () => [],
    ...extra,
  });
}
function current(manager, job, operation = 'operation-1') {
  job.current = {
    operation_id: operation,
    domain: 'company.example',
    source_url: 'https://company.example/',
  };
  manager.save(job);
  return job;
}
const failure = (research_usage) => ({
  outcome: 'failed',
  stage: 'research',
  reason: 'fixture',
  ...(research_usage ? { research_usage } : {}),
});

test('只累加真实返回的研究统计；复用结果不再累计旧请求或 Token', async () => {
  const manager = harness();
  try {
    const job = current(manager, manager.create(input, 'usage-reported-1'));
    await manager.accept(
      job,
      failure({
        model_calls: 1,
        cache_hits: 0,
        input_chars: 1200,
        input_tokens: 400,
        output_tokens: 100,
        omitted_pages: 2,
        truncated_pages: 1,
      }),
    );
    current(manager, job, 'operation-2');
    await manager.accept(job, failure({ model_calls: 0, cache_hits: 1, input_chars: 0 }));
    assert.deepEqual(manager.get(job.id).researchUsage, {
      model_calls: 1,
      cache_hits: 1,
      input_chars: 1200,
      input_tokens: 400,
      output_tokens: 100,
      omitted_pages: 2,
      truncated_pages: 1,
    });
    assert.equal(manager.get(job.id).rows[1].research_usage.cache_hits, 1);
  } finally {
    manager.close();
  }
});

test('旧结果和 n8n 无 usage 时保持未知，不伪造模型零调用或 Token', async () => {
  const manager = harness({ provider: 'n8n' });
  try {
    const job = current(manager, manager.create(input, 'usage-unknown-1'));
    await manager.accept(job, failure());
    const done = manager.get(job.id);
    assert.equal(Object.hasOwn(done, 'researchUsage'), false);
    assert.equal(Object.hasOwn(done.rows[0], 'research_usage'), false);
  } finally {
    manager.close();
  }
});

test('明确的模型前过滤零调用统计可以展示，不能与缺失统计混为一谈', async () => {
  const manager = harness();
  try {
    const job = current(manager, manager.create(input, 'usage-prefilter-1'));
    await manager.accept(job, failure({ model_calls: 0, cache_hits: 0, input_chars: 0 }));
    assert.deepEqual(manager.get(job.id).researchUsage, {
      model_calls: 0,
      cache_hits: 0,
      input_chars: 0,
    });
    assert.equal(Object.hasOwn(manager.get(job.id).researchUsage, 'input_tokens'), false);
  } finally {
    manager.close();
  }
});

test('同一操作的 stale accept/status 重放不重复累计结果与模型统计', async () => {
  const manager = harness();
  try {
    const job = current(manager, manager.create(input, 'usage-replay-1'));
    const stale = structuredClone(job);
    const output = failure({ model_calls: 1, cache_hits: 0, input_chars: 100 });
    await manager.accept(job, output);
    await manager.accept(stale, output);
    assert.equal(manager.get(job.id).failed, 1);
    assert.equal(manager.get(job.id).rows.length, 1);
    assert.deepEqual(manager.get(job.id).researchUsage, {
      model_calls: 1,
      cache_hits: 0,
      input_chars: 100,
    });
    assert.equal(
      stale.current,
      null,
      'stale caller receives saved checkpoint before any later save',
    );
    await manager.accept(stale, output);
    assert.equal(manager.get(job.id).researchUsage.model_calls, 1);
  } finally {
    manager.close();
  }
});

test('暂停操作由 status 核对并 resume 只记一次，不发起新研究请求', async () => {
  let statusCalls = 0;
  const output = failure({ model_calls: 1, cache_hits: 0, input_chars: 30, input_tokens: 20 });
  const manager = harness({
    status: async () => {
      statusCalls++;
      return { settled: true, output };
    },
  });
  try {
    const job = current(manager, manager.create(input, 'usage-resume-1'));
    const stale = structuredClone(job);
    job.status = 'paused';
    job.pending = 1;
    manager.save(job);
    await manager.resume(job.id);
    assert.equal(statusCalls, 1);
    assert.equal(manager.get(job.id).researchUsage.model_calls, 1);
    assert.equal(manager.get(job.id).current, null);
    await manager.accept(stale, output);
    assert.equal(manager.get(job.id).researchUsage.model_calls, 1);
    await assert.rejects(manager.resume(job.id), /暂停任务/);
    assert.equal(statusCalls, 1);
  } finally {
    manager.close();
  }
});

test('客户写入读回待核对时不提前累计，核对成功才接纳同次 usage', async () => {
  let verified = false;
  const manager = harness({
    readLeads: async () =>
      verified ? [{ id: 'record-1', name: 'Company', website: 'https://company.example/' }] : [],
  });
  try {
    const job = current(manager, manager.create(input, 'usage-readback-1'));
    const output = {
      新增: 1,
      明细: [{ source_url: 'https://company.example/', result: 'inserted', record_id: 'record-1' }],
      research_usage: { model_calls: 1, cache_hits: 0, input_chars: 100 },
    };
    await assert.rejects(manager.accept(job, output), /读回核验失败/);
    assert.equal(Object.hasOwn(manager.get(job.id), 'researchUsage'), false);
    verified = true;
    await manager.accept(job, output);
    assert.equal(manager.get(job.id).inserted, 1);
    assert.equal(manager.get(job.id).researchUsage.model_calls, 1);
  } finally {
    manager.close();
  }
});

test('非数值、负数、缺失必需字段的 usage 不被当成已知零值', async () => {
  const manager = harness();
  try {
    const job = manager.create(input, 'usage-malformed-1');
    for (const [index, usage] of [
      { model_calls: '1', cache_hits: 0, input_chars: 20 },
      { model_calls: -1, cache_hits: 0, input_chars: 20 },
      { model_calls: 1, cache_hits: 0 },
    ].entries()) {
      current(manager, job, 'operation-' + index);
      await manager.accept(job, failure(usage));
      assert.equal(Object.hasOwn(manager.get(job.id), 'researchUsage'), false);
    }
  } finally {
    manager.close();
  }
});
