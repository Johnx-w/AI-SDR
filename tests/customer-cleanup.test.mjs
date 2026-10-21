import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectBusinessPhones } from '../server/phone-format.mjs';
import { researchFields, mergeResearchFields } from '../server/company-research.mjs';
import { formatRelatedProducts } from '../server/product-format.mjs';
import { buildSearchQuery } from '../src/domain/search-query.mjs';
import { createApp } from '../server/app.mjs';

test('来源页本地号码和总机优先，补充页的网点号码不批量进入电话字段', () => {
  const source = 'https://business.example.org/cities/miami';
  const contacts = [
    { kind: 'phone', value: '8884774202', source_url: source, primary: true, method: 'tel_link' },
    { kind: 'phone', value: '3058539120', source_url: source, method: 'tel_link' },
    {
      kind: 'phone',
      value: '+1-888-477-4202',
      source_url: 'https://business.example.org/',
      primary: true,
    },
    ...['9514770411', '8087847727', '7028204011'].map((value) => ({
      kind: 'phone',
      value,
      source_url: 'https://business.example.org/contact',
    })),
  ];
  const result = selectBusinessPhones(contacts, 'United States', source);
  assert.deepEqual(
    result.map((c) => c.value),
    ['+1 8884774202', '+1 3058539120'],
  );
  const fields = researchFields(
    { actual_country: 'United States', source_url: source },
    { contacts },
    { 电话: '9514770411\n888-477-4202' },
  );
  const merged = mergeResearchFields(
    { 国家: 'United States', 电话: '9514770411\n888-477-4202' },
    fields,
  );
  assert.equal(merged['电话'], '+1 8884774202\n+1 3058539120');
});
test('相关产品合并中英文重复名称并使用英文(中文)格式', () => {
  const result = formatRelatedProducts(
    '卷帘\nRoller Blinds\n户外遮阳篷\nAwnings\nOutdoor Zip-Track Blinds\nFolding Arm Awnings',
  );
  assert.equal(result.split('\n').length, 4);
  assert.match(result, /Roller Blinds\(卷帘\)/);
  assert.match(result, /Outdoor Zip-Track Blinds\(户外防风卷帘\)/);
  assert.match(result, /Folding Arm Awnings\(曲臂遮阳篷\)/);
  assert.equal(formatRelatedProducts(result), result);
});
test('搜索词由结构化筛选确定，无需模型；多产品以 OR 分组且国家准确保留', () => {
  const input = {
    product: 'outdoor zip screens, pergolas',
    country: 'United States',
    region: 'Florida',
    customer_type: 'manufacturer',
    customer_profile: 'manufacturing',
    audience: 'BC',
  };
  const q = buildSearchQuery(input);
  assert.match(q, /^\("outdoor zip screens" OR pergolas\)/);
  assert.match(q, /manufacturer factory/);
  assert.ok(q.endsWith('Florida United States'));
  assert.equal(q, buildSearchQuery(input));
  assert.doesNotMatch(
    buildSearchQuery({ product: 'shades', country: 'United Kingdom', region: '', audience: 'C' }),
    /Florida/,
  );
});
test('已删除的联系方式补采与 AI 搜索词接口返回404且不调用上游', async () => {
  let calls = 0;
  const app = createApp({
    env: {},
    fetchImpl: async () => {
      calls++;
      throw new Error('Unexpected network');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    const base = 'http://127.0.0.1:' + app.address().port;
    assert.equal((await fetch(base + '/api/v1/leads/real/rec-example/contacts')).status, 404);
    for (const prefix of ['/api/v1/acquisition', '/api/v1/integrations/n8n']) {
      assert.equal(
        (
          await fetch(base + prefix + '/search-query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          })
        ).status,
        404,
      );
    }
    assert.equal(calls, 0);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
});
