import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModule } from './helpers/modules.mjs';

const { LeadLibraryClient, startLeadLibraryPolling } = loadModule(
  new URL('../src/services/leadLibrary.ts', import.meta.url),
);

const lead = { id: 'customer-1', name: 'Acme', facts: [{ quote: 'Full detail' }], fields: {} };
const snapshot = (scope = 'one', revision = 1) => ({
  leads: [{ id: lead.id, name: 'Acme' }],
  scope,
  total: 1,
  source: 'feishu',
  syncedAt: '2026-10-25T01:00:00.000Z',
  sync: { revision, refreshing: false, stale: false, error: '', lastAttemptAt: null },
});
const detail = (scope = 'one', revision = 1, record = lead) => ({
  ...snapshot(scope, revision),
  lead: record,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('跨页面同时读取合并为一个请求，已加载列表和详情可立即复用', async () => {
  const pending = deferred();
  const calls = [];
  const client = new LeadLibraryClient(async (url) => {
    calls.push(url);
    return url.endsWith('/list') ? pending.promise : Response.json(detail());
  });
  const first = client.list();
  const second = client.list();
  assert.equal(calls.length, 1);
  pending.resolve(Response.json(snapshot()));
  assert.equal(await first, await second);
  assert.equal(client.cachedList().leads[0].name, 'Acme');
  const record = await client.detail(lead.id);
  assert.equal(client.cachedDetail(lead.id), record);
  assert.equal(await client.detail(lead.id), record);
  assert.equal(calls.length, 2);
});

test('刷新失败保留之前的列表与详情，手工刷新使用独立 POST', async () => {
  const calls = [];
  const client = new LeadLibraryClient(async (url, options) => {
    calls.push([url, options.method]);
    if (url.endsWith('/refresh'))
      return Response.json({ error: '飞书暂时不可用' }, { status: 502 });
    return Response.json(url.endsWith('/list') ? snapshot() : detail());
  });
  const previous = await client.list();
  const record = await client.detail(lead.id);
  await assert.rejects(client.refresh(), /飞书暂时不可用/);
  assert.equal(client.cachedList(), previous);
  assert.equal(client.cachedDetail(lead.id), record);
  assert.deepEqual(calls.at(-1), ['/api/v1/leads/real/refresh', 'POST']);
});

test('较早开始的列表请求不能覆盖已完成的手工刷新结果', async () => {
  const old = deferred();
  let count = 0;
  const client = new LeadLibraryClient(async () => {
    count++;
    if (count === 1) return Response.json(snapshot());
    if (count === 2) return old.promise;
    return Response.json(snapshot('one', 2));
  });
  await client.list();
  const earlierRead = client.list();
  await client.refresh();
  old.resolve(Response.json(snapshot('one', 1)));
  await earlierRead;
  assert.equal(client.cachedList().sync.revision, 2);
});

test('手工刷新期间的较晚轮询不能丢弃随后返回的新同步版本', async () => {
  const refreshed = deferred();
  const client = new LeadLibraryClient(async (url) =>
    url.endsWith('/refresh') ? refreshed.promise : Response.json(snapshot()),
  );
  await client.list();
  const refresh = client.refresh();
  await client.list();
  refreshed.resolve(Response.json(snapshot('one', 2)));
  await refresh;
  assert.equal(client.cachedList().sync.revision, 2);
  await client.list();
  assert.equal(client.cachedList().sync.revision, 2);
});

test('切换飞书表后，旧表相同编号的迟到详情不能进入缓存或返回给调用者', async () => {
  const old = deferred();
  let current = snapshot();
  const client = new LeadLibraryClient(async (url) =>
    url.endsWith('/list') ? Response.json(current) : old.promise,
  );
  await client.list();
  const earlierDetail = client.detail(lead.id);
  current = snapshot('two', 1);
  await client.list();
  old.resolve(Response.json(detail('one', 1)));
  await assert.rejects(earlierDetail, /客户资料已更新/);
  assert.equal(client.cachedDetail(lead.id), null);
  assert.equal(client.cachedList().scope, 'two');
});

test('同步版本变更会失效旧详情，迟到响应不能覆盖新版本', async () => {
  const old = deferred();
  let current = snapshot();
  let nextDetail = old.promise;
  const client = new LeadLibraryClient(async (url) =>
    url.endsWith('/list') ? Response.json(current) : nextDetail,
  );
  await client.list();
  const earlierDetail = client.detail(lead.id);
  current = snapshot('one', 2);
  await client.list();
  nextDetail = Promise.resolve(Response.json(detail('one', 2, { ...lead, name: 'Updated' })));
  const updated = await client.detail(lead.id);
  old.resolve(Response.json(detail()));
  assert.equal((await earlierDetail).name, 'Updated');
  assert.equal(client.cachedDetail(lead.id), updated);
});

test('同一张表后台更新时保留正在展示的档案，再读取详情会取得新版本', async () => {
  let current = snapshot();
  let record = lead;
  const client = new LeadLibraryClient(async (url) =>
    Response.json(url.endsWith('/list') ? current : detail('one', current.sync.revision, record)),
  );
  await client.list();
  const displayed = await client.detail(lead.id);
  current = snapshot('one', 2);
  record = { ...lead, name: 'Updated' };
  await client.list();
  assert.equal(client.cachedDetail(lead.id), displayed, '后台刷新不卸载已打开档案和编辑表单');
  assert.equal((await client.detail(lead.id)).name, 'Updated');
  assert.equal(client.cachedDetail(lead.id).name, 'Updated');
});

test('保存成功后，保存前的列表响应不能恢复旧的客户摘要', async () => {
  const old = deferred();
  let count = 0;
  const client = new LeadLibraryClient(async (url) => {
    if (!url.endsWith('/list')) return Response.json(detail());
    count++;
    if (count === 1) return Response.json(snapshot());
    if (count === 2) return old.promise;
    return Response.json({ ...snapshot('one', 2), leads: [{ id: lead.id, name: 'Saved' }] });
  });
  await client.list();
  await client.detail(lead.id);
  const earlierRead = client.list();
  client.updateDetail(lead.id, { name: 'Saved' });
  assert.equal(client.cachedDetail(lead.id).name, 'Saved');
  await client.list();
  old.resolve(Response.json(snapshot()));
  await earlierRead;
  assert.equal(client.cachedList().leads[0].name, 'Saved');
});

test('同步确认客户已删除后，清除对应档案而不继续展示旧客户', async () => {
  let removed = false;
  const client = new LeadLibraryClient(async (url) =>
    Response.json(
      url.endsWith('/list')
        ? removed
          ? { ...snapshot('one', 2), leads: [], total: 0 }
          : snapshot()
        : detail(),
    ),
  );
  await client.list();
  await client.detail(lead.id);
  assert.ok(client.cachedDetail(lead.id));
  removed = true;
  await client.list();
  assert.equal(client.cachedDetail(lead.id), null);
});

test('切换连接后立即清空缓存，切换前的读取和刷新不能重新填回旧表', async () => {
  for (const kind of ['list', 'refresh', 'detail']) {
    const old = deferred();
    let pending = false;
    const client = new LeadLibraryClient(async (url) => {
      if (pending) return old.promise;
      return Response.json(url.endsWith('/list') ? snapshot() : detail());
    });
    await client.list();
    pending = true;
    const earlier = kind === 'detail' ? client.detail(lead.id) : client[kind]();
    client.reset();
    assert.equal(client.cachedList(), null);
    assert.equal(client.cachedDetail(lead.id), null);
    old.resolve(Response.json(kind === 'detail' ? detail() : snapshot()));
    await assert.rejects(earlier, /客户连接已变更|客户资料已更新/);
    assert.equal(client.cachedList(), null);
    assert.equal(client.cachedDetail(lead.id), null);
  }
});

test('导出按需读取完整档案，连接变更时拒绝混入另一张表的数据', async () => {
  const calls = [];
  let exportScope = 'one';
  const client = new LeadLibraryClient(async (url) => {
    calls.push(url);
    return Response.json(
      url.endsWith('/list') ? snapshot() : { ...snapshot(exportScope), leads: [lead] },
    );
  });
  await client.list();
  assert.equal(calls.length, 1);
  assert.deepEqual(await client.exportDetails(), [lead]);
  exportScope = 'two';
  await assert.rejects(client.exportDetails(), /客户连接已变更/);
});

const versionedSnapshot = (revision = 1, first = 'version-a1', second = 'version-b1') => ({
  ...snapshot('one', revision),
  leads: [
    { id: lead.id, name: lead.name, version: first },
    { id: 'customer-2', name: 'Other', version: second },
  ],
});
const versionedDetail = (revision = 1, version = 'version-a1', record = lead) => ({
  ...detail('one', revision, record),
  version,
});

test('其他客户变化、列表重排和无变化同步均复用未变化客户的完整档案', async () => {
  let current = versionedSnapshot();
  let detailCalls = 0;
  const client = new LeadLibraryClient(async (url) => {
    if (url.endsWith('/list')) return Response.json(current);
    detailCalls++;
    return Response.json(versionedDetail());
  });
  await client.list();
  const opened = await client.detail(lead.id);
  current = versionedSnapshot(2, 'version-a1', 'version-b2');
  await client.list();
  assert.equal(await client.detail(lead.id), opened);
  current = {
    ...versionedSnapshot(3, 'version-a1', 'version-b2'),
    leads: [...current.leads].reverse(),
  };
  await client.list();
  assert.equal(await client.detail(lead.id), opened);
  current = { ...current, syncedAt: '2026-10-25T01:01:00.000Z' };
  await client.list();
  assert.equal(await client.detail(lead.id), opened);
  assert.equal(detailCalls, 1);
});

test('仅打开客户自己的内容版本变化时重取档案，等待期间保留已展示内容', async () => {
  let current = versionedSnapshot();
  let response = versionedDetail();
  let detailCalls = 0;
  const client = new LeadLibraryClient(async (url) => {
    if (url.endsWith('/list')) return Response.json(current);
    detailCalls++;
    return Response.json(response);
  });
  await client.list();
  const opened = await client.detail(lead.id);
  current = versionedSnapshot(2, 'version-a2');
  response = versionedDetail(2, 'version-a2', { ...lead, name: 'Updated' });
  await client.list();
  assert.equal(client.cachedDetail(lead.id), opened);
  assert.equal((await client.detail(lead.id)).name, 'Updated');
  assert.equal(detailCalls, 2);
});

test('其他客户保存和全局版本变化不废弃未变化客户正在读取的详情', async () => {
  const pending = deferred();
  let current = versionedSnapshot();
  let detailCalls = 0;
  const client = new LeadLibraryClient(async (url) => {
    if (url.endsWith('/list')) return Response.json(current);
    detailCalls++;
    return pending.promise;
  });
  await client.list();
  const opened = client.detail(lead.id);
  client.updateDetail('customer-2', { name: 'Saved other customer' });
  current = versionedSnapshot(2, 'version-a1', 'version-b2');
  await client.list();
  const shared = client.detail(lead.id);
  pending.resolve(Response.json(versionedDetail()));
  assert.equal(await opened, await shared);
  assert.equal(detailCalls, 1);
});

test('两个表有相同客户编号和内容版本时，旧表迟到详情仍不能进入新表缓存', async () => {
  const pending = deferred();
  let current = versionedSnapshot();
  const client = new LeadLibraryClient(async (url) =>
    url.endsWith('/list') ? Response.json(current) : pending.promise,
  );
  await client.list();
  const old = client.detail(lead.id);
  current = { ...versionedSnapshot(), scope: 'two' };
  await client.list();
  pending.resolve(Response.json(versionedDetail()));
  await assert.rejects(old, /客户资料已更新/);
  assert.equal(client.cachedDetail(lead.id), null);
});

test('首次读取与手工刷新同时发生时，两种完成顺序都保留较新的同步版本', async () => {
  for (const refreshFirst of [true, false]) {
    const reading = deferred();
    const refreshing = deferred();
    const client = new LeadLibraryClient(async (url) =>
      url.endsWith('/refresh') ? refreshing.promise : reading.promise,
    );
    const first = client.list();
    const second = client.refresh();
    if (refreshFirst) {
      refreshing.resolve(Response.json(versionedSnapshot(2)));
      await second;
      reading.resolve(Response.json(versionedSnapshot(1)));
    } else {
      reading.resolve(Response.json(versionedSnapshot(1)));
      await first;
      refreshing.resolve(Response.json(versionedSnapshot(2)));
    }
    await Promise.all([first, second]);
    assert.equal(client.cachedList().sync.revision, 2);
  }
});

test('首次列表之前发出的另一张表详情不能覆盖列表已确认的表', async () => {
  const pending = deferred();
  const client = new LeadLibraryClient(async (url) =>
    url.endsWith('/list')
      ? Response.json({ ...versionedSnapshot(), scope: 'two' })
      : pending.promise,
  );
  const earlierDetail = client.detail(lead.id);
  await client.list();
  pending.resolve(Response.json(versionedDetail()));
  await assert.rejects(earlierDetail, /客户连接已变更/);
  assert.equal(client.cachedList().scope, 'two');
  assert.equal(client.cachedDetail(lead.id), null);
});

test('列表读取仅在页面可见时发送使用中标记', async () => {
  let visible = true;
  const headers = [];
  const client = new LeadLibraryClient(
    async (_url, options) => {
      headers.push(options.headers);
      return Response.json(versionedSnapshot());
    },
    () => visible,
  );
  await client.list();
  visible = false;
  await client.list();
  assert.deepEqual(headers, [{ 'X-Lead-Library-Activity': 'active' }, undefined]);
});

function pollingEnvironment(initial = 'visible') {
  let id = 0;
  const listeners = new Set();
  const timers = new Map();
  const visibility = {
    visibilityState: initial,
    addEventListener: (_name, listener) => listeners.add(listener),
    removeEventListener: (_name, listener) => listeners.delete(listener),
    set(value) {
      this.visibilityState = value;
      listeners.forEach((listener) => listener());
    },
  };
  return {
    visibility,
    timers,
    listeners,
    setTimer: (callback, delay) => {
      timers.set(++id, { callback, delay });
      return id;
    },
    clearTimer: (timer) => timers.delete(timer),
    fire() {
      const [timer, { callback }] = timers.entries().next().value;
      timers.delete(timer);
      callback();
    },
  };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('隐藏页面取消全部自动读取，恢复可见立即读取并恢复正常间隔', async () => {
  const env = pollingEnvironment();
  let reads = 0;
  const stop = startLeadLibraryPolling({
    ...env,
    read: async () => {
      reads++;
    },
    isRefreshing: () => false,
  });
  await settle();
  assert.equal(reads, 1);
  assert.equal([...env.timers.values()][0].delay, 60000);
  env.visibility.set('hidden');
  assert.equal(env.timers.size, 0);
  env.visibility.set('visible');
  await settle();
  assert.equal(reads, 2);
  assert.equal([...env.timers.values()][0].delay, 60000);
  stop();
  assert.equal(env.timers.size, 0);
  assert.equal(env.listeners.size, 0);
});

test('同步进行时仅可见页面每秒读取，同步结束恢复六十秒间隔', async () => {
  const env = pollingEnvironment('hidden');
  let reads = 0;
  let refreshing = true;
  const stop = startLeadLibraryPolling({
    ...env,
    read: async () => {
      reads++;
    },
    isRefreshing: () => refreshing,
  });
  await settle();
  assert.equal(reads, 0);
  assert.equal(env.timers.size, 0);
  env.visibility.set('visible');
  await settle();
  assert.equal([...env.timers.values()][0].delay, 1000);
  refreshing = false;
  env.fire();
  await settle();
  assert.equal(reads, 2);
  assert.equal([...env.timers.values()][0].delay, 60000);
  stop();
});

test('读取期间页面隐藏，迟到结果不会重新创建轮询；卸载后也不会恢复', async () => {
  const env = pollingEnvironment();
  const pending = deferred();
  let reads = 0;
  const stop = startLeadLibraryPolling({
    ...env,
    read: () => {
      reads++;
      return pending.promise;
    },
    isRefreshing: () => true,
  });
  env.visibility.set('hidden');
  pending.resolve();
  await settle();
  assert.equal(reads, 1);
  assert.equal(env.timers.size, 0);
  stop();
  env.visibility.set('visible');
  await settle();
  assert.equal(reads, 1);
  assert.equal(env.timers.size, 0);
});

test('旧读取尚未结束时恢复可见，结束后立即补充一次新读取', async () => {
  const env = pollingEnvironment();
  const pending = deferred();
  let reads = 0;
  const stop = startLeadLibraryPolling({
    ...env,
    read: () => {
      reads++;
      return reads === 1 ? pending.promise : Promise.resolve();
    },
    isRefreshing: () => false,
  });
  env.visibility.set('hidden');
  env.visibility.set('visible');
  assert.equal(reads, 1, '旧请求仍在读取时不并发启动重复请求');
  pending.resolve();
  await settle();
  assert.equal(reads, 2, '可见后立即补充一次最新读取');
  assert.equal([...env.timers.values()][0].delay, 60000);
  stop();
});
