import test from 'node:test';
import assert from 'node:assert/strict';
import { customerMirrorFields } from '../server/customer-mirror.mjs';
import { isDevelopmentCustomer } from '../server/customer-eligibility.mjs';
import { CustomerBusinessApi } from '../server/customer-business-api.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('镜像只以实际正常收发推进状态及时间，排除自动回复和未知结果', () => {
  const message = {
    customerId: 'one',
    actualConfirmed: true,
    classification: 'normal',
    occurredAt: '2026-11-01T08:00:00Z',
  };
  const workspace = {
    demands: [],
    customerContexts: [],
    messages: [
      { ...message, direction: 'outbound', deliveryStatus: 'accepted' },
      {
        ...message,
        direction: 'inbound',
        deliveryStatus: 'received',
        occurredAt: '2026-11-02T08:00:00Z',
      },
      {
        ...message,
        direction: 'inbound',
        deliveryStatus: 'received',
        classification: 'auto_reply',
        occurredAt: '2026-11-03T08:00:00Z',
      },
      {
        ...message,
        direction: 'outbound',
        deliveryStatus: 'unknown',
        occurredAt: '2026-11-04T08:00:00Z',
      },
    ],
  };
  const [one, two] = customerMirrorFields(
    [
      { id: 'one', grade: 'A', status: '待开发' },
      { id: 'two', grade: 'C', status: '待开发' },
    ],
    workspace,
  );
  assert.equal(one.fields.开发状态, '已回复');
  assert.equal(one.fields.最近联系时间, Date.parse(message.occurredAt));
  assert.equal(one.fields.最近回复时间, Date.parse('2026-11-02T08:00:00Z'));
  assert.equal(two.fields.开发状态, '待开发');
  assert.equal(two.fields.最近联系时间, null);
});

test('所有供货方向均明确不匹配才移出日常视图，市场不符或证据缺失不误判', () => {
  const no = { dimensions: { P: { score: 0 }, R: { score: 30 } } };
  const yes = { dimensions: { P: { score: 40 }, R: { score: 30 } } };
  for (const [opportunities, expected] of [
    [[no], false],
    [[no, yes], true],
    [[{ status: 'rejected', dimensions: {} }], true],
    [[], true],
  ]) {
    const lead = { id: 'one', grade: 'C', assessment: { opportunities } };
    assert.equal(isDevelopmentCustomer(lead), expected);
    assert.equal(customerMirrorFields([lead], {})[0].fields.初评结果, expected ? 'C' : null);
  }
});

test('一分钟后台同步、失败持久化、重启重试和未变化时不重复写镜像', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mirror-worker-'));
  const env = {
    BATCH_DB_PATH: join(root, 'business.sqlite'),
    FEISHU_APP_TOKEN: 'base',
    FEISHU_TABLE_ID: 't2',
  };
  let writes = 0,
    fail = true;
  const create = () => {
    const api = new CustomerBusinessApi({
      getEnv: () => env,
      knowledge: () => ({ list: () => [] }),
      loadCustomers: async () => [],
    });
    api.state().mirror = {
      sync: async () => {
        writes++;
        if (fail) throw Error('offline');
        return { status: 'synced' };
      },
    };
    return api;
  };
  let api = create();
  try {
    t.mock.timers.enable({ apis: ['setInterval'] });
    api.start();
    t.mock.timers.tick(59999);
    assert.equal(writes, 0);
    t.mock.timers.tick(1);
    await api.syncTail;
    assert.equal(writes, 1);
    assert.equal(
      api.state().store.db.prepare('SELECT error FROM customer_business_sync').get().error,
      'offline',
    );
    await api.close();
    api = create();
    fail = false;
    assert.equal((await api.synchronize({ force: false })).status, 'synced');
    assert.equal(writes, 2);
    await api.synchronize({ force: false });
    assert.equal(writes, 2);
  } finally {
    await api.close();
    t.mock.timers.reset();
    rmSync(root, { recursive: true, force: true });
  }
});
