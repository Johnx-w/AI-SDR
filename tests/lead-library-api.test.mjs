import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';

const env = {
  N8N_BASE_URL: 'https://workspace.example.org',
  FEISHU_READ_WEBHOOK_URL: 'https://workspace.example.org/webhook/read-customers',
  N8N_WEBHOOK_SECRET: 'private-fixture-secret',
};
const record = (id = 'rec_one', name = '客户一') => ({
  record_id: id,
  fields: {
    公司名称: name,
    企业官网: 'https://buyer.example.org/',
    国家: 'United States',
    初评结果: 'B',
    企业经营产品: 'roller blinds',
    邮箱: 'buyer@example.org',
    画像JSON: JSON.stringify({
      facts: [{ field: 'products', value: 'blinds', quote: 'x'.repeat(5000) }],
    }),
  },
});
const response = (records) => Response.json({ code: 0, data: { items: records, has_more: false } });
async function open(options) {
  const app = createApp(options);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  return {
    app,
    base: `http://127.0.0.1:${app.address().port}/api/v1/leads/real`,
    close: () => new Promise((resolve) => app.close(resolve)),
  };
}

test('客户摘要与详情独立，连续列表、详情和导出读取复用同一飞书快照', async () => {
  let reads = 0;
  const server = await open({
    env,
    fetchImpl: async () => {
      reads++;
      return response([record()]);
    },
  });
  try {
    const list = await (await fetch(server.base + '/list')).json();
    assert.equal(list.leads[0].name, '客户一');
    for (const field of ['facts', 'fields', 'assessment', 'customsEvidence'])
      assert.equal(field in list.leads[0], false);
    assert.equal(list.total, 1);
    assert.ok(list.syncedAt);
    assert.ok(list.scope);
    const detail = await (await fetch(server.base + '/rec_one')).json();
    assert.equal(detail.lead.facts[0].quote.length, 5000);
    const full = await (await fetch(server.base)).json();
    assert.deepEqual(full.leads[0], detail.lead);
    await fetch(server.base + '/list');
    assert.equal(reads, 1);
    assert.ok(JSON.stringify(list).length < JSON.stringify(full).length / 4);
    assert.equal((await fetch(server.base + '/missing')).status, 404);
  } finally {
    await server.close();
  }
});

test('飞书刷新期间仍立即提供已有列表，刷新成功后显示新增及删除结果', async () => {
  let finish;
  let started;
  const refreshing = new Promise((resolve) => (started = resolve));
  let reads = 0;
  const server = await open({
    env,
    fetchImpl: async () => {
      if (++reads === 1) return response([record()]);
      started();
      return new Promise(
        (resolve) => (finish = () => resolve(response([record('rec_two', '客户二')]))),
      );
    },
  });
  let request;
  try {
    await fetch(server.base + '/list');
    request = fetch(server.base + '/refresh', { method: 'POST' });
    await refreshing;
    const cached = await (await fetch(server.base + '/list')).json();
    assert.equal(cached.leads[0].id, 'rec_one');
    assert.equal(cached.sync.refreshing, true);
    finish();
    const updated = await (await request).json();
    assert.equal(updated.leads[0].id, 'rec_two');
    assert.equal(updated.sync.refreshing, false);
    assert.equal((await fetch(server.base + '/rec_one')).status, 404);
    assert.equal(reads, 2);
  } finally {
    finish?.();
    await request;
    await server.close();
  }
});

test('刷新失败不删除客户，错误不泄露凭证，跨站刷新被拒绝', async () => {
  let failed = false;
  let reads = 0;
  const server = await open({
    env,
    fetchImpl: async () => {
      reads++;
      if (failed) throw new Error(env.N8N_WEBHOOK_SECRET);
      return response([record()]);
    },
  });
  try {
    await fetch(server.base + '/list');
    failed = true;
    const refresh = await fetch(server.base + '/refresh', { method: 'POST' });
    assert.equal(refresh.status, 502);
    const cached = await (await fetch(server.base + '/list')).json();
    assert.equal(cached.leads[0].id, 'rec_one');
    assert.ok(cached.sync.error);
    assert.equal(JSON.stringify(cached).includes(env.N8N_WEBHOOK_SECRET), false);
    assert.equal(
      (
        await fetch(server.base + '/refresh', {
          method: 'POST',
          headers: { Origin: 'https://untrusted.example.org' },
        })
      ).status,
      403,
    );
    assert.equal(reads, 2);
  } finally {
    await server.close();
  }
});

test('重启从SQLite读取客户，切换客户表不会展示上一张表的数据', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'lead-library-api-'));
  const persistent = { ...env, LEAD_LIBRARY_DB_PATH: join(folder, 'leads.sqlite') };
  let server;
  try {
    server = await open({ env: persistent, fetchImpl: async () => response([record()]) });
    await fetch(server.base + '/list');
    await server.close();
    server = await open({
      env: persistent,
      fetchImpl: async () => {
        throw new Error('upstream offline');
      },
    });
    const cached = await (await fetch(server.base + '/list')).json();
    assert.equal(cached.leads[0].id, 'rec_one');
    assert.equal((await fetch(server.base + '/rec_one')).status, 200);
    await server.close();
    server = await open({
      env: { ...persistent, FEISHU_TABLE_ID: 'another-table' },
      fetchImpl: async () => response([record('rec_two', '另一张表')]),
    });
    const changed = await (await fetch(server.base + '/list')).json();
    assert.equal(changed.leads[0].id, 'rec_two');
    assert.notEqual(changed.scope, cached.scope);
    assert.equal((await fetch(server.base + '/rec_one')).status, 404);
  } finally {
    if (server?.app.listening) await server.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test('精简飞书字段修改联系方式后，SQLite档案仍保留后台完整评估和人工依据', async () => {
  const current = record();
  const facts = [{ field: 'product', value: '卷帘', quote: '后台保存的完整依据' }];
  const assessment = { id: 'ev_current', score: 85, evidenceReason: '主营产品：卷帘' };
  const confirmations = [{ id: 'manual_confirmation', confirmedBy: '业务员' }];
  const server = await open({
    env: {
      ACQUISITION_PROVIDER: 'native',
      FEISHU_APP_ID: 'fixture',
      FEISHU_APP_SECRET: 'fixture',
      FEISHU_APP_TOKEN: 'fixture',
      FEISHU_TABLE_ID: 'fixture',
    },
    nativeImpl: {
      decorateLeads: (data) => ({
        ...data,
        leads: data.leads.map((lead) => ({ ...lead, facts, assessment, confirmations })),
      }),
      updateContacts: async (_id, input) => {
        current.fields.邮箱 = input.contacts.email;
        return { lead: mapFeishuRecord(current), contacts: input.contacts };
      },
      close() {},
    },
    fetchImpl: async (url) =>
      new URL(url).pathname.includes('/auth/')
        ? Response.json({ code: 0, tenant_access_token: 'fixture-token', expire: 3600 })
        : response([current]),
  });
  try {
    await fetch(server.base + '/list');
    const saved = await fetch(server.base + '/rec_one/contacts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contacts: { email: 'updated@example.org' },
        expected: { contact: '', email: 'buyer@example.org', phone: '' },
      }),
    });
    assert.equal(saved.status, 200);
    const updated = await saved.json();
    assert.deepEqual(updated.lead.facts, facts);
    assert.deepEqual(updated.lead.assessment, assessment);
    const detail = await (await fetch(server.base + '/rec_one')).json();
    assert.equal(detail.lead.email, 'updated@example.org');
    assert.deepEqual(detail.lead.confirmations, confirmations);
    assert.deepEqual(detail.lead.assessment, assessment);
    assert.deepEqual(detail.lead.facts, facts);
  } finally {
    await server.close();
  }
});

test('性能与同步指标可独立读取，不触发飞书请求且不包含客户资料', async () => {
  let reads = 0;
  let fail = false;
  const server = await open({
    env,
    fetchImpl: async () => {
      reads++;
      if (fail) throw new Error('private upstream secret');
      return response([record()]);
    },
  });
  try {
    const before = await (await fetch(server.base + '/metrics')).json();
    assert.equal(reads, 0);
    assert.equal(before.performance.list.count, 0);
    assert.equal(before.performance.list.p95Ms, null);
    assert.equal(before.sync.attempts, 0);
    const firstResponse = await fetch(server.base + '/list', {
      headers: { 'X-Lead-Library-Activity': 'active' },
    });
    assert.match(firstResponse.headers.get('server-timing'), /^list;dur=\d+\.\d+/);
    const first = await firstResponse.json();
    assert.equal(first.sync.mode, 'active');
    assert.equal(first.sync.intervalMs, 60000);
    const detail = await (await fetch(server.base + '/rec_one')).json();
    assert.equal(detail.version, first.leads[0].version);
    await fetch(server.base + '/missing');
    await fetch(server.base);
    const unchanged = await (await fetch(server.base + '/refresh', { method: 'POST' })).json();
    assert.equal(unchanged.sync.revision, first.sync.revision);
    assert.equal(unchanged.sync.metrics.last.rowsWritten, 0);
    assert.equal(unchanged.sync.metrics.last.unchanged, 1);
    fail = true;
    assert.equal((await fetch(server.base + '/refresh', { method: 'POST' })).status, 502);
    const metrics = await (await fetch(server.base + '/metrics')).json();
    assert.equal(reads, 3);
    assert.equal(metrics.performance.list.count, 1);
    assert.equal(metrics.performance.detail.count, 2);
    assert.equal(metrics.performance.detail.errors, 1);
    assert.equal(metrics.performance.export.count, 1);
    assert.equal(metrics.performance.refresh.count, 2);
    assert.equal(metrics.performance.refresh.errors, 1);
    assert.equal(metrics.sync.attempts, 3);
    assert.equal(metrics.sync.successes, 2);
    assert.equal(metrics.sync.failures, 1);
    assert.equal(metrics.sync.last.status, 'failed');
    assert.equal(metrics.sync.last.rowsWritten, 0);
    for (const name of ['list', 'detail', 'export', 'refresh']) {
      assert.ok(metrics.performance[name].averageMs >= 0);
      assert.ok(metrics.performance[name].p95Ms >= 0);
      assert.ok(metrics.performance[name].sampleCount > 0);
    }
    assert.doesNotMatch(JSON.stringify(metrics), /客户一|buyer@example|private|quote|画像/);
  } finally {
    await server.close();
  }
});
