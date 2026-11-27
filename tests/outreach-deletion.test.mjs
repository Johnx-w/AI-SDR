import test from 'node:test';
import assert from 'node:assert/strict';
import { OutreachService } from '../server/outreach-service.mjs';
import { handleOutreach } from '../server/outreach-api.mjs';

test('各状态手动计划删除后隐藏且保留结果、取消追信并支持重复请求', async (t) => {
  const s = new OutreachService({ mailboxes: { list: () => [] } });
  t.after(() => s.close());
  const api = (path, method = 'GET', body = {}) =>
    handleOutreach({
      request: { method },
      url: new URL('http://local/api/v1/outreach' + path),
      service: s,
      readJson: async () => body,
    });
  for (const status of [
    'draft',
    'preparing',
    'ready',
    'active',
    'paused',
    'completed',
    'cancelled',
  ]) {
    s.putCampaign({
      id: status,
      name: 'Manual ' + status,
      mode: 'production',
      status,
      revision: 3,
      followUpEnabled: true,
    });
    s.putDelivery({ id: 'pending-' + status, campaignId: status, status: 'queued' });
    s.putDelivery({
      id: 'sent-' + status,
      campaignId: status,
      status: 'accepted',
      subject: 'Original',
    });
    s.followUps.put({ id: 'follow-' + status, campaignId: status, status: 'pending' });
    assert.deepEqual(await api('/campaigns/' + status + '/deletion-preview'), {
      pendingFirst: 1,
      pendingFollowUps: 1,
      unknown: 0,
    });
    const deleted = await api('/campaigns/' + status + '/delete', 'POST', {
      revision: 3,
      confirmed: true,
    });
    assert.ok(deleted.campaign.deletedAt);
    assert.ok(deleted.campaign.deleteRequestedAt);
    assert.equal(deleted.deliveries[0].status, 'cancelled');
    assert.equal(deleted.deliveries[1].status, 'accepted');
    assert.equal(s.followUps.get('follow-' + status).status, 'cancelled');
    assert.deepEqual(
      await api('/campaigns/' + status + '/delete', 'POST', { revision: 3, confirmed: true }),
      deleted,
    );
  }
  assert.equal((await api('/state?view=current')).filtered, 0);
  assert.equal((await api('/state?view=history')).filtered, 0);
  assert.equal((await api('/state?view=deleted')).filtered, 7);
});

test('删除跨重启幂等，旧检查点不能覆盖删除，其他计划保持各自授权', async (t) => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = mkdtempSync(join(tmpdir(), 'outreach-delete-'));
  const options = { path: join(folder, 'mail.sqlite'), mailboxes: { list: () => [] } };
  let s = new OutreachService(options);
  const old = {
    id: 'one',
    name: 'One',
    mode: 'production',
    status: 'active',
    revision: 4,
    followUpEnabled: true,
  };
  s.putCampaign(old);
  s.putCampaign({ ...old, id: 'two', name: 'Two' });
  s.putCampaign({ ...old, id: 'empty', name: 'Empty', status: 'draft' });
  s.deleteCampaign('one', 4, true);
  s.putCampaign({ ...old, revision: 99 });
  const original = s.detail('one');
  await s.close();
  s = new OutreachService(options);
  t.after(async () => {
    await s.close();
    rmSync(folder, { recursive: true, force: true });
  });
  assert.deepEqual(s.deleteCampaign('one', 4, true), original);
  assert.equal(s.campaign('one').revision, 5);
  assert.equal(s.campaign('one').followUpEnabled, false);
  assert.equal(s.campaign('two').followUpEnabled, true);
  assert.equal(s.campaign('empty').status, 'draft');
  assert.deepEqual(
    (await s.state(new URLSearchParams('view=current'))).campaigns.map((c) => c.id),
    ['empty', 'two'],
  );
  assert.throws(() => s.activate('one', 5), { status: 409 });
  assert.throws(() => s.followUps.control('one', 'enable'), { status: 409 });
});

test('41计划1203大字段记录中已删除跨页搜索计数无漏项，读取不调用外部', async (t) => {
  const s = new OutreachService({
    mailboxes: { list: () => [] },
    acquisitionSources: () => assert.fail('外部读取'),
    loadLeads: () => assert.fail('外部读取'),
  });
  t.after(() => s.close());
  for (let i = 0; i < 41; i++)
    s.putCampaign({
      id: `p-${i}`,
      name: i < 25 ? `Deleted buyer ${i}` : `Other ${i}`,
      mode: 'production',
      status: i % 2 ? 'active' : 'completed',
      revision: 1,
    });
  for (let i = 0; i < 1203; i++)
    s.putDelivery({
      id: `d-${i}`,
      campaignId: `p-${i % 41}`,
      status: i % 3 ? 'accepted' : 'unknown',
      candidate: { evidence: 'x'.repeat(10000) },
      bodyHtml: 'y'.repeat(20000),
    });
  for (let i = 0; i < 25; i++) s.deleteCampaign(`p-${i}`, 1, true);
  const read = async (view, page = 1) =>
    s.state(new URLSearchParams({ view, page: String(page), pageSize: '20', q: 'buyer' }));
  const first = await read('deleted'),
    second = await read('deleted', 2);
  assert.equal(first.filtered, 25);
  assert.equal(second.filtered, 25);
  assert.deepEqual(
    [...first.campaigns, ...second.campaigns].map((c) => c.id),
    Array.from({ length: 25 }, (_, i) => `p-${24 - i}`),
  );
  assert.equal((await read('current')).filtered, 0);
  assert.equal((await read('history')).filtered, 0);
  assert.ok(JSON.stringify(first).length < 30000);
  const times = [];
  for (let i = 0; i < 11; i++) {
    const start = performance.now();
    await read('deleted', 2);
    times.push(performance.now() - start);
  }
  console.log(
    'T4性能',
    JSON.stringify({
      plans: 41,
      deliveries: 1203,
      deleted: 25,
      coldMs: times[0],
      hotMedianMs: times.slice(1).sort((a, b) => a - b)[5],
      maxMs: Math.max(...times),
      bytes: Buffer.byteLength(JSON.stringify(first)),
      queryPlan: s.db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT state,count(*) FROM outreach_deliveries INDEXED BY outreach_counts WHERE campaign_id=? GROUP BY state',
        )
        .all('p-1'),
    }),
  );
});
