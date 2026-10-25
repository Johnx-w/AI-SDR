import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';

test('总览HTTP只读聚合真实客户与本地业务，不调用搜索、邮件或飞书写入', async () => {
  const calls = [];
  const env = {
    ACQUISITION_PROVIDER: 'n8n',
    N8N_BASE_URL: 'https://example.test',
    FEISHU_READ_WEBHOOK_URL: 'https://example.test/webhook/read',
    N8N_WEBHOOK_SECRET: 'fixture-secret',
  };
  const app = createApp({
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options?.method || 'GET' });
      assert.equal(String(url), env.FEISHU_READ_WEBHOOK_URL);
      return Response.json({
        code: 0,
        data: {
          items: [{ record_id: 'real-one', fields: { 公司名称: '真实企业', 开发状态: '待开发' } }],
          has_more: false,
        },
      });
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${app.address().port}`;
  try {
    const response = await fetch(
      root + '/api/v1/overview?period=7d&asOf=2026-10-25T02%3A00%3A00.000Z',
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    assert.equal(result.metrics.companies, 1);
    assert.equal(result.metrics.activeDemands, 0);
    assert.equal(result.metrics.dueTasks, 0);
    assert.equal(result.metrics.newCompanies, 0);
    assert.equal(result.asOf, '2026-10-25T02:00:00.000Z');
    assert.equal(result.sources.business.state, 'ready');
    assert.equal(result.coverage.recordedOnly, true);
    assert.equal(calls.length, 1);
    assert.equal((await fetch(root + '/api/v1/overview', { method: 'POST' })).status, 405);
    assert.equal((await fetch(root + '/api/v1/overview?period=all')).status, 400);
    assert.equal((await fetch(root + '/api/v1/overview?asOf=bad-time')).status, 400);
    assert.equal(
      (await fetch(root + '/api/v1/overview', { headers: { origin: 'https://foreign.example' } }))
        .status,
      403,
    );
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});

test('客户入口未接通时总览其它本地来源仍可读，客户数不伪装成零', async () => {
  const app = createApp({
    env: {},
    fetchImpl: async () => {
      throw new Error('不应请求外部服务');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.address().port}/api/v1/overview`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.metrics.companies, null);
    assert.equal(result.sources.customers.state, 'unavailable');
    assert.equal(result.metrics.activeDemands, 0);
    assert.equal(result.products.draft, 0);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
