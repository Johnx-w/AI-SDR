import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuClient, encodeResearchFields } from '../server/feishu-direct.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';

const definitions = [
  ['公司名称', 1],
  ['customer_id', 1],
  ['来源链接', 15],
  ['官网链接', 1],
  ['国家/地区', 1],
  ['客户类型', 4],
  ['企业经营产品', 1],
  ['主营产品概况', 1],
  ['主营产品偏好', 18],
  ['公开采购需求', 1],
  ['客户画像摘要', 1],
  ['最新客户评级', 3],
].map(([field_name, type]) => ({ field_name, type }));

test('原客户表多选角色与同义列支持后续获客写入和读取', async () => {
  const fields = encodeResearchFields(
    {
      公司名称: 'Buyer',
      customer_id: 'web_buyer.example',
      国家: 'Australia',
      企业官网: 'https://buyer.example/',
      来源链接: 'https://buyer.example/contact',
      客户类型: '零售商、经销商、服务商',
      用户评级: 'A',
      主营产品偏好: '销售并安装卷帘',
      客户行业画像: '窗饰零售及安装企业',
    },
    definitions,
  );
  assert.deepEqual(fields.客户类型, ['零售商', '经销商', '服务商']);
  assert.equal(fields['国家/地区'], 'Australia');
  assert.equal(fields.官网链接, 'https://buyer.example/');
  assert.equal(fields.最新客户评级, 'A');
  assert.equal(fields.主营产品概况, '销售并安装卷帘');
  assert.equal(Object.hasOwn(fields, '主营产品偏好'), false);
  let saved;
  const client = new FeishuClient({
    env: {
      FEISHU_APP_ID: 'fixture',
      FEISHU_APP_SECRET: 'fixture',
      FEISHU_APP_TOKEN: 'fixture',
      FEISHU_TABLE_ID: 't2',
    },
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/tenant_access_token/internal'))
        return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
      if (url.includes('/fields?'))
        return Response.json({ code: 0, data: { items: definitions, has_more: false } });
      assert.equal(options.method, 'PUT');
      saved = JSON.parse(options.body).fields;
      return Response.json({
        code: 0,
        data: { record: { record_id: 'recFixture', fields: saved } },
      });
    },
  });
  const record = await client.write('update', fields, 'recFixture');
  assert.deepEqual(saved, fields);
  const lead = mapFeishuRecord(record);
  assert.equal(lead.market, 'Australia');
  assert.equal(lead.grade, 'A');
  assert.equal(lead.website, 'https://buyer.example/');
  assert.match(lead.type, /经销商/);
  assert.equal(lead.mainProductPreference, '销售并安装卷帘');
});

test('精简原T2允许只有自动客户ID和官网，研究写入不要求被删除的列', () => {
  const compact = definitions.filter(
    (field) => !['customer_id', '来源链接', '公开采购需求'].includes(field.field_name),
  );
  compact.push({ field_name: '客户ID', type: 1005 });
  const fields = encodeResearchFields(
    {
      公司名称: 'Buyer',
      customer_id: 'web_buyer.example',
      企业官网: 'https://buyer.example/',
      来源链接: 'https://directory.example/buyer',
      需求产品: '原始证据保留在研究记录',
      客户行业画像: '最新摘要\n依据：quoted\n来源：https://buyer.example/',
      客户类型: '零售商',
    },
    compact,
  );
  assert.equal(fields.官网链接, 'https://buyer.example/');
  assert.equal(fields.客户画像摘要, '最新摘要');
  for (const name of ['客户ID', 'customer_id', '来源链接', '需求产品', '公开采购需求'])
    assert(!Object.hasOwn(fields, name));
});
