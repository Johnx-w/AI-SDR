import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.mjs';
import { acquisitionConfig } from '../server/acquisition-config.mjs';
import { ApiConnections } from '../server/api-connections.mjs';
import { summarizeRunOutput } from '../server/run-outcome.mjs';

test('获客返回只接受结构化业务结果，不再解释工作流数组包装', () => {
  const output = { outcome: 'completed', 新增: 1, reason: '已保存' };
  assert.equal(summarizeRunOutput(output).inserted, 1);
  assert.throws(() => summarizeRunOutput([output]), /业务结果格式无效/);
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
