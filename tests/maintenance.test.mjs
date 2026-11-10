import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withApp } from './helpers/http.mjs';

test('维护跨重启有效，业务GET和写操作均503，健康可读且不启动后台服务', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shadeflow-maintenance-'));
  const marker = join(directory, 'maintenance.json');
  writeFileSync(marker, '{}');
  try {
    for (let restart = 0; restart < 2; restart++)
      await withApp(
        {
          env: { RELEASE_MAINTENANCE_PATH: marker, OUTREACH_DB_PATH: ':memory:' },
          outreachServiceFactory: () => assert.fail('维护启动不能创建发信服务'),
        },
        async (base) => {
          assert.equal((await fetch(base + '/api/health')).status, 200);
          for (const [path, method] of [
            ['/api/v1/acquisition/jobs', 'GET'],
            ['/api/v1/connections', 'PUT'],
            ['/api/v1/leads/real/list', 'GET'],
          ]) {
            const response = await fetch(base + path, { method });
            assert.equal(response.status, 503);
            assert.equal(response.headers.get('retry-after'), '30');
          }
          const status = await (await fetch(base + '/api/v1/ops/maintenance')).json();
          assert.equal(status.enabled, true);
          assert.equal(status.quiet, true);
        },
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('维护等待已接收的请求完成，拒绝新请求；解除后恢复业务读取', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shadeflow-drain-'));
  const marker = join(directory, 'maintenance.json');
  try {
    await withApp({ env: { RELEASE_MAINTENANCE_PATH: marker } }, async (base) => {
      const status = async () => (await fetch(base + '/api/v1/ops/maintenance')).json();
      const operation = request(base + '/api/v1/connections', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'maintenance-request' },
      });
      const completed = new Promise((resolve, reject) => {
        operation.on('response', (response) => {
          response.resume();
          response.on('end', resolve);
        });
        operation.on('error', reject);
      });
      operation.write('{');
      for (let attempt = 0; attempt < 100 && !(await status()).pending.requests; attempt++)
        await delay(10);
      writeFileSync(marker, '{}');
      assert.equal((await status()).quiet, false);
      assert.equal((await fetch(base + '/api/v1/connections')).status, 503);
      operation.end('}');
      await completed;
      assert.equal((await status()).quiet, true);
      rmSync(marker);
      assert.equal((await fetch(base + '/api/v1/connections')).status, 200);
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
