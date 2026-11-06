import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { OutreachService } from '../server/outreach-service.mjs';

test('计划摘要省略批量HTML和候选快照，单封读取保留原文且不修改数据', async (t) => {
  const service = new OutreachService({ mailboxes: { list: () => [] } });
  const campaign = service.saveCampaign({ name: 'Large historical plan', mailboxIds: [] });
  service.putCampaign({ ...campaign, status: 'completed' });
  for (let i = 0; i < 3; i++)
    service.putDelivery({
      id: `delivery-${i}`,
      campaignId: campaign.id,
      status: 'accepted',
      subject: `Mail ${i}`,
      bodyText: `Original ${i}`,
      bodyHtml: `<p>Original ${i}</p><img src="data:image/png;base64,${'A'.repeat(200_000)}">`,
      candidate: { evidence: 'Full research snapshot' },
    });
  const original = service.detail(campaign.id);
  const server = createApp({ env: {}, outreachServiceFactory: () => service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/outreach`;
  assert.equal(campaign.generationMode, undefined);
  assert.equal(campaign.outreachClaims, undefined);
  assert.equal((await service.state()).review, undefined);
  for (const path of [
    `/campaigns/${campaign.id}/prepare`,
    `/campaigns/${campaign.id}/approve`,
    '/review',
  ]) {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: campaign.revision, approved: true }),
    });
    assert.equal(response.status, 404);
  }
  const response = await fetch(`${base}/campaigns/${campaign.id}?summary=1`);
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.ok(Buffer.byteLength(raw) < 10_000, 'summary must not transfer repeated logos');
  const summary = JSON.parse(raw);
  assert.deepEqual(summary.campaign, original.campaign);
  assert.equal(summary.deliveries.length, 3);
  assert.equal(summary.deliveries[0].bodyText, 'Original 0');
  assert.equal(summary.deliveries[0].bodyHtml, undefined);
  assert.equal(summary.deliveries[0].candidate, undefined);
  const full = await (await fetch(`${base}/deliveries/delivery-1`)).json();
  const { candidate, ...expected } = original.deliveries[1];
  assert.deepEqual(full, expected);
  assert.equal((await fetch(`${base}/deliveries/missing`)).status, 404);
  assert.equal(
    (
      await fetch(`${base}/deliveries/delivery-1`, {
        headers: { Origin: 'https://unrelated.example' },
      })
    ).status,
    403,
  );
  assert.deepEqual(await (await fetch(`${base}/campaigns/${campaign.id}`)).json(), original);
  assert.deepEqual(service.detail(campaign.id), original);
});

test('mailbox signature uploads accept a logo above 32 KB while enforcing the mailbox request limit', async (t) => {
  const saved = [];
  const server = createApp({
    env: {},
    outreachServiceFactory: () => ({
      mailboxes: {
        save: (input) => {
          saved.push(input);
          return { id: 'sales' };
        },
      },
      close: async () => {},
    }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/outreach/mailboxes`;
  const body = { signatureDesign: { logo: { contentBase64: 'A'.repeat(100_000) } } };
  for (const [path, method] of [
    ['', 'POST'],
    ['/sales', 'PUT'],
  ]) {
    const response = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
  }
  assert.equal(saved.length, 2);
  assert.equal(
    (
      await fetch(base + '/sales', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signature: 'A'.repeat(512 * 1024) }),
      })
    ).status,
    413,
  );
  assert.equal(saved.length, 2);
});

test('多邮箱接口可直接访问并限制本机来源，内部测试需要确认及幂等编号', async () => {
  const calls = [];
  const service = {
    state: async () => ({ mailboxes: [], campaigns: [] }),
    internalTest: (body) => {
      calls.push(body);
      return { campaign: { id: 'test' } };
    },
    close: async () => {},
  };
  const server = createApp({
    env: {},
    outreachServiceFactory: () => service,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base + '/api/v1/outreach/state')).status, 200);
    assert.equal(
      (
        await fetch(base + '/api/v1/outreach/state', {
          headers: { Origin: 'https://unrelated.example' },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + '/api/v1/outreach/state', {
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        })
      ).status,
      403,
    );
    const headers = { 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/api/v1/outreach/state', { headers })).status, 200);
    assert.equal(
      (
        await fetch(base + '/api/v1/outreach/internal-test', {
          method: 'POST',
          headers,
          body: JSON.stringify({ confirmed: true }),
        })
      ).status,
      400,
    );
    assert.equal(calls.length, 0);
    const res = await fetch(base + '/api/v1/outreach/internal-test', {
      method: 'POST',
      headers: { ...headers, 'Idempotency-Key': 'internal-test-123' },
      body: JSON.stringify({
        confirmed: true,
        expectedMailboxIds: ['a', 'b'],
        expectedMailboxEmails: ['a@example.org', 'b@example.org'],
      }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(calls, [
      {
        confirmed: true,
        expectedMailboxIds: ['a', 'b'],
        expectedMailboxEmails: ['a@example.org', 'b@example.org'],
        idempotencyKey: 'internal-test-123',
      },
    ]);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('取消触达接口核对确认和版本并可重复请求，保留详情且不能再次启动或编辑', async (t) => {
  const service = new OutreachService({ mailboxes: { list: () => [], get: () => undefined } });
  const campaign = service.saveCampaign({ name: 'API cancellation', mailboxIds: [] });
  const completed = service.saveCampaign({ name: 'Completed', mailboxIds: [] });
  service.putCampaign({ ...completed, status: 'completed' });
  const server = createApp({
    env: {},
    outreachServiceFactory: () => service,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/outreach/campaigns/`;
  const request = (id, action, body, method = 'POST') =>
    fetch(base + id + action, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  assert.equal(
    (await request(campaign.id, '/cancel', { revision: campaign.revision })).status,
    400,
  );
  assert.equal(
    (await request(campaign.id, '/cancel', { revision: 99, confirmed: true })).status,
    409,
  );
  assert.equal((await request('missing', '/cancel', { revision: 1, confirmed: true })).status, 404);
  assert.equal(
    (await request(completed.id, '/cancel', { revision: completed.revision, confirmed: true }))
      .status,
    409,
  );
  const body = { revision: campaign.revision, confirmed: true };
  const response = await request(campaign.id, '/cancel', body);
  assert.equal(response.status, 200);
  const cancelled = await response.json();
  assert.equal(cancelled.campaign.status, 'cancelled');
  assert.deepEqual(await (await request(campaign.id, '/cancel', body)).json(), cancelled);
  assert.deepEqual(await (await fetch(base + campaign.id)).json(), cancelled);
  for (const action of ['/start', '/pause'])
    assert.equal(
      (await request(campaign.id, action, { revision: cancelled.campaign.revision })).status,
      409,
    );
  assert.equal(
    (
      await request(
        campaign.id,
        '',
        { name: 'Revive', revision: cancelled.campaign.revision },
        'PUT',
      )
    ).status,
    409,
  );
});
