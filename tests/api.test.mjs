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
  fetch(base + '/api/v1/acquisition/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers },
    body: JSON.stringify(body),
  });
test('入口限制市场和已接入渠道，结构化客户类型成为新任务筛选', () => {
  assert.deepEqual(validateInput(input), {
    ...input,
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
test('拒绝跨站、无效JSON、非JSON类型及超量请求', async () => {
  await withApp({ env: configured }, async (base) => {
    assert.equal(
      (await post(base, input, 'cross-site', { Origin: 'https://untrusted.example' })).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + '/api/v1/acquisition/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + '/api/v1/acquisition/jobs', {
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
