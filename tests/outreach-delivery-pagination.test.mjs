import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutreachService } from '../server/outreach-service.mjs';
import { handleOutreach } from '../server/outreach-api.mjs';
import { deliveryGroup } from '../src/domain/outreach-status.mjs';

test('网页计划按真实状态和注意项先筛选再分页，仅返回可见行；索引统计不排序邮件正文', async (t) => {
  const service = new OutreachService({
    mailboxes: { list: () => [] },
    acquisitionSources: () => assert.fail('网页不读取获客任务'),
  });
  t.after(() => service.close());
  const plans = [];
  const prepare = service.db.prepare.bind(service.db);
  service.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.startsWith('SELECT') && sql.includes('INDEXED BY outreach_counts')) {
      const original = statement.all.bind(statement);
      statement.all = (...args) => {
        plans.push({
          sql,
          plan: prepare('EXPLAIN QUERY PLAN ' + sql)
            .all(...args)
            .map((row) => row.detail)
            .join(';'),
        });
        return original(...args);
      };
    }
    return statement;
  };
  for (let index = 0; index < 25; index++) {
    const campaignId = `plan-${index}`;
    service.putCampaign({
      id: campaignId,
      name: `Buyer ${index}`,
      mode: 'production',
      status: index === 24 ? 'completed' : 'active',
      customerIds: ['one'],
      productScopes: [{ facts: 'private to the plan details' }],
    });
    service.putDelivery({
      id: `delivery-${index}`,
      campaignId,
      status: index % 2 ? 'draft' : 'accepted',
      subject: 'Ready',
      companyName: 'Buyer',
      candidate: { evidence: 'x'.repeat(1000) },
    });
  }
  const read = (params) => service.state(new URLSearchParams(params));
  const page = await read('view=current&status=attention&q=BUYER&page=2&pageSize=10');
  assert.deepEqual({ ...page.counts }, { total: 25, active: 24 });
  assert.equal(page.filtered, 12);
  assert.deepEqual(
    page.campaigns.map((row) => row.id),
    ['plan-3', 'plan-1'],
  );
  assert.equal(page.campaigns[0].customerCount, 1);
  assert.ok(!('productScopes' in page.campaigns[0]));
  assert.equal((await read('view=history')).campaigns[0].id, 'plan-24');
  assert.deepEqual((await read('view=mailboxes')).campaigns, []);
  const global = plans.find(
    ({ sql }) => sql.includes('GROUP BY campaign_id') && !sql.includes('WHERE campaign_id='),
  );
  assert.match(global.plan, /outreach_counts/);
  assert.doesNotMatch(global.plan, /TEMP B-TREE/);
});

test('计划记录和状态计数包含已取消及已跳过', async (t) => {
  const service = new OutreachService({ mailboxes: { list: () => [] } });
  t.after(() => service.close());
  service.putCampaign({ id: 'cancelled-plan', status: 'cancelled' });
  for (const status of ['accepted', 'unknown', 'failed', 'cancelled', 'skipped'])
    service.putDelivery({ id: status, campaignId: 'cancelled-plan', status, companyName: 'Buyer' });
  assert.equal((await service.state()).deliveryStats.total, 5);
  assert.equal(service.detail('cancelled-plan').deliveries.length, 5);
});

test('计划统计区分六类发送状态，已核实未发出不再计需处理', async (t) => {
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
    bodyText: 'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
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
    { id: 'forwarded' },
    { id: 'legacy' },
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
  service.conversations.putMessage(
    mailbox,
    makeNote('forwarded', {
      inReplyTo: '<forwarded@example.org>',
      bodyText:
        'Final-Recipient: rfc822; downstream@host.example\nDiagnostic-Code: smtp; 550 5.1.1 User unknown',
    }),
  );
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
  // Upgrade an existing timestamp-only history, including a row without a cached notice.
  service.db.exec(
    "DROP TABLE outreach_delivery_bounces; CREATE TABLE outreach_delivery_bounces(delivery_id TEXT PRIMARY KEY, received_at TEXT NOT NULL); INSERT INTO outreach_delivery_bounces VALUES('aliyun','2026-11-18T02:00:00.000Z'),('legacy','2026-11-18T02:00:00.000Z')",
  );
  await service.close();
  service = open();
  const call = (path, method = 'GET') =>
    handleOutreach({
      request: { method },
      url: new URL(`http://localhost/api/v1/outreach${path}`),
      readJson: async () => ({ mailboxId: mailbox.id }),
      service,
    });
  assert.equal((await call('/deliveries/legacy')).bouncedAt, occurredAt);
  assert.equal((await call('/deliveries/legacy')).bounce, null);
  assert.equal((await call('/deliveries/aliyun')).bouncedAt, occurredAt);
  await call('/conversations/sync', 'POST');
  await call('/conversations/sync', 'POST');
  for (const id of ['ambiguous-1', 'ambiguous-2', 'unaffected'])
    assert.equal((await call('/deliveries/' + id)).bouncedAt, undefined, id);
  const detail = await call('/deliveries/dsn');
  assert.equal(detail.status, 'accepted');
  assert.equal(detail.bouncedAt, occurredAt);
  assert.equal(detail.bounce.category, 'invalid');
  assert.ok(service.isReserved({ to: 'dsn@buyer.example' }));
  assert.equal((await call('/deliveries/aliyun')).bounce.category, 'temporary');
  assert.equal(service.isReserved({ to: 'aliyun@buyer.example' }), false);
  assert.equal(
    service.db.prepare('SELECT count(*) AS n FROM outreach_delivery_bounces').get().n,
    4,
  );
  assert.equal((await call('/deliveries/forwarded')).bounce.category, 'unknown');
  assert.equal(service.isReserved({ to: 'forwarded@buyer.example' }), false);
  assert.equal(detail.bodyText, 'Original outgoing body');
  assert.equal((await service.state()).deliveryStats.accepted, 7);
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
  assert.equal(service.deliveryRecord('delivery-522').bodyText, 'Full email content');
  assert.equal(service.detail('campaign').deliveries[0].candidate.evidence, 'full candidate');
  const mailboxDetail = await handleOutreach({
    request: { method: 'GET' },
    url: new URL('http://localhost/api/v1/outreach/mailboxes/sales'),
    service,
  });
  assert.equal(mailboxDetail.signatureDesign.logo.contentBase64, logo);
});

test('退信按主要诊断解释，附带码不覆盖明确的无效地址诊断', async () => {
  const { bounceDiagnosis } = await import('../server/outreach-bounces.mjs');
  for (const [response, category] of [
    ['550 5.1.1 User unknown (nested 5.4.1)', 'invalid'],
    ['resolving by dns failed', 'dns'],
    ['connect to the receiving server failed', 'connection'],
    ['421 4.3.2 Maximum concurrent connections exceeded', 'temporary'],
    ['550 5.4.1 Recipient address rejected: Access denied', 'access'],
    ['550 5.7.1 Relay access denied', 'policy'],
    ['451 4.4.1 Connection timed out', 'connection'],
    ['450 4.4.3 DNS lookup failed', 'dns'],
    ['550 5.1.11 Bad sender syntax', 'unknown'],
    ['Delivery failed', 'unknown'],
  ]) {
    const diagnosis = bounceDiagnosis({
      from: 'no-reply@mailsupport.aliyun.com',
      bodyText: '系统应答: ' + response + '\n退信原因: 系统退回',
    });
    assert.equal(diagnosis.category, category);
    assert.ok(diagnosis.diagnostic.includes(response));
    assert.ok(diagnosis.action);
  }
});
