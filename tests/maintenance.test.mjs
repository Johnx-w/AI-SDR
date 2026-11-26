import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { withApp } from './helpers/http.mjs';
import { createHash } from 'node:crypto';
import { CustomerArchive } from '../server/customer-archive.mjs';
import { LeadLibrary } from '../server/lead-library.mjs';

test('客户刷新HTTP维护让出并清零在途，两个客户独立保留，解除后恢复且不重复飞书行', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mirror-http-drain-'));
  const marker = join(directory, 'maintenance.json');
  const env = {
    FEISHU_APP_ID: 'fixture-id',
    FEISHU_APP_SECRET: 'fixture-secret',
    FEISHU_APP_TOKEN: 'fixture-base',
    FEISHU_TABLE_ID: 't2',
    LEAD_LIBRARY_DB_PATH: join(directory, 'library.sqlite'),
    RELEASE_MAINTENANCE_PATH: marker,
  };
  const scope = createHash('sha256')
    .update(JSON.stringify(['native', 'fixture-id', 'fixture-base', 't2', '']))
    .digest('hex');
  const library = new LeadLibrary({ path: env.LEAD_LIBRARY_DB_PATH, scope });
  const archive = new CustomerArchive({ library: () => library, remote: {} });
  const ids = [];
  for (const label of ['a', 'b'])
    ids.push(
      (
        await archive.write(
          'insert',
          { 公司名称: label, 企业官网: `https://${label}.example/` },
          undefined,
          label,
        )
      ).record_id,
    );
  await archive.close();
  library.close();
  const rows = [];
  const ok = (data) => Response.json({ code: 0, data });
  const fetchImpl = async (url, options = {}) => {
    const endpoint = new URL(url);
    if (endpoint.pathname.endsWith('/auth/v3/tenant_access_token/internal'))
      return Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 3600 });
    if (endpoint.pathname.endsWith('/fields'))
      return ok({
        items: ['公司名称', '企业官网'].map((field_name) => ({ field_name, type: 1 })),
        has_more: false,
      });
    if (endpoint.pathname.endsWith('/records') && options.method === 'POST') {
      const row = {
        record_id: 'remote-' + (rows.length + 1),
        fields: JSON.parse(options.body).fields,
      };
      rows.push(row);
      if (rows.length === 1) writeFileSync(marker, '{}');
      return ok({ record: row });
    }
    if (endpoint.pathname.endsWith('/records')) return ok({ items: rows, has_more: false });
    const id = endpoint.pathname.split('/records/')[1];
    assert(id, '测试不得访问其他外部服务');
    return ok({ record: rows.find((row) => row.record_id === id) });
  };
  try {
    await withApp(
      { env, fetchImpl, nativeImpl: { decorateLeads: (data) => data, close() {} } },
      async (base) => {
        const refresh = () => fetch(base + '/api/v1/leads/real/refresh', { method: 'POST' });
        assert.equal((await refresh()).status, 503);
        assert.equal(rows.length, 1);
        const status = await (await fetch(base + '/api/v1/ops/maintenance')).json();
        assert.equal(status.quiet, true);
        assert.equal(status.pending.customers, 0);
        rmSync(marker);
        assert.equal((await refresh()).status, 200);
        assert.equal(rows.length, 2);
        for (const [index, id] of ids.entries()) {
          const response = await fetch(base + '/api/v1/leads/real/' + id + '?local=1');
          assert.equal(response.status, 200);
          assert.equal((await response.json()).lead.name, ['a', 'b'][index]);
        }
        assert.equal((await fetch(base + '/api/v1/leads/real/missing?local=1')).status, 404);
        assert.equal((await refresh()).status, 200);
        assert.equal(rows.length, 2);
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
