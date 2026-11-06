import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.mjs';
import { acquisitionConfig } from '../server/acquisition-config.mjs';
import { ApiConnections } from '../server/api-connections.mjs';

test('删除单次获客与执行历史入口，直接返回404且不调用上游', async () => {
  await withApp({ env: {}, fetchImpl: () => assert.fail('不应调用外部服务') }, async (base) => {
    assert.equal(
      (
        await fetch(base + '/api/v1/acquisition/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
      404,
    );
    assert.equal((await fetch(base + '/api/v1/acquisition/executions')).status, 404);
  });
});

test('退役引擎配置不能启用旧服务，兼容入口全部返回404且没有外部调用', async () => {
  const retired = {
    ACQUISITION_PROVIDER: 'n8n',
    N8N_WEBHOOK_URL: 'https://retired.example/webhook/run',
    N8N_WEBHOOK_SECRET: 'retired-secret',
    N8N_WEBHOOK_ENABLED: 'true',
    FEISHU_READ_WEBHOOK_URL: 'https://retired.example/webhook/read',
  };
  assert.equal(acquisitionConfig(retired).provider, 'native');
  assert.equal(acquisitionConfig(retired).nativeReady, false);
  const settings = new ApiConnections({ env: retired });
  assert.equal(settings.view().provider, 'native');
  assert.ok(settings.view().fields.every(({ key }) => !key.startsWith('N8N_')));
  assert.throws(
    () => settings.update({ values: { N8N_WEBHOOK_URL: 'https://retired.example' } }),
    /格式不正确/,
  );
  await withApp(
    { env: retired, fetchImpl: () => assert.fail('不应调用外部服务') },
    async (base) => {
      for (const suffix of ['', '/status', '/jobs', '/products', '/schedules', '/executions'])
        assert.equal((await fetch(base + '/api/v1/integrations/n8n' + suffix)).status, 404);
      assert.equal(
        (
          await fetch(base + '/api/v1/integrations/n8n/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
        404,
      );
    },
  );
});
