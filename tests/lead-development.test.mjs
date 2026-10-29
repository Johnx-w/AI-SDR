import test from 'node:test';
import assert from 'node:assert/strict';
import { decorateLeadDevelopment } from '../server/lead-development.mjs';
import { withApp } from './helpers/http.mjs';

test('暂缓覆盖列表、详情与导出显示，原始档案和其它客户内容版本不变', () => {
  const lead = { id: 'customer-1', status: '已回复' };
  const other = { id: 'customer-2', status: '待开发', version: 'other' };
  const contexts = [{ customerId: lead.id, development: { version: 1, paused: true } }];
  const listed = decorateLeadDevelopment(
    { leads: [{ ...lead, version: 'original' }, other] },
    { customerContexts: contexts },
  );
  const detailed = decorateLeadDevelopment(
    { lead, version: 'original' },
    { customerContexts: contexts },
  );
  assert.equal(listed.leads[0].status, '暂缓开发');
  assert.equal(detailed.lead.status, '暂缓开发');
  assert.equal(listed.leads[0].version, detailed.version);
  assert.equal(listed.leads[1], other);
  assert.equal(lead.status, '已回复');
  contexts[0].development = { version: 2, paused: false };
  const resumed = decorateLeadDevelopment({ leads: [lead] }, { customerContexts: contexts });
  assert.equal(resumed.leads[0].status, '已回复');
});

test('HTTP暂缓后列表和详情立即一致、复查提醒持续存在，延期或恢复才消除', async () => {
  const customer = {
    record_id: 'customer-1',
    fields: { 公司名称: 'ABC Blinds', 开发状态: '待开发' },
  };
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
  const env = {
    ACQUISITION_PROVIDER: 'n8n',
    N8N_BASE_URL: 'https://fixture.test',
    FEISHU_READ_WEBHOOK_URL: 'https://fixture.test/webhook/read',
    N8N_WEBHOOK_SECRET: 'fixture',
    FEISHU_APP_ID: 'fixture-app',
    FEISHU_APP_SECRET: 'fixture-secret',
    FEISHU_APP_TOKEN: 'fixture-token',
    FEISHU_TABLE_ID: 't2',
  };
  await withApp(
    {
      env,
      fetchImpl: async (url, init = {}) => {
        const endpoint = String(url);
        if (endpoint === env.FEISHU_READ_WEBHOOK_URL)
          return Response.json({ code: 0, data: { items: [customer], has_more: false } });
        if (endpoint.endsWith('/auth/v3/tenant_access_token/internal'))
          return Response.json({ code: 0, tenant_access_token: 'fixture', expire: 7200 });
        assert.equal(init.method || 'GET', 'GET', '不能写入飞书或发送邮件');
        assert.ok(endpoint.endsWith('/tables/t2/records/customer-1'), endpoint);
        return Response.json({ code: 0, data: { record: customer } });
      },
    },
    async (root) => {
      const get = async (path) => {
        const response = await fetch(root + path);
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      const controlPath = '/api/v1/business/customers/customer-1/development';
      const act = async (body) => {
        const response = await fetch(root + controlPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
      };
      const initialList = await get('/api/v1/leads/real/list');
      let view = await get(controlPath);
      view = await act({
        action: 'pause',
        expectedVersion: view.development.version,
        reason: '客户要求稍后联系',
        reviewDate: today,
      });
      const pausedList = await get('/api/v1/leads/real/list');
      const pausedDetail = await get('/api/v1/leads/real/customer-1');
      assert.equal(pausedList.leads[0].status, '暂缓开发');
      assert.equal(pausedList.leads[0].version, pausedDetail.version);
      assert.notEqual(pausedDetail.version, initialList.leads[0].version);
      for (let i = 0; i < 2; i++) {
        const overview = await get('/api/v1/overview');
        assert.equal(overview.developmentReviews.length, 1);
        assert.equal(overview.developmentReviews[0].to, '/leads?lead=customer-1');
        assert.equal(overview.developmentReviews[0].name, 'ABC Blinds');
        assert.equal(
          overview.priority.some((row) => row.customerId === 'customer-1'),
          false,
        );
      }
      view = await act({
        action: 'review',
        expectedVersion: view.development.version,
        reviewDate: tomorrow,
      });
      assert.equal(view.development.paused, true);
      assert.deepEqual((await get('/api/v1/overview')).developmentReviews, []);
      view = await act({
        action: 'review',
        expectedVersion: view.development.version,
        reviewDate: today,
      });
      assert.equal((await get('/api/v1/overview')).developmentReviews.length, 1);
      view = await act({
        action: 'resume',
        expectedVersion: view.development.version,
        reviewed: true,
        reviewToken: view.reviewToken,
        resumeNotes: '重新准备开发信并审核，明天按计划发送',
      });
      assert.equal(view.development.paused, false);
      assert.deepEqual((await get('/api/v1/overview')).developmentReviews, []);
      assert.equal((await get('/api/v1/leads/real/list')).leads[0].status, '待开发');
      assert.equal(customer.fields.开发状态, '待开发');
    },
  );
});
