import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { OutreachService } from '../server/outreach-service.mjs';

const script = fileURLToPath(
  new URL('../scripts/skip-missing-email-deliveries.mjs', import.meta.url),
);
const reason = '客户库中没有格式有效且适合商务联系的邮箱';

test('一次性整理只改无邮箱未提交空记录：默认只读，备份、保留其他事实、重复执行不新增', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'outreach-cleanup-'));
  const path = join(dir, 'outreach.sqlite');
  const backupPath = join(dir, 'before.sqlite');
  const service = new OutreachService({ path, mailboxes: { list: () => [] } });
  const original = new Map();
  const run = (...args) =>
    spawnSync(process.execPath, [script, '--db', path, ...args], { encoding: 'utf8' });
  const read = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare('SELECT id,data FROM outreach_deliveries').all();
    } finally {
      db.close();
    }
  };
  try {
    service.putCampaign({
      id: 'plan',
      status: 'active',
      lastError: `暂未生成邮件。2 家：${reason}。请打开“执行详情”查看。`,
    });
    const cases = [
      ['eligible', {}],
      ['other-block', { reason: '请先配置并确认该邮箱的发件签名' }],
      ['generated', { subject: 'Draft', bodyText: 'Content' }],
      ['attempted', { attemptedAt: '2026-11-01T00:00:00Z' }],
      ['message', { messageId: '<mail@example.org>' }],
      ['sent-time', { sentAt: '2026-11-01T00:00:00Z' }],
      ['reserved', {}],
      ['material', { materialRefresh: true }],
      ['internal', { mode: 'internal_test' }],
      ...['sending', 'accepted', 'unknown', 'failed', 'cancelled'].map((status) => [
        status,
        { status },
      ]),
    ];
    for (const [id, extra] of cases) {
      const d = {
        id,
        campaignId: 'plan',
        customerId: id,
        companyName: `Buyer ${id}`,
        mode: 'production',
        status: 'blocked',
        reason,
        createdAt: '2026-11-01T00:00:00Z',
        ...extra,
      };
      service.putDelivery(d);
      original.set(id, JSON.stringify(d));
    }
    service.db
      .prepare('INSERT INTO outreach_reservations VALUES(?,?)')
      .run('company:reserved', 'reserved');
    await service.close();
    const preview = run();
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).matched, 1);
    assert.deepEqual(
      read().map((row) => row.data),
      [...original.values()],
    );
    assert.notEqual(run('--apply').status, 0);
    const applied = run('--apply', '--backup', backupPath);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(JSON.parse(applied.stdout).updated, 1);
    const backupDb = new DatabaseSync(backupPath, { readOnly: true });
    assert.equal(
      backupDb.prepare('SELECT data FROM outreach_deliveries WHERE id=?').get('eligible').data,
      original.get('eligible'),
    );
    backupDb.close();
    for (const row of read()) {
      if (row.id !== 'eligible') assert.equal(row.data, original.get(row.id));
      else {
        const { skippedAt, reasonCode, ...d } = JSON.parse(row.data);
        assert.ok(skippedAt);
        assert.equal(reasonCode, 'contact_unverified');
        assert.deepEqual(d, { ...JSON.parse(original.get(row.id)), status: 'skipped' });
      }
    }
    assert.equal(JSON.parse(run().stdout).matched, 0);
    assert.notEqual(run('--apply', '--backup', backupPath).status, 0, '不能覆盖已有备份');
    const reopened = new OutreachService({
      path,
      mailboxes: { list: () => [] },
      loadLeads: async () => [{ id: 'eligible' }],
    });
    try {
      assert.equal(reopened.delivery('eligible').status, 'skipped');
      assert.equal(reopened.listDeliveries({ group: 'skipped' }).total, 1);
      assert.equal(
        reopened.db.prepare('SELECT count(*) AS n FROM outreach_reservations').get().n,
        1,
      );
      assert.equal(
        reopened.campaign('plan').lastError,
        `暂未生成邮件。7 家：${reason}；1 家：请先配置并确认该邮箱的发件签名。请打开“执行详情”查看。`,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    if (!service.closed) await service.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
