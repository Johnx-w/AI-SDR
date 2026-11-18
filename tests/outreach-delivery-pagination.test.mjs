import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutreachService } from '../server/outreach-service.mjs';
import { handleOutreach } from '../server/outreach-api.mjs';
import { deliveryGroup } from '../src/domain/outreach-status.mjs';

test('全部发送记录和入口总数包含已取消及已跳过', async (t) => {
  const service = new OutreachService({ mailboxes: { list: () => [] } });
  t.after(() => service.close());
  service.putCampaign({ id: 'cancelled-plan', status: 'cancelled' });
  for (const status of ['accepted', 'unknown', 'failed', 'cancelled', 'skipped'])
    service.putDelivery({ id: status, campaignId: 'cancelled-plan', status, companyName: 'Buyer' });
  assert.equal(service.listDeliveries().total, 5);
  assert.equal(service.listDeliveries({ q: 'Buyer' }).total, 5);
  assert.equal((await service.state()).deliveryStats.total, 5);
  assert.deepEqual(
    service.listDeliveries({ group: 'cancelled' }).items.map((row) => row.id),
    ['cancelled'],
  );
  assert.equal(service.listDeliveries({ status: 'cancelled' }).total, 1);
  assert.equal(service.listDeliveries({ status: 'skipped' }).total, 1);
  assert.equal(service.listDeliveries({ group: 'skipped', q: 'Buyer' }).total, 1);
  assert.equal(service.detail('cancelled-plan').deliveries.length, 5);
});

test('六类发送状态先跨记录筛选再分页，已核实未发出不再计需处理', async (t) => {
  const service = new OutreachService({ mailboxes: { list: () => [] } });
  t.after(() => service.close());
  service.putCampaign({ id: 'one', name: 'Plan' });
  const cases = [
    ['draft', '', 'pending'],
    ['draft', 'Needs approval', 'attention'],
    ['queued', 'Queued', 'pending'],
    ['sending', 'Submitting', 'pending'],
    ['accepted', 'Accepted', 'sent'],
    ['blocked', 'Blocked', 'attention'],
    ['failed', 'Rejected', 'attention'],
    ['failed', 'Checked', 'resolved'],
    ['unknown', 'Uncertain', 'attention'],
    ['cancelled', 'Cancelled', 'cancelled'],
    ['skipped', '', 'skipped'],
  ];
  for (let i = 0; i < 12; i++) {
    for (const [status, subject, group] of cases) {
      const delivery = {
        id: `${i}-${status}-${group}`,
        campaignId: 'one',
        status,
        subject,
        ...(group === 'resolved' ? { resolution: { outcome: 'failed' } } : {}),
      };
      assert.equal(deliveryGroup(delivery), group);
      service.putDelivery(delivery);
    }
  }
  const expected = {
    pending: 36,
    sent: 12,
    attention: 48,
    resolved: 12,
    skipped: 12,
    cancelled: 12,
  };
  assert.deepEqual((await service.state()).deliveryGroups, expected);
  assert.deepEqual(service.detail('one').campaign.deliveryGroups, expected);
  for (const [group, total] of Object.entries(expected)) {
    const result = await handleOutreach({
      request: { method: 'GET' },
      url: new URL(`http://localhost/api/v1/outreach/deliveries?group=${group}&page=2&pageSize=10`),
      service,
    });
    assert.equal(result.total, total);
    assert.equal(result.page, 2);
    assert.equal(result.items.length, Math.min(10, total - 10));
    assert.ok(result.items.every((delivery) => deliveryGroup(delivery) === group));
  }
  assert.equal(service.listDeliveries({ group: 'attention', status: 'unknown' }).total, 12);
  assert.equal(service.listDeliveries({ group: 'pending', q: 'Submitting' }).total, 12);
  assert.throws(() => service.listDeliveries({ group: 'invalid' }), { status: 400 });
});

test('发送失败包括缓存和新同步的退信，同一封邮件只计一条并保留SMTP结果', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'outreach-bounces-'));
  const mailbox = { id: 'sales', email: 'sales@example.org', configured: true };
  const alternate = { ...mailbox, email: 'other@example.org' };
  const sentAt = '2026-11-18T01:00:00.000Z';
  const occurredAt = '2026-11-18T02:00:00.000Z';
  const makeNote = (id, patch) => ({
    messageId: `<notice-${id}@example.org>`,
    direction: 'inbound',
    from: 'mailer-daemon@example.org',
    to: mailbox.email,
    subject: 'Delivery Status Notification (Failure)',
    bodyText: 'Your message could not be delivered.',
    occurredAt,
    source: 'imap',
    ...patch,
  });
  const open = () =>
    new OutreachService({
      path: join(folder, 'outreach.sqlite'),
      mailboxes: {
        list: () => [mailbox],
        readMailbox: async () => ({
          folders: [
            {
              path: 'INBOX',
              uidValidity: '1',
              nextUid: 3,
              messages: [
                makeNote('dsn', { uid: 1, inReplyTo: '<dsn@example.org>' }),
                makeNote('dsn-copy', { uid: 2, inReplyTo: '<dsn@example.org>' }),
              ],
            },
          ],
        }),
      },
    });
  let service = open();
  t.after(async () => {
    await service.close();
    rmSync(folder, { recursive: true, force: true });
  });
  service.putCampaign({ id: 'one', name: 'Plan' });
  for (const delivery of [
    { id: 'failed', status: 'failed' },
    { id: 'confirmed-failed', status: 'failed', resolution: { outcome: 'failed' } },
    { id: 'aliyun' },
    { id: 'dsn' },
    { id: 'unaffected' },
    { id: 'ambiguous-1', to: 'same@buyer.example' },
    { id: 'ambiguous-2', to: 'same@buyer.example' },
  ])
    service.putDelivery({
      campaignId: 'one',
      status: 'accepted',
      mailboxId: mailbox.id,
      from: mailbox.email,
      to: `${delivery.id}@buyer.example`,
      subject: 'Products',
      sentAt,
      messageId: `<${delivery.id}@example.org>`,
      bodyText: 'Original outgoing body',
      ...delivery,
    });
  const aliyunNote = (id, recipient) =>
    makeNote(id, {
      from: 'no-reply@mailsupport.aliyun.com',
      subject: '来自【企业邮箱】的退信',
      bodyText: `很抱歉您发送的邮件被退回，以下是该邮件的相关信息：
  发件人 : [${mailbox.email}]
  主题 : Products
  原文 : 邮件原文包含在附件中。
无法发送到 [${recipient}]

退信原因
  系统应答: 421 4.3.2 Delivery failed`,
    });
  service.conversations.putMessage(mailbox, aliyunNote('aliyun', 'aliyun@buyer.example'));
  service.conversations.putMessage(mailbox, aliyunNote('ambiguous', 'same@buyer.example'));
  service.conversations.putMessage(
    mailbox,
    makeNote('delayed', {
      inReplyTo: '<unaffected@example.org>',
      subject: 'Delivery Status Notification (Delay)',
    }),
  );
  service.conversations.putMessage(
    mailbox,
    makeNote('too-early', {
      inReplyTo: '<unaffected@example.org>',
      occurredAt: '2026-11-18T00:00:00.000Z',
    }),
  );
  service.conversations.putMessage(
    alternate,
    makeNote('wrong-identity', {
      inReplyTo: '<unaffected@example.org>',
      to: alternate.email,
    }),
  );
  service.conversations.putMessage(mailbox, {
    ...aliyunNote('ordinary', 'unaffected@buyer.example'),
    from: 'unaffected@buyer.example',
  });
  // Reopen the cache in the layout used before bounce tracking was added.
  service.db.exec('DROP TABLE IF EXISTS outreach_delivery_bounces');
  await service.close();
  service = open();
  const call = (path, method = 'GET') =>
    handleOutreach({
      request: { method },
      url: new URL(`http://localhost/api/v1/outreach${path}`),
      readJson: async () => ({ mailboxId: mailbox.id }),
      service,
    });
  const historical = await call('/deliveries?group=failed');
  assert.equal(historical.total, 3);
  assert.equal(historical.items.find((d) => d.id === 'aliyun')?.bouncedAt, occurredAt);
  await call('/conversations/sync', 'POST');
  const failed = await call('/deliveries?group=failed');
  assert.deepEqual(
    failed.items.map(({ id }) => id),
    ['dsn', 'aliyun', 'confirmed-failed', 'failed'],
  );
  assert.deepEqual(
    (await call('/deliveries?group=sent')).items.map(({ id }) => id),
    ['ambiguous-2', 'ambiguous-1', 'unaffected'],
  );
  const detail = await call('/deliveries/dsn');
  assert.equal(detail.status, 'accepted');
  assert.equal(detail.bouncedAt, occurredAt);
  assert.equal(detail.bodyText, 'Original outgoing body');
  assert.equal((await call('/deliveries?group=failed&q=dsn@buyer.example')).total, 1);
  assert.equal((await service.state()).deliveryStats.accepted, 5);
});

test('发送记录分页能访问超过最近500条的历史，先筛选再分页并限制无效页码', async (t) => {
  const service = new OutreachService({ mailboxes: { list: () => [] } });
  t.after(() => service.close());
  for (let i = 0; i < 523; i++)
    service.putDelivery({
      id: `d-${i}`,
      campaignId: i % 2 ? 'one' : 'two',
      status: i % 2 ? 'accepted' : 'failed',
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
  const filtered = await get('status=accepted&q=BUYER-1&pageSize=10&page=2');
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
  assert.equal(service.listDeliveries().items[0].bodyText, undefined);
  assert.equal(service.deliveryRecord('delivery-522').bodyText, 'Full email content');
  assert.equal(service.detail('campaign').deliveries[0].candidate.evidence, 'full candidate');
  const mailboxDetail = await handleOutreach({
    request: { method: 'GET' },
    url: new URL('http://localhost/api/v1/outreach/mailboxes/sales'),
    service,
  });
  assert.equal(mailboxDetail.signatureDesign.logo.contentBase64, logo);
});
