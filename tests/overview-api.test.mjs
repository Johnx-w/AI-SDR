import { withFeishuAuth } from './helpers/feishu.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { withApp } from './helpers/http.mjs';
import { OutreachService } from '../server/outreach-service.mjs';

test('总览HTTP只读聚合真实客户与本地业务，不调用搜索、邮件或飞书写入', async () => {
  const calls = [];
  const env = {
    FEISHU_APP_ID: 'fixture-app',
    FEISHU_TABLE_ID: 'fixture-table',
    FEISHU_APP_SECRET: 'fixture-secret',
    FEISHU_APP_TOKEN: 'fixture-base',
  };
  await withApp(
    {
      env,
      fetchImpl: withFeishuAuth(async (url, options) => {
        calls.push({ url: String(url), method: options?.method || 'GET' });
        assert.equal(new URL(url).origin, 'https://open.feishu.cn');
        return Response.json({
          code: 0,
          data: {
            items: [
              { record_id: 'real-one', fields: { 公司名称: '真实企业', 开发状态: '待开发' } },
            ],
            has_more: false,
          },
        });
      }),
    },
    async (root) => {
      const response = await fetch(
        root + '/api/v1/overview?period=7d&asOf=2026-10-25T02%3A00%3A00.000Z',
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const result = await response.json();
      assert.equal(result.metrics.companies, 1);
      assert.equal(Object.hasOwn(result.metrics, 'activeDemands'), false);
      assert.equal(Object.hasOwn(result, 'stages'), false);
      assert.equal(result.metrics.dueTasks, 0);
      assert.equal(result.metrics.newCompanies, 0);
      assert.equal(result.asOf, '2026-10-25T02:00:00.000Z');
      assert.equal(result.sources.business.state, 'ready');
      assert.equal(result.coverage.recordedOnly, true);
      assert.equal(calls.length, 1);
      assert.equal((await fetch(root + '/api/v1/overview', { method: 'POST' })).status, 405);
      assert.equal((await fetch(root + '/api/v1/overview?period=all')).status, 400);
      assert.equal((await fetch(root + '/api/v1/overview?asOf=bad-time')).status, 400);
      assert.equal(
        (await fetch(root + '/api/v1/overview', { headers: { origin: 'https://foreign.example' } }))
          .status,
        403,
      );
    },
  );
});

test('客户入口未接通时总览其它本地来源仍可读，客户数不伪装成零', async () => {
  await withApp(
    {
      env: {},
      fetchImpl: withFeishuAuth(async () => {
        throw new Error('不应请求外部服务');
      }),
    },
    async (root) => {
      const response = await fetch(root + '/api/v1/overview');
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.metrics.companies, null);
      assert.equal(result.sources.customers.state, 'unavailable');
      assert.equal(result.metrics.dueTasks, 0);
      assert.equal(result.products.draft, 0);
    },
  );
});

test('总览分页稳定，提醒只统计总数，越界页收敛且非法页返回 400', async () => {
  const mailbox = { id: 'one', email: 'sales@brand.example', configured: true };
  const service = new OutreachService({
    mailboxes: { list: () => [mailbox], send: assert.fail },
    now: () => Date.parse('2026-10-25T02:00:00Z'),
  });
  for (let i = 0; i < 28; i++)
    service.conversations.putMessage(mailbox, {
      messageId: `<quote-${i}@buyer.example>`,
      direction: 'inbound',
      source: 'imap',
      deliveryStatus: 'received',
      from: 'buyer@buyer.example',
      to: mailbox.email,
      toAddresses: [mailbox.email],
      subject: `Re: Product ${i}`,
      bodyText: 'Please send your price list.',
      occurredAt: new Date(Date.parse('2026-10-24T02:00:00Z') + i * 1000).toISOString(),
    });
  await withApp({ env: {}, outreachServiceFactory: () => service }, async (root) => {
    const overview = await (await fetch(root + '/api/v1/overview')).json();
    assert.equal(overview.positiveReplies.length, 25);
    assert.equal(overview.positiveReplyTotal, 28);
    assert.equal(overview.positiveReplyPageSize, 25);
    assert.equal(overview.positiveReplies[0].subject, 'Re: Product 0');
    const tail = await (await fetch(root + '/api/v1/overview?positivePage=99')).json();
    assert.equal(tail.positiveReplyPage, 2);
    assert.deepEqual(
      tail.positiveReplies.map((item) => item.subject),
      ['Re: Product 25', 'Re: Product 26', 'Re: Product 27'],
    );
    assert.equal((await fetch(root + '/api/v1/overview?positivePage=-1')).status, 400);
    service.conversations.positiveReplyTasks = assert.fail;
    service.conversations.customerLookup = assert.fail;
    assert.equal(overview.positiveReplies[0].requestType, 'quote');
    assert.equal(
      (await (await fetch(root + '/api/v1/overview?summary=reminders')).json()).count,
      28,
    );
  });
});
