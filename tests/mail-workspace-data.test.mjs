import test from 'node:test';
import assert from 'node:assert/strict';
import { OutreachService } from '../server/outreach-service.mjs';
import { handleOutreach } from '../server/outreach-api.mjs';
import { siteAllowsProduct } from '../src/domain/mail-site.mjs';
function api(t) {
  const mailbox = {
    id: 'box',
    website: 'https://dealer.test',
    brandName: 'Dealer',
    email: 'sales@dealer.test',
  };
  const service = new OutreachService({ mailboxes: { list: () => [mailbox] } });
  t.after(() => service.close());
  const call = (path, method = 'GET', body) =>
    handleOutreach({
      request: { method },
      url: new URL('/api/v1/outreach' + path, 'http://localhost'),
      service,
      readJson: async () => body,
    });
  return { service, call, mailbox };
}
test('邮箱标签批量增删可重试，合并保留关联，冲突整批回滚', async (t) => {
  const { call } = api(t);
  const a = (await call('/mailbox-tags', 'POST', { name: 'Europe' })).tags[0];
  await assert.rejects(call('/mailbox-tags', 'POST', { name: ' europe ' }), { status: 409 });
  const b = (await call('/mailbox-tags', 'POST', { name: '项目' })).tags.find((x) => x.id !== a.id);
  const assign = { mailboxIds: ['box'], tagIds: [a.id, b.id], action: 'add' };
  for (let i = 0; i < 2; i++)
    assert.equal((await call('/mailbox-tags/assign', 'POST', assign)).assignments.length, 2);
  await assert.rejects(
    call('/mailbox-tags/assign', 'POST', {
      ...assign,
      mailboxIds: ['box', 'removed'],
      action: 'remove',
    }),
    { status: 404 },
  );
  assert.equal((await call('/mailbox-tags')).assignments.length, 2);
  const merged = await call('/mailbox-tags/' + a.id + '/merge', 'POST', { targetId: b.id });
  assert.deepEqual(
    merged.assignments.map((x) => [x.mailboxId, x.tagId]),
    [['box', b.id]],
  );
  await call('/mailbox-tags/' + b.id, 'PATCH', { name: '北美' });
  assert.equal((await call('/mailbox-tags')).tags[0].name, '北美');
  const empty = await call('/mailbox-tags/' + b.id, 'DELETE');
  assert.equal(empty.tags.length + empty.assignments.length, 0);
});
test('跟进序列分页读取正式首封与该客户的两次跟进，不取正文或混入测试计划', async (t) => {
  const { service, call } = api(t);
  service.putCampaign({
    id: 'plan',
    name: '客户开发',
    mode: 'production',
    status: 'active',
    followUpEnabled: true,
    mailboxIds: ['box'],
  });
  service.putCampaign({ id: 'internal', name: '内部验证', mode: 'test', status: 'active' });
  for (let i = 0; i < 24; i++) {
    const d = {
      id: 'mail' + i,
      campaignId: 'plan',
      mode: 'production',
      companyName: 'Company ' + i,
      status: i === 23 ? 'failed' : 'accepted',
      sentAt: new Date(Date.UTC(2026, 1, 1, 0, i)).toISOString(),
      bodyText: 'private long body',
    };
    service.putDelivery(d);
    service.followUps.schedule(d, service.campaign('plan'));
  }
  const list = await call('/sequences');
  assert.equal(list.total, 1);
  assert.equal(list.items[0].firstCount, 23);
  assert.equal(list.items[0].pendingCount, 46);
  const page = await call('/sequences/plan?page=3&pageSize=10');
  assert.equal(page.total, 23);
  assert.equal(page.page, 3);
  assert.equal(page.items.length, 3);
  assert.equal(page.items[0].firstId, 'mail2');
  assert.equal(page.items[0].followUps.length, 2);
  assert.deepEqual(
    page.steps.map((x) => x.offsetHours),
    [0, 72, 168],
  );
  assert.ok(!JSON.stringify(page).includes('private long body'));
  await assert.rejects(call('/sequences/internal'), { status: 404 });
});
test('独立素材可以作为本站回复资料，不进入可推产品', (t) => {
  const { mailbox } = api(t),
    file = { sourceUrl: 'https://dealer.test', brands: ['Dealer'], materialOnly: true };
  assert.equal(siteAllowsProduct(file, mailbox, true), true);
  assert.equal(siteAllowsProduct(file, mailbox, false), false);
});

test('收件箱可翻过第两百段会话，正文搜索及来信筛选使用同一范围', async (t) => {
  const { service, call, mailbox } = api(t);
  for (let i = 0; i < 227; i++) {
    const from = 'client' + i + '@customer.test';
    service.conversations.putMessage(mailbox, {
      identity: 'imap:' + i,
      source: 'imap',
      messageId: '<message' + i + '@customer.test>',
      from,
      to: mailbox.email,
      direction: 'inbound',
      subject: 'Question ' + i,
      occurredAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      bodyText: 'A'.repeat(240) + (i === 2 ? ' CAFÉ blinds' : ''),
    });
  }
  const first = await call('/conversations?inboundOnly=1&pageSize=25&page=1'),
    last = await call('/conversations?inboundOnly=1&pageSize=25&page=10');
  assert.equal(first.total, 227);
  assert.equal(first.items.length, 25);
  assert.equal(last.page, 10);
  assert.equal(last.items.length, 2);
  assert.equal(last.items[1].subject, 'Question 0');
  assert.equal(last.hasMore, false);
  const match = await call('/conversations?q=' + encodeURIComponent('café'));
  assert.equal(match.total, 1);
  assert.equal(match.items[0].subject, 'Question 2');
});
