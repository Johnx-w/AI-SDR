import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
const input = {
  country: 'United States',
  region: 'Florida',
  product: 'outdoor zip screens',
  acquisition_channel: 'tavily_web',
  search_query: 'outdoor zip screens Florida United States',
};
test('直连入口使用持久操作核对幂等结果；结果不明时仅核对，禁止重复运行', async () => {
  let runCalls = 0,
    statusCalls = 0,
    closed = 0;
  const output = { outcome: 'completed', 新增: 1, reason: '已读回核验' };
  const app = createApp({
    env: {
      TAVILY_API_KEY: 'test',
      DEEPSEEK_API_KEY: 'test',
      FEISHU_APP_ID: 'test',
      FEISHU_APP_SECRET: 'test',
      FEISHU_APP_TOKEN: 'test',
      FEISHU_TABLE_ID: 'test',
    },
    fetchImpl: async () => {
      throw new Error('Unexpected external request');
    },
    nativeImpl: {
      async run() {
        runCalls++;
        throw Object.assign(new Error('写入结果待核对'), { status: 409 });
      },
      async status(id) {
        statusCalls++;
        assert.equal(id, 'native-recovery-01');
        return { settled: true, output };
      },
      close() {
        closed++;
      },
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const post = (prefix) =>
    fetch(base + prefix + '/runs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'native-recovery-01',
      },
      body: JSON.stringify(input),
    });
  try {
    assert.equal((await post('/api/v1/acquisition')).status, 409);
    const recovered = await post('/api/v1/acquisition');
    assert.equal(recovered.status, 200);
    const result = await recovered.json();
    assert.equal(result.summary.inserted, 1);
    assert.deepEqual(result.result, output);
    assert.deepEqual(await (await post('/api/v1/acquisition')).json(), result);
    assert.equal(runCalls, 1);
    assert.equal(statusCalls, 1);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
  assert.equal(closed, 1);
});
