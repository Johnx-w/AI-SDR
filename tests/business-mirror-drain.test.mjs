import test from 'node:test';
import assert from 'node:assert/strict';
import { CustomerBusinessApi } from '../server/customer-business-api.mjs';

test('业务镜像同步两个现有客户，保留失效客户历史并提示；稳定状态不重复读远端，档案恢复后补同步', async () => {
  let customers = [{ id: 'customer-a' }, { id: 'customer-b' }];
  const service = new CustomerBusinessApi({
    getEnv: () => ({}),
    knowledge: () => ({ list: () => [] }),
    loadCustomers: async () => customers,
    customerRemoteId: (id) => (customers.some((c) => c.id === id) ? id : null),
  });
  const state = service.state();
  const mirrored = [];
  state.mirror.sync = async (workspace) => {
    mirrored.push(workspace.messages.map((m) => m.id));
    return { status: 'synced' };
  };
  for (const [id, customerId] of [
    ['mail-a', 'customer-a'],
    ['mail-b', 'customer-b'],
    ['historical', 'missing'],
  ])
    state.store.put('messages', {
      id,
      customerId,
      direction: 'outbound',
      channel: 'email',
      deliveryStatus: 'sent',
      actualConfirmed: true,
      version: 1,
      body: id,
    });
  try {
    const first = await service.synchronize({ force: false });
    assert.equal(first.status, 'pending');
    assert.match(first.error, /1.*客户档案/);
    assert.deepEqual(mirrored, [['mail-a', 'mail-b']]);
    assert.equal(state.store.all('messages').length, 3, '原始业务历史必须保留');
    const cached = await service.synchronize({ force: false });
    assert.equal(cached.error, first.error);
    assert.equal(mirrored.length, 1, '只有历史缺失提示时不反复读整张远端表');
    customers = [...customers, { id: 'missing' }];
    assert.equal((await service.synchronize({ force: false })).status, 'synced');
    assert.deepEqual(mirrored[1], ['mail-a', 'mail-b', 'historical']);
  } finally {
    await service.close();
  }
});

test('维护中的业务同步让出已排队轮次，不进入后续客户或镜像阶段并释放计数', async () => {
  const service = new CustomerBusinessApi({
    getEnv: () => ({}),
    knowledge: () => ({ list: () => [] }),
    loadCustomers: async () => assert.fail('维护中不应读取下一阶段'),
    isMaintaining: () => true,
  });
  try {
    assert.equal((await service.synchronize()).status, 'pending');
    assert.equal(service.syncing, 0);
  } finally {
    await service.close();
  }
});
