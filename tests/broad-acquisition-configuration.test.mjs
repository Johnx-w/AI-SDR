import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createApp, validateInput } from '../server/app.mjs';
import { validateTarget } from '../server/search-target.mjs';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { AcquisitionSchedules } from '../server/acquisition-schedules.mjs';
import { builtinProducts, isAllProductScope } from '../src/domain/acquisition-products.mjs';
import { researchPolicyCode } from '../scripts/research-policy-code.mjs';

test('只提供目标市场的新请求默认覆盖全部窗饰并生成自动搜索词', () => {
  const target = validateInput({ country: 'United States' });
  assert.equal(target.product_scope, 'all');
  assert.equal(target.environment_preference, 'all');
  assert.equal(target.product, 'window coverings');
  assert.deepEqual(target.products, []);
  assert.equal(target.query_mode, 'auto');
  assert.match(target.search_query, /window coverings/);
  for (const preference of ['indoor', 'outdoor']) {
    const preferred = validateInput({
      country: 'United States',
      environment_preference: preference,
    });
    assert.equal(preferred.product_scope, 'all');
    assert.deepEqual(preferred.products, []);
    assert.equal(preferred.environment_preference, preference);
  }
});

test('共享研究规则生成的独立脚本包含全范围判断的依赖', () => {
  assert.equal(
    vm.runInNewContext(
      researchPolicyCode +
        '\nproductsRelevant(["curtain tracks"], {product_scope:"all", product:"window coverings"});',
    ),
    'matched',
  );
});

test('指定产品与旧计划保留限制，非法范围及冲突配置被拒绝', () => {
  const product = builtinProducts[0];
  const legacy = validateTarget({ country: 'United States', product: product.value });
  assert.equal(isAllProductScope(legacy), false);
  assert.equal(legacy.product_scope, undefined);
  const specific = validateTarget({
    country: 'United States',
    product_scope: 'specific',
    products: [product],
  });
  assert.equal(specific.product_scope, 'specific');
  assert.equal(specific.product, product.value);
  for (const input of [
    { product_scope: 'everything' },
    { environment_preference: 'outdoor-only' },
    { product_scope: 'all', products: [product] },
    { product_scope: 'all', products: 'all' },
    { product_scope: 'specific', products: [] },
    { product: '' },
  ])
    assert.throws(() => validateTarget({ country: 'United States', ...input }), { status: 400 });
});

test('全范围及偏好保存在执行和定时快照，旧计划不会被改成全范围', () => {
  const now = () => Date.parse('2026-10-22T00:00:00Z');
  const jobs = new BatchJobs({ schedule: false, now, provider: 'native' });
  const schedules = new AcquisitionSchedules({ jobs: () => jobs, now });
  try {
    const input = {
      ...validateInput({ country: 'United States', environment_preference: 'outdoor' }),
      target_count: 20,
    };
    const schedule = schedules.create(
      {
        name: '全范围定时获客',
        input,
        timing: {
          repeat: 'daily',
          startDate: '2026-10-23',
          times: ['09:00'],
          timezone: 'Asia/Shanghai',
        },
      },
      'broad-schedule-snapshot',
    );
    const legacy = schedules.create(
      {
        name: '旧罗马帘计划',
        input: {
          ...validateInput({
            country: 'United States',
            product: 'Roman blinds',
            query_mode: 'auto',
          }),
          target_count: 20,
        },
        timing: {
          repeat: 'daily',
          startDate: '2026-10-23',
          times: ['10:00'],
          timezone: 'Asia/Shanghai',
        },
      },
      'legacy-schedule-snapshot',
    );
    const job = jobs.create(schedule.input, 'broad-job-snapshot');
    assert.equal(jobs.get(job.id).input.environment_preference, 'outdoor');
    assert.equal(jobs.get(job.id).input.product_scope, 'all');
    assert.ok(job.queryPlan.some(({ query }) => query.includes('blind components')));
    assert.equal(schedules.get(schedule.id).input.product_scope, 'all');
    assert.equal(schedules.get(legacy.id).input.product, 'Roman blinds');
    assert.equal(isAllProductScope(schedules.get(legacy.id).input), false);
  } finally {
    schedules.close();
    jobs.close();
  }
});

test('全范围预览接口接受空产品，旧引擎不能静默丢失新范围', async () => {
  for (const provider of ['native', 'n8n']) {
    const app = createApp({
      env: { ACQUISITION_PROVIDER: provider },
      fetchImpl: async () => {
        throw new Error('不应发起外部请求');
      },
    });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${app.address().port}/api/v1/acquisition/search-preview`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            country: 'United States',
            product_scope: 'all',
            products: [],
            environment_preference: 'indoor',
          }),
        },
      );
      assert.equal(response.status, provider === 'native' ? 200 : 400);
      const body = await response.json();
      if (provider === 'native') {
        assert.ok(body.queries.some(({ query }) => query.includes('outdoor blinds')));
        assert.ok(body.queries.some(({ query }) => query.includes('blind components')));
      } else assert.match(body.error, /后端直连/);
    } finally {
      await new Promise((resolve) => app.close(resolve));
    }
  }
});

test('定时触发时重新检查引擎能力，不因保存后换引擎而静默缩小范围', () => {
  let currentTime = Date.parse('2026-10-22T00:00:00Z');
  let provider = 'native';
  const jobs = new BatchJobs({ schedule: false, now: () => currentTime });
  const schedules = new AcquisitionSchedules({
    jobs: () => jobs,
    now: () => currentTime,
    ready: () => true,
    available: () => true,
    checkInput: (input) => {
      if (provider !== 'native' && isAllProductScope(input))
        throw Object.assign(new Error('全部窗饰范围需要后端直连引擎'), { status: 400 });
    },
  });
  try {
    const plan = schedules.create(
      {
        name: '全范围定时获客',
        input: { ...validateInput({ country: 'United States' }), target_count: 20 },
        timing: { repeat: 'once', startDate: '2026-10-22', times: ['09:00'] },
      },
      'broad-capability-schedule',
    );
    currentTime = Date.parse('2026-10-22T01:00:00Z');
    provider = 'n8n';
    schedules.tick();
    assert.equal(jobs.list().length, 0);
    assert.equal(schedules.get(plan.id).runs, 0);
    assert.match(schedules.get(plan.id).lastError, /后端直连/);
    provider = 'native';
    schedules.tick();
    assert.equal(jobs.list().length, 1);
    assert.equal(jobs.list()[0].input.product_scope, 'all');
    assert.equal(schedules.get(plan.id).runs, 1);
  } finally {
    schedules.close();
    jobs.close();
  }
});
