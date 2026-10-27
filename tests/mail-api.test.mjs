import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.mjs';

test('退役固定双邮箱接口统一返回404，应用不再读取旧试点配置或启动外部调用', async () => {
  const externalCalls = [];
  const env = new Proxy(
    {
      ACQUISITION_PROVIDER: 'n8n',
      BATCH_DB_PATH: ':memory:',
      SCHEDULE_DB_PATH: ':memory:',
    },
    {
      get(target, property) {
        if (typeof property === 'string' && property.startsWith('MAIL_'))
          throw new Error('Retired mailbox configuration must not be read');
        return Reflect.get(target, property);
      },
    },
  );
  await withApp(
    {
      env,
      fetchImpl: async (...args) => {
        externalCalls.push(args);
        throw new Error('Retired mailbox API must not start external requests');
      },
    },
    async (base) => {
      const retired = [
        ['GET', '/api/v1/mail/status'],
        ['GET', '/api/v1/mail/conversations'],
        ['GET', '/api/v1/mail/conversations/test-01'],
        ['PUT', '/api/v1/mail/conversations/test-01/draft'],
        ['POST', '/api/v1/mail/conversations/test-01/reply'],
        ['POST', '/api/v1/mail/test-send'],
        ['POST', '/api/v1/mail/sync'],
      ];
      for (const [method, path] of retired) {
        const response = await fetch(base + path, {
          method,
          headers: {
            ...(method === 'GET' ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(method === 'GET' ? {} : { body: '{invalid-json' }),
        });
        assert.equal(response.status, 404, method + ' ' + path);
        assert.deepEqual(await response.json(), { error: '接口不存在' });
      }
      assert.equal((await fetch(base + '/api/health')).status, 200);
    },
  );
  assert.deepEqual(externalCalls, []);
});
