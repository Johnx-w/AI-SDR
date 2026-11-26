import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuClient } from '../server/feishu-direct.mjs';

test('飞书只读分页在维护时停止下一页，不启动新请求；当前写入读回仍可完成', async () => {
  let maintaining = false,
    calls = 0;
  const client = new FeishuClient({
    env: { FEISHU_APP_TOKEN: 'fixture', FEISHU_TABLE_ID: 't2' },
    isMaintaining: () => maintaining,
    fetchImpl: async (url) => {
      calls++;
      if (url.includes('/records/'))
        return Response.json({ code: 0, data: { record: { record_id: 'a', fields: {} } } });
      maintaining = true;
      return Response.json({
        code: 0,
        data: { items: [{ record_id: 'a' }], has_more: true, page_token: 'second' },
      });
    },
  });
  client.token = { value: 'fixture-token', until: Infinity };
  await assert.rejects(client.records(), { maintenance: true });
  assert.equal(calls, 1);
  assert.equal((await client.record('a')).record_id, 'a');
  assert.equal(calls, 2);
});
