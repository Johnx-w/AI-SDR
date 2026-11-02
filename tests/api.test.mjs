import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../server/app.mjs';
import { withApp } from './helpers/http.mjs';
import { feishuEnv } from './helpers/feishu.mjs';
const configured = {
  ...feishuEnv,
  TAVILY_API_KEY: 'fixture-search',
  DEEPSEEK_API_KEY: 'fixture-model',
};
const input = {
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
  search_query: 'outdoor zip screens Florida',
};
const post = (base, body = input, key = 'run-test-0001', headers = {}) =>
  fetch(base + '/api/v1/acquisition/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers },
    body: JSON.stringify(body),
  });
test('入口限制市场和已接入渠道，结构化客户类型成为新任务筛选', () => {
  assert.deepEqual(validateInput(input), {
    ...input,
    audience: 'BC',
    customer_type: '',
    customer_profile: 'all',
    market_countries: ['United States'],
  });
  assert.throws(() => validateInput({ ...input, country: 'invalid' }), /支持的国家/);
  assert.throws(() => validateInput({ ...input, region: 'New South Wales' }), /该国家/);
  assert.deepEqual(
    validateInput({ ...input, customer_types: ['service_provider', 'distributor'] }),
    {
      ...input,
      audience: 'BC',
      customer_type: '',
      customer_profile: 'all',
      customer_types: ['service_provider', 'distributor'],
      market_countries: ['United States'],
    },
  );
  const { acquisition_channel, ...legacy } = input;
  assert.equal(validateInput(legacy).acquisition_channel, acquisition_channel);
  for (const channel of [
    'google_web',
    'google_maps',
    'linkedin',
    'facebook',
    'instagram',
    'local_directories',
  ]) {
    assert.throws(() => validateInput({ ...input, acquisition_channel: channel }), /渠道尚未接入/);
  }
});

test('未接入渠道在运行入口被拒绝，不调用上游', async () => {
  await withApp(
    {
      env: configured,
      fetchImpl: async () => {
        throw new Error('Unexpected upstream request');
      },
    },
    async (base) => {
      for (const channel of [
        'google_web',
        'google_maps',
        'linkedin',
        'facebook',
        'instagram',
        'local_directories',
      ]) {
        const body = { ...input, acquisition_channel: channel };
        assert.equal((await post(base, body)).status, 400);
      }
    },
  );
});
test('未配置直连凭证时明确报告缺项，不能伪造运行成功', async () => {
  await withApp({ env: {} }, async (base) => {
    const status = await (await fetch(base + '/api/v1/acquisition/status')).json();
    assert.equal(status.provider, 'native');
    assert.equal(status.configured, false);
    assert.ok(status.missing.includes('FEISHU_APP_SECRET'));
    assert.equal((await post(base)).status, 503);
  });
});
test('相同幂等编号仅执行一次，传递真实筛选且不泄露凭证', async () => {
  let calls = 0;
  await withApp(
    {
      env: configured,
      nativeImpl: {
        async run(body) {
          calls++;
          assert.equal(body.product, input.product);
          assert.equal('city' in body, false);
          return { outcome: 'completed', 新增: 1, reason: '本地已保存' };
        },
        close() {},
      },
    },
    async (base) => {
      const first = await (await post(base, { ...input, city: 'Miami' })).json();
      const second = await (await post(base, { ...input, city: 'Miami' })).json();
      assert.equal(first.status, 'completed');
      assert.deepEqual(first, second);
      assert.equal(calls, 1);
      assert.equal((await post(base, { ...input, region: 'California' })).status, 409);
      const status = await (await fetch(base + '/api/v1/acquisition/status')).text();
      assert.ok(!status.includes(configured.FEISHU_APP_SECRET));
    },
  );
});
test('执行结果不明时按原编号核对，禁止自动重放研究', async () => {
  let calls = 0;
  await withApp(
    {
      env: configured,
      nativeImpl: {
        async run() {
          calls++;
          throw new Error('network');
        },
        async status() {
          return { settled: false };
        },
        close() {},
      },
    },
    async (base) => {
      assert.equal((await post(base)).status, 504);
      assert.equal((await post(base)).status, 409);
      assert.equal(calls, 1);
    },
  );
});
test('空结果不报成功，保留幂等保护', async () => {
  for (const output of [[], {}, null]) {
    let calls = 0;
    await withApp(
      {
        env: configured,
        nativeImpl: {
          async run() {
            calls++;
            return output;
          },
          async status() {
            return { settled: false };
          },
          close() {},
        },
      },
      async (base) => {
        const response = await post(base);
        assert.equal(response.status, 502);
        assert.match((await response.json()).error, /返回空结果/);
        assert.equal((await post(base)).status, 409);
        assert.equal(calls, 1);
      },
    );
  }
});
test('业务失败、无新客户和实际收录在摘要中分别报告', async () => {
  for (const outcome of ['failed', 'no_new_candidates', 'completed']) {
    const output = {
      outcome,
      reason: '业务结果',
      新增: outcome === 'completed' ? 1 : 0,
      execution_id: 'fixture-125',
    };
    await withApp(
      {
        env: configured,
        nativeImpl: {
          async run() {
            return output;
          },
          close() {},
        },
      },
      async (base) => {
        const result = await (await post(base)).json();
        assert.equal(result.summary.outcome, outcome);
        assert.equal(result.summary.inserted, output.新增);
        assert.equal(result.summary.executionId, 'fixture-125');
      },
    );
  }
});
test('拒绝跨站、无效JSON、非JSON类型及超量请求', async () => {
  await withApp({ env: configured }, async (base) => {
    assert.equal(
      (await post(base, input, 'cross-site', { Origin: 'https://untrusted.example' })).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + '/api/v1/acquisition/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + '/api/v1/acquisition/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: 'x',
        })
      ).status,
      415,
    );
    assert.equal((await post(base, { ...input, search_query: 'x'.repeat(40000) })).status, 413);
  });
});
test('执行历史来自本地操作库', async () => {
  const entries = [{ id: 'local-op', status: 'completed', startedAt: '2026-10-30' }];
  await withApp(
    { env: configured, nativeImpl: { store: { history: () => entries }, close() {} } },
    async (base) => {
      assert.deepEqual(
        (await (await fetch(base + '/api/v1/acquisition/executions')).json()).data,
        entries,
      );
    },
  );
});
