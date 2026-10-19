import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, validateInput } from '../server/app.mjs';

const input = {
  country: 'United States',
  region: 'Florida',
  city: 'Miami',
  product: 'outdoor zip screens',
  customer_types: ['installer', 'distributor'],
  search_query: 'outdoor zip screens Miami Florida USA',
};
const configured = {
  N8N_BASE_URL: 'https://vynox.app.n8n.cloud',
  N8N_WEBHOOK_URL: 'https://vynox.app.n8n.cloud/webhook/test-only',
  N8N_WEBHOOK_SECRET: 'test-only-secret',
  N8N_WEBHOOK_ENABLED: 'true',
};
async function withApp(options, callback) {
  const app = createApp(options);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${app.address().port}`);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}
const post = (base, body = input, key = 'test-request-001', extra = {}) =>
  fetch(`${base}/api/v1/integrations/n8n/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...extra },
    body: JSON.stringify(body),
  });
test('入口参数限制市场、字段与客户类型', () => {
  assert.deepEqual(validateInput(input), input);
  assert.throws(() => validateInput({ ...input, country: 'invalid' }), /支持美国与澳大利亚/);
  assert.equal(validateInput({ ...input, city: '' }).city, '');
  assert.equal(validateInput({ ...input, region: '', city: '' }).region, '');
  assert.throws(() => validateInput({ ...input, region: '' }), /先选择州/);
  assert.throws(() => validateInput({ ...input, region: 'New South Wales' }), /该国家/);
  assert.throws(() => validateInput({ ...input, customer_types: ['unknown'] }), /客户类型/);
});
test('无配置不伪造连接状态或运行成功，不向浏览器泄露凭证', async () => {
  await withApp({ env: {} }, async (base) => {
    const status = await (await fetch(`${base}/api/v1/integrations/n8n/status`)).json();
    assert.equal(status.configured, false);
    assert.equal((await post(base)).status, 503);
    assert.equal((await fetch(`${base}/api/v1/integrations/n8n/executions`)).status, 503);
    assert.equal(JSON.stringify(status).includes('SECRET'), false);
  });
});
test('只允许指定实例的 HTTPS 生产 Webhook', async () => {
  for (const url of [
    'https://other.example/webhook/x',
    'http://vynox.app.n8n.cloud/webhook/x',
    'https://vynox.app.n8n.cloud/webhook-test/x',
    'https://vynox.app.n8n.cloud/workflow/id',
  ]) {
    await withApp({ env: { ...configured, N8N_WEBHOOK_URL: url } }, async (base) => {
      const status = await (await fetch(`${base}/api/v1/integrations/n8n/status`)).json();
      assert.equal(status.configured, false);
    });
  }
});
test('转发真实字段与认证头，相同幂等键仅调用一次', async () => {
  let count = 0;
  await withApp(
    {
      env: configured,
      fetchImpl: async (url, options) => {
        count++;
        assert.equal(url, configured.N8N_WEBHOOK_URL);
        assert.equal(options.headers['X-Shadeflow-Key'], configured.N8N_WEBHOOK_SECRET);
        assert.equal(JSON.parse(options.body).city, 'Miami');
        assert.equal(options.redirect, 'error');
        return Response.json({ leads: [{ name: 'fixture' }], written: 1 });
      },
    },
    async (base) => {
      const first = await (await post(base)).json();
      const second = await (await post(base)).json();
      assert.equal(first.status, 'completed');
      assert.deepEqual(first, second);
      assert.equal(count, 1);
      assert.equal((await post(base, { ...input, city: 'Orlando' })).status, 409);
      const status = await (await fetch(`${base}/api/v1/integrations/n8n/status`)).text();
      assert.equal(status.includes('test-only-secret'), false);
    },
  );
});
test('超时或网络错误不会自动重试，也不会重复相同任务', async () => {
  let count = 0;
  await withApp(
    {
      env: configured,
      fetchImpl: async () => {
        count++;
        throw new Error('network');
      },
    },
    async (base) => {
      assert.equal((await post(base)).status, 504);
      assert.equal((await post(base)).status, 409);
      assert.equal(count, 1);
    },
  );
});
test('只有启动确认时不误报任务已完成', async () => {
  await withApp(
    { env: configured, fetchImpl: async () => Response.json({ message: 'Workflow was started' }) },
    async (base) => {
      assert.equal((await post(base)).status, 502);
    },
  );
});
test('空响应不报成功，保留幂等保护防止重复提交', async () => {
  for (const output of [[], {}, null]) {
    let count = 0;
    await withApp(
      {
        env: configured,
        fetchImpl: async () => {
          count++;
          return Response.json(output);
        },
      },
      async (base) => {
        const response = await post(base);
        assert.equal(response.status, 502);
        assert.match((await response.json()).error, /返回空结果/);
        assert.equal((await post(base)).status, 409);
        assert.equal(count, 1);
      },
    );
  }
});
test('业务抓取失败、没有新客户、真实写入在页面摘要中明确区分', async () => {
  for (const outcome of ['failed', 'no_new_candidates', 'completed']) {
    const output = {
      outcome,
      reason: outcome === 'completed' ? '飞书已新增1条' : '没有写入',
      新增: outcome === 'completed' ? 1 : 0,
      更新: 0,
      失败: 0,
      待人工查重: 0,
      execution_id: 'fixture-125',
    };
    await withApp(
      { env: configured, fetchImpl: async () => Response.json([output]) },
      async (base) => {
        const response = await (await post(base)).json();
        assert.equal(response.summary.outcome, outcome);
        assert.equal(response.summary.message, output.reason);
        assert.equal(response.summary.inserted, output['新增']);
        assert.equal(response.summary.executionId, 'fixture-125');
      },
    );
  }
});
test('拒绝跨站调用、无效 JSON 和超量请求', async () => {
  await withApp({ env: configured }, async (base) => {
    assert.equal(
      (await post(base, input, 'test-cross-site', { Origin: 'https://untrusted.example' })).status,
      403,
    );
    assert.equal(
      (
        await fetch(`${base}/api/v1/integrations/n8n/runs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
      400,
    );
    assert.equal((await post(base, { ...input, search_query: 'x'.repeat(9000) })).status, 413);
  });
});
test('执行记录仅返回允许的字段，密钥仅传给 n8n', async () => {
  await withApp(
    {
      env: { ...configured, N8N_API_KEY: 'private-key' },
      fetchImpl: async (url, options) => {
        assert.equal(options.headers['X-N8N-API-KEY'], 'private-key');
        assert.match(url, /includeData=false/);
        return Response.json({
          data: [
            {
              id: '1',
              status: 'success',
              startedAt: '2026-10-19',
              stoppedAt: null,
              data: { secret: 'not-for-client' },
            },
          ],
        });
      },
    },
    async (base) => {
      const payload = await (await fetch(`${base}/api/v1/integrations/n8n/executions`)).json();
      assert.equal(payload.data[0].data, undefined);
      assert.equal(payload.data[0].id, '1');
    },
  );
});
