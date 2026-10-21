import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAcquisitionProvider } from '../server/acquisition-provider.mjs';
import { createApp } from '../server/app.mjs';

const n8nEnv = {
  N8N_BASE_URL: 'https://workflow.example.org',
  N8N_WORKFLOW_ID: 'custom-workflow',
  N8N_WEBHOOK_URL: 'https://workflow.example.org/webhook/acquisition',
  N8N_WEBHOOK_SECRET: 'private-webhook-key',
  N8N_WEBHOOK_ENABLED: 'true',
};
const input = {
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
  search_query: 'outdoor zip screens Florida United States',
};

test('n8n 研究响应丢失后只查询操作状态，不重放研究或泄露凭证', async () => {
  const calls = [];
  const output = { outcome: 'completed', 新增: 1 };
  const provider = createAcquisitionProvider({
    env: n8nEnv,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      assert.equal(url, n8nEnv.N8N_WEBHOOK_URL);
      assert.equal(options.headers['X-Shadeflow-Key'], n8nEnv.N8N_WEBHOOK_SECRET);
      assert.equal(options.redirect, 'error');
      if (body.batch_mode === 'research') throw new Error('response lost');
      assert.deepEqual(body, { batch_mode: 'status', operation_id: 'research-operation' });
      return Response.json([{ settled: true, output }]);
    },
  });
  assert.deepEqual(await provider.research(input, { operation_id: 'research-operation' }), output);
  assert.equal(calls.length, 2);
  assert.equal(provider.info.provider, 'n8n');
  assert.equal(provider.info.editorUrl, 'https://workflow.example.org/workflow/custom-workflow');
  assert.ok(!JSON.stringify(provider.info).includes(n8nEnv.N8N_WEBHOOK_SECRET));
  // Legacy single runs cannot use the batch operation-status protocol.
  assert.deepEqual(await provider.recoverRun('single-run'), { settled: false });
  assert.equal(calls.length, 2);
});

test('统一与兼容入口共享 native 幂等结果；结果不明时仅核对，禁止重复运行', async () => {
  let runCalls = 0,
    statusCalls = 0,
    closed = 0;
  const output = { outcome: 'completed', 新增: 1, reason: '已读回核验' };
  const app = createApp({
    env: {
      ACQUISITION_PROVIDER: 'native',
      TAVILY_API_KEY: 'test',
      DEEPSEEK_API_KEY: 'test',
      FEISHU_APP_ID: 'test',
      FEISHU_APP_SECRET: 'test',
      FEISHU_APP_TOKEN: 'test',
      FEISHU_TABLE_ID: 'test',
    },
    fetchImpl: async () => {
      throw new Error('Unexpected external request');
    },
    nativeImpl: {
      async run() {
        runCalls++;
        throw Object.assign(new Error('写入结果待核对'), { status: 409 });
      },
      async status(id) {
        statusCalls++;
        assert.equal(id, 'native-recovery-01');
        return { settled: true, output };
      },
      close() {
        closed++;
      },
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (prefix) =>
    fetch(base + prefix + '/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'native-recovery-01',
      },
      body: JSON.stringify(input),
    });
  try {
    assert.equal((await post('/api/v1/acquisition')).status, 409);
    const recovered = await post('/api/v1/integrations/n8n');
    assert.equal(recovered.status, 200);
    const result = await recovered.json();
    assert.equal(result.summary.inserted, 1);
    assert.deepEqual(result.result, output);
    assert.deepEqual(await (await post('/api/v1/acquisition')).json(), result);
    assert.equal(runCalls, 1);
    assert.equal(statusCalls, 1);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
  assert.equal(closed, 1);
});

test('n8n 发现候选保留国家和排除域名预算；启动确认数组也不能当成完成', async () => {
  const seen = Array.from({ length: 170 }, (_, i) => `company${i}.example.org`);
  const provider = createAcquisitionProvider({
    env: n8nEnv,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.batch_mode === 'discover') {
        assert.equal(body.search_country, 'United States');
        assert.equal(body.search_query, 'targeted query');
        assert.deepEqual(body.exclude_domains, seen.slice(-150));
        return Response.json([{ candidates: [] }]);
      }
      return Response.json([{ message: 'Workflow was started' }]);
    },
  });
  assert.deepEqual(
    await provider.discover(input, { country: 'United States', query: 'targeted query' }, seen),
    { candidates: [] },
  );
  await assert.rejects(provider.run(input, 'test-request-001'), {
    status: 502,
    message: /仅返回了启动确认/,
  });
});
