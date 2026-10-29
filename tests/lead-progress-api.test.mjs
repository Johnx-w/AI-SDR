import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { recordOutreachInBusiness } from '../server/outreach-business.mjs';
import { withApp } from './helpers/http.mjs';

test('已有真实发送、来信和需求推进即时联动列表、详情、导出和业务页面，保留飞书原始状态', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'lead-progress-'));
  const customer = {
    record_id: 'customer-1',
    fields: { 公司名称: 'ABC Blinds', 开发状态: '待开发', 企业官网: 'https://buyer.example.org' },
  };
  const path = join(folder, 'business.sqlite');
  const store = new CustomerBusiness({
    path,
    scope: 'fixture-token/t2',
    customer: async () => structuredClone(customer),
  });
  t.after(() => {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  });
  const env = {
    ACQUISITION_PROVIDER: 'n8n',
    N8N_BASE_URL: 'https://fixture.test',
    FEISHU_READ_WEBHOOK_URL: 'https://fixture.test/webhook/read',
    N8N_WEBHOOK_SECRET: 'fixture',
    FEISHU_APP_ID: 'fixture-app',
    FEISHU_APP_SECRET: 'fixture-secret',
    FEISHU_APP_TOKEN: 'fixture-token',
    FEISHU_TABLE_ID: 't2',
    CUSTOMER_BUSINESS_DB_PATH: path,
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
        assert.equal(init.method || 'GET', 'GET', '状态联动不能写入飞书或发送邮件');
        if (endpoint.includes('/tables?'))
          return Response.json({ code: 0, data: { items: [], has_more: false } });
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
      const library = '/api/v1/leads/real';
      const initial = await get(library + '/list');
      const sent = await recordOutreachInBusiness({
        store,
        delivery: {
          id: 'delivery-before-read',
          campaignId: 'campaign',
          mode: 'production',
          status: 'accepted',
          customerId: customer.record_id,
          from: 'sales@company.example',
          to: 'buyer@buyer.example',
          subject: 'Product introduction',
          bodyText: 'Approved introduction.',
          messageId: '<introduction@company.example>',
          sentAt: '2026-10-28T01:00:00Z',
        },
      });
      const assertViews = async (expected) => {
        const [list, detail, exported, business, control] = await Promise.all([
          get(library + '/list'),
          get(library + '/customer-1'),
          get(library),
          get('/api/v1/business'),
          get('/api/v1/business/customers/customer-1/development'),
        ]);
        for (const lead of [list.leads[0], detail.lead, exported.leads[0], business.customers[0]])
          assert.equal(lead.status, expected);
        assert.equal(control.status, expected);
        assert.equal(control.sourceStatus, '待开发');
        assert.equal(list.leads[0].version, detail.version);
        assert.equal(exported.leads[0].version, undefined);
        assert.equal(list.sync.revision, initial.sync.revision, '业务状态无需飞书快照变化即可生效');
        assert.equal(customer.fields.开发状态, '待开发');
        return list.leads[0].version;
      };
      const acceptedVersion = await assertViews('已联系');
      assert.notEqual(acceptedVersion, initial.leads[0].version);
      assert.equal(await assertViews('已联系'), acceptedVersion);
      const incoming = await store.saveMessage({
        customerId: customer.record_id,
        conversationId: sent.conversation.id,
        channel: 'email',
        account: 'sales@company.example',
        direction: 'inbound',
        from: 'buyer@buyer.example',
        to: 'sales@company.example',
        occurredAt: '2026-10-28T02:00:00Z',
        deliveryStatus: 'received',
        classification: 'normal',
        body: 'Please quote 500 roller blinds.',
        actualConfirmed: true,
      });
      const repliedVersion = await assertViews('已回复');
      assert.notEqual(repliedVersion, acceptedVersion);
      const demand = await store.saveDemand({
        customerId: customer.record_id,
        conversationId: sent.conversation.id,
        sourceMessageId: incoming.id,
        title: '卷帘询价',
        category: 'indoor',
        direction: 'finished',
        productText: 'roller blinds',
        productIds: [],
        evidenceQuote: '500 roller blinds',
        stage: 'new',
      });
      assert.equal(await assertViews('已回复'), repliedVersion);
      await store.saveDemand({ ...demand, stage: 'quoting' }, { expectedVersion: demand.version });
      const followingVersion = await assertViews('跟进中');
      assert.notEqual(followingVersion, repliedVersion);
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
      let control = await get(controlPath);
      control = await act({
        action: 'pause',
        expectedVersion: control.development.version,
        reason: '我方暂缓',
      });
      await assertViews('暂缓开发');
      await act({
        action: 'resume',
        expectedVersion: control.development.version,
        reviewed: true,
        reviewToken: control.reviewToken,
        resumeNotes: '继续报价沟通',
      });
      await assertViews('跟进中');
    },
  );
});
