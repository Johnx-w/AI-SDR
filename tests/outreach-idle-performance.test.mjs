import test from 'node:test';
import assert from 'node:assert/strict';
import { OutreachService } from '../server/outreach-service.mjs';

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
