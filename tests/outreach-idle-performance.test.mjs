import test from 'node:test';
import assert from 'node:assert/strict';
import { OutreachService } from '../server/outreach-service.mjs';
import { saveSequencePolicy } from '../server/outreach-sequence-policy.mjs';

test('idle outreach ticks count history without loading historical message bodies', async () => {
  const service = new OutreachService({ mailboxes: { list: () => [] } });
  const now = new Date().toISOString();
  service.putCampaign({
    id: 'history',
    mode: 'production',
    status: 'active',
    scope: 'local',
    continuous: true,
    lastRefreshAt: now,
    targetCount: 100,
  });
  for (const status of ['accepted', 'cancelled', 'unknown', 'blocked', 'skipped'])
    service.putDelivery({
      id: status,
      campaignId: 'history',
      mode: 'production',
      status,
      ...(status === 'unknown' ? { reconciliation: { at: now, result: 'unconfirmed' } } : {}),
      bodyText: status === 'blocked' ? 'Pending review' : 'HISTORICAL_MESSAGE_BODY',
    });
  const db = service.db;
  let historicalBodiesRead = 0;
  service.db = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        get: (...args) => statement.get(...args),
        run: (...args) => statement.run(...args),
        all(...args) {
          const rows = statement.all(...args);
          historicalBodiesRead += rows.filter((row) =>
            row.data?.includes('HISTORICAL_MESSAGE_BODY'),
          ).length;
          return rows;
        },
      };
    },
  };
  try {
    await service.runTick();
    assert.deepEqual(service.campaigns()[0].stats, {
      draft: 0,
      queued: 0,
      accepted: 1,
      failed: 0,
      unknown: 1,
      blocked: 1,
      skipped: 1,
      sending: 0,
    });
    assert.equal(
      historicalBodiesRead,
      0,
      'idle ticks must not load completed/cancelled mail bodies',
    );
  } finally {
    service.db = db;
    await service.close();
  }
});

test('未来十二步逐客户检查接管和退订，不加载全部跟进记录或发送邮件', async (t) => {
  const now = Date.UTC(2026, 1, 1);
  const mailbox = { id: 'team', email: 'team@example.org' };
  const send = t.mock.fn();
  const service = new OutreachService({
    now: () => now,
    mailboxes: { list: () => [mailbox], get: () => mailbox, send },
    customerMailState: (id) => ({
      context: { doNotContact: id === 'unsubscribed' },
      conversations: id === 'managed' ? [{ ownership: 'human' }] : [],
      demands: [],
    }),
  });
  t.after(() => service.close());
  const policy = saveSequencePolicy(service, {
    revision: 1,
    name: '十二步',
    steps: Array.from({ length: 12 }, (_, i) => ({ day: i + 1, instruction: '确认需求' })),
  });
  const campaign = service.putCampaign({
    id: 'campaign',
    scope: 'local',
    mode: 'production',
    status: 'completed',
    followUpEnabled: true,
  });
  for (const customerId of ['interested', 'managed', 'unsubscribed']) {
    const to = customerId + '@buyer.example';
    const first = service.putDelivery({
      id: customerId,
      customerId,
      campaignId: campaign.id,
      status: 'accepted',
      mode: 'production',
      mailboxId: mailbox.id,
      from: mailbox.email,
      to,
      messageId: '<' + customerId + '@example.org>',
      sentAt: new Date(now).toISOString(),
      sequencePolicyRevision: policy.revision,
      candidate: { customerId, to },
      subject: 'Specifications',
      bodyText: 'Here are the specifications.',
    });
    service.followUps.schedule(first, campaign);
  }
  const fullReads = t.mock.method(service.followUps, 'all');
  await service.followUps.tick();
  assert.equal(fullReads.mock.callCount(), 0);
  assert.equal(send.mock.callCount(), 0);
  assert.deepEqual(
    service.followUps.pending().map((step) => step.customerId),
    Array(12).fill('interested'),
  );
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM outreach_followups WHERE state='cancelled'").get()
      .n,
    24,
  );
});
