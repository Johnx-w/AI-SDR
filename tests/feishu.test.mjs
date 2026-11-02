import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldText, mapFeishuRecord } from '../server/feishu.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';
import { feishuEnv, withFeishuAuth } from './helpers/feishu.mjs';
import { createApp } from '../server/app.mjs';

const env = feishuEnv;
const record = {
  record_id: 'rec-test',
  fields: {
    客户名称: 'Test company',
    匹配状态: '待核实',
    来源链接: 'https://business.example/miami',
    画像JSON: JSON.stringify({
      task_target: { country: 'United States', city: 'Miami' },
      match_reason: '企业所在地未确认',
      facts: [{ field: 'products', value: 'screens', quote: 'We supply screens' }],
    }),
  },
};

test('真实客户不使用目标国家代替企业所在地，不伪造评分', () => {
  const lead = mapFeishuRecord(record);
  assert.equal(lead.market, '待核实');
  assert.equal(lead.city, '');
  assert.equal(lead.score, null);
  assert.equal(lead.grade, '未评级');
  assert.equal(lead.match, '');
  assert.equal(lead.facts[0].quote, 'We supply screens');
});
test('空白和未记录开发状态统一待开发，保留已有进度和原始字段', () => {
  for (const status of [undefined, null, '', '  ', [], '未记录', [{ text: '未记录' }]]) {
    const lead = mapFeishuRecord({ fields: { 开发状态: status } });
    assert.equal(lead.status, '待开发');
    assert.equal(lead.fields['开发状态'], fieldText(status));
  }
  for (const status of [
    '待开发',
    '已联系',
    '已回复',
    '跟进中',
    '暂缓开发',
    '停止开发',
    '人工跟进中',
  ])
    assert.equal(mapFeishuRecord({ fields: { 开发状态: status } }).status, status);
});

test('飞书富文本和异常画像可读取，原始字段被保留', () => {
  const lead = mapFeishuRecord({
    record_id: 'rec-2',
    fields: {
      客户名称: [{ text: 'Acme' }],
      邮箱: [{ text: 'sales@acme.example' }],
      画像JSON: '{invalid',
    },
  });
  assert.equal(lead.name, 'Acme');
  assert.equal(lead.email, 'sales@acme.example');
  assert.equal(lead.fields['画像JSON'], '{invalid');
});

test('客户录入时间优先取首次发现时间，缺失时取记录创建时间，不使用最近研究时间', () => {
  const createdAt = 1793145600000;
  const updatedAt = 1793232000000;
  for (const firstSeen of [createdAt, String(createdAt), [{ text: String(createdAt) }]]) {
    const lead = mapFeishuRecord({
      ...record,
      created_time: updatedAt,
      fields: { ...record.fields, 首次发现时间: firstSeen, 最近研究时间: updatedAt },
    });
    assert.equal(lead.createdAt, createdAt);
    assert.equal(lead.updatedAt, updatedAt);
  }
  for (const missing of [undefined, '', 'invalid', 0, -1, Infinity]) {
    const fields = { ...record.fields, 首次发现时间: missing, 最近研究时间: updatedAt };
    assert.equal(
      mapFeishuRecord({ ...record, created_time: createdAt, fields }).createdAt,
      createdAt,
    );
    assert.equal(mapFeishuRecord({ ...record, fields }).createdAt, null);
  }
});
test('飞书直连遍历全部分页，仅向官方接口发送Bearer认证，无写入请求', async () => {
  const calls = [];
  const client = new FeishuClient({
    env,
    fetchImpl: withFeishuAuth(async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        code: 0,
        data: {
          items: [{ ...record, record_id: 'rec-' + calls.length }],
          has_more: calls.length === 1,
          page_token: 'next/page+token',
        },
      });
    }),
  });
  const result = await client.readLeads();
  assert.equal(result.leads.length, 2);
  assert.equal(result.source, 'feishu');
  assert.match(calls[1].url, /page_token=next%2Fpage%2Btoken/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-token');
  assert.ok(
    calls.every(
      (call) =>
        new URL(call.url).origin === 'https://open.feishu.cn' && call.options.method === 'GET',
    ),
  );
  assert.ok(!JSON.stringify(result).includes(env.FEISHU_APP_SECRET));
});
test('缺少飞书参数、上游错误和不完整分页均不会伪造成功', async () => {
  await assert.rejects(
    new FeishuClient({ env: {}, fetchImpl: () => assert.fail('no remote request') }).readLeads(),
    /未配置/,
  );
  for (const response of [
    new Response('', { status: 403 }),
    Response.json({ code: 999, msg: 'upstream' }),
  ]) {
    await assert.rejects(
      new FeishuClient({ env, fetchImpl: withFeishuAuth(async () => response) }).readLeads(),
      /飞书/,
    );
  }
  await assert.rejects(
    new FeishuClient({
      env,
      fetchImpl: withFeishuAuth(async () =>
        Response.json({ code: 0, data: { items: [], has_more: true, page_token: 'same' } }),
      ),
    }).readLeads(),
    /分页不完整/,
  );
});
test('真实客户接口只读，响应不泄露服务端认证', async () => {
  const app = createApp({
    env,
    fetchImpl: withFeishuAuth(async () =>
      Response.json({ code: 0, data: { items: [record], has_more: false } }),
    ),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${app.address().port}/api/v1/leads/real`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 1);
    assert.equal(JSON.stringify(body).includes(env.FEISHU_APP_SECRET), false);
    assert.equal((await fetch(url, { method: 'POST' })).status, 404);
    assert.equal(
      (await fetch(url, { headers: { Origin: 'https://untrusted.example' } })).status,
      403,
    );
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
