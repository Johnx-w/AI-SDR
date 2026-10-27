import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { CustomerBusinessApi } from '../server/customer-business-api.mjs';

function fixture() {
  let reads = 0;
  const store = new CustomerBusiness({
    scope: 'app/t2',
    customer: async (id) => {
      reads++;
      return id === 'one' ? { record_id: id, fields: { 开发状态: [{ text: '暂缓开发' }] } } : null;
    },
    now: () => '2026-10-27T02:00:00Z',
  });
  const api = new CustomerBusinessApi({
    getEnv: () => ({}),
    knowledge: () => ({ list: () => [] }),
    loadCustomers: async () => [],
  });
  api.state = () => ({
    store,
    mirror: {
      info: () => {
        throw new Error('开发控制不依赖飞书镜像');
      },
    },
  });
  const call = (method, body, id = 'one') =>
    api.handle(
      { method },
      new URL(`http://localhost/api/v1/business/customers/${id}/development`),
      async () => body,
    );
  return { store, api, call, reads: () => reads };
}

test('开发控制接口验证明确客户，保留源状态，不触发飞书镜像，GET不消除到期状态', async () => {
  const f = fixture();
  try {
    const initial = await f.call('GET');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.sourceStatus, '暂缓开发');
    assert.equal(initial.body.development.version, 0);
    assert.deepEqual(f.store.contexts(), []);
    const paused = await f.call('POST', {
      action: 'pause',
      expectedVersion: 0,
      reason: '我方暂缓',
      reviewDate: '2026-10-27',
    });
    assert.equal(f.reads(), 2, '每次请求仅核验一次真实客户');
    assert.equal(paused.body.sourceStatus, '暂缓开发');
    assert.equal(paused.body.development.paused, true);
    assert.equal(paused.body.development.audit[0].actor, '人工操作');
    const readAgain = await f.call('GET');
    assert.equal(readAgain.body.development.reviewDate, '2026-10-27');
    assert.equal(readAgain.body.development.version, 1);
    const resumed = await f.call('POST', {
      action: 'resume',
      expectedVersion: 1,
      reviewed: true,
      reviewToken: readAgain.body.reviewToken,
      resumeNotes: '先复核现有草稿再确定发送时间',
    });
    assert.equal(resumed.body.development.paused, false);
    assert.equal(resumed.body.sourceStatus, '暂缓开发', '恢复本地控制不清除原飞书限制');
  } finally {
    f.store.close();
  }
});

test('开发控制接口拒绝无效方法、客户、请求体和过期版本，客户查询失败不伪装成不存在', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      () => f.call('DELETE'),
      (error) => error.status === 405,
    );
    await assert.rejects(
      () => f.call('GET', undefined, '%2F'),
      (error) => error.status === 400,
    );
    await assert.rejects(
      () => f.call('GET', undefined, 'absent'),
      (error) => error.status === 404,
    );
    await assert.rejects(
      () => f.call('POST', []),
      (error) => error.status === 400,
    );
    await f.call('POST', { action: 'pause', expectedVersion: 0, reason: '我方暂缓' });
    await assert.rejects(
      () => f.call('POST', { action: 'review', expectedVersion: 0, reviewDate: '' }),
      (error) => error.status === 409,
    );
    f.store.customer = async () => {
      throw Object.assign(new Error('客户查询超时'), { status: 502 });
    };
    await assert.rejects(
      () => f.call('GET'),
      (error) => error.status === 502 && /超时/.test(error.message),
    );
    assert.equal(f.store.development('one').paused, true);
  } finally {
    f.store.close();
  }
});
