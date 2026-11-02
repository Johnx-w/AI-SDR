import test from 'node:test';
import assert from 'node:assert/strict';
import { OutreachService } from '../server/outreach-service.mjs';
import { handleOutreach } from '../server/outreach-api.mjs';

test('发送记录分页能访问超过最近500条的历史，先筛选再分页并限制无效页码', async (t) => {
  const service = new OutreachService({ mailboxes: { list: () => [] } });
  t.after(() => service.close());
  for (let i = 0; i < 523; i++)
    service.putDelivery({
      id: `d-${i}`,
      campaignId: i % 2 ? 'one' : 'two',
      status: i % 2 ? 'accepted' : 'cancelled',
      companyName: `客户 ${i}`,
      to: `buyer-${i}@example.org`,
      from: 'SALES@example.org',
      subject: 'Window 100%_match',
      createdAt: '2026-10-27T00:00:00Z',
    });
  const get = (query = '') =>
    handleOutreach({
      request: { method: 'GET' },
      url: new URL(`http://localhost/api/v1/outreach/deliveries?${query}`),
      service,
    });
  const first = await get();
  assert.equal(first.total, 523);
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0].id, 'd-522');
  assert.equal(first.totalPages, 27);
  const last = await get('page=27');
  assert.equal(last.items.length, 3);
  assert.equal(last.items.at(-1).id, 'd-0');
  const second = await get('page=2');
  assert.equal(second.items[0].id, 'd-502');
  assert.equal(new Set([...first.items, ...second.items].map((d) => d.id)).size, 40);
  const filtered = await get('campaignId=one&status=accepted&q=BUYER-1&pageSize=10&page=2');
  assert.equal(filtered.total, 56);
  assert.equal(filtered.items.length, 10);
  assert.ok(filtered.items.every((d) => d.campaignId === 'one' && d.to.includes('buyer-1')));
  assert.equal((await get('q=100%25_match')).total, 523);
  assert.equal((await get('q=sales')).total, 523);
  assert.equal((await get('q=客户%20522')).items[0].id, 'd-522');
  const empty = await get('q=missing&page=999');
  assert.deepEqual(empty, { items: [], total: 0, page: 1, pageSize: 20, totalPages: 1 });
  assert.equal((await get('page=999')).page, 27);
  for (const invalid of ['-1', '1.5', 'NaN', 'Infinity']) {
    const result = await get(`page=${invalid}&pageSize=${invalid}`);
    assert.equal(result.page, 1);
    assert.equal(result.pageSize, 20);
  }
});

test('发送记录搜索保留国际客户名称的Unicode大小写匹配', (t) => {
  const service = new OutreachService({ mailboxes: { list: () => [] } });
  t.after(() => service.close());
  service.putDelivery({
    id: 'unicode',
    campaignId: 'one',
    status: 'draft',
    companyName: 'ÉLAN Windows',
    subject: 'Über Fenster',
  });
  assert.equal(service.listDeliveries({ q: 'élan' }).total, 1);
  assert.equal(service.listDeliveries({ q: 'über' }).items[0].id, 'unicode');
});

test('沟通中心状态统计全部发送记录，完整记录和邮箱署名按需读取', async (t) => {
  const logo = 'A'.repeat(100_000);
  const mailbox = {
    id: 'sales',
    email: 'sales@example.org',
    signatureDesign: { logo: { contentBase64: logo } },
  };
  const service = new OutreachService({
    mailboxes: { list: () => [mailbox], get: () => mailbox },
  });
  t.after(() => service.close());
  service.putCampaign({ id: 'campaign', name: 'Plan' });
  for (let index = 0; index < 523; index++)
    service.putDelivery({
      id: `delivery-${index}`,
      campaignId: 'campaign',
      status: index < 510 ? 'accepted' : 'failed',
      candidate: { evidence: 'full candidate' },
      bodyText: 'Full email content',
    });
  const state = await service.state();
  assert.equal(state.deliveryStats.total, 523);
  assert.equal(state.deliveryStats.accepted, 510);
  assert.equal(state.deliveryStats.failed, 13);
  assert.equal(state.deliveries, undefined);
  assert.equal(state.mailboxes[0].signatureDesign, undefined);
  assert.equal(service.listDeliveries().items[0].candidate, undefined);
  assert.equal(service.listDeliveries().items[0].bodyText, 'Full email content');
  assert.equal(service.detail('campaign').deliveries[0].candidate.evidence, 'full candidate');
  const mailboxDetail = await handleOutreach({
    request: { method: 'GET' },
    url: new URL('http://localhost/api/v1/outreach/mailboxes/sales'),
    service,
  });
  assert.equal(mailboxDetail.signatureDesign.logo.contentBase64, logo);
});
