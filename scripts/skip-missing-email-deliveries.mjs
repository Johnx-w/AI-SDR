import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync, backup } from 'node:sqlite';

// One-time offline cleanup; never instantiate the mail worker here.
const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    apply: { type: 'boolean', default: false },
    backup: { type: 'string' },
  },
});
assert(
  values.db,
  '用法：node scripts/skip-missing-email-deliveries.mjs --db <数据库路径> [--apply --backup <新备份路径>]',
);
const path = resolve(values.db);
assert(existsSync(path), '数据库不存在');
const backupPath = values.backup && resolve(values.backup);
if (values.apply) {
  assert(
    backupPath && backupPath !== path && !existsSync(backupPath),
    '应用前须指定尚不存在的独立备份路径',
  );
}
const reason = '客户库中没有格式有效且适合商务联系的邮箱';
const db = new DatabaseSync(path, { readOnly: !values.apply });
try {
  const blocked = db
    .prepare("SELECT id,campaign_id,data FROM outreach_deliveries WHERE state='blocked'")
    .all();
  const matching = blocked.filter((row) => JSON.parse(row.data).reason === reason);
  const selected = matching.filter((row) => {
    const d = JSON.parse(row.data);
    return (
      d.id === row.id &&
      d.campaignId === row.campaign_id &&
      d.status === 'blocked' &&
      d.mode === 'production' &&
      d.customerId &&
      !d.to &&
      !d.from &&
      !d.subject &&
      !d.bodyText &&
      !d.bodyHtml &&
      !d.attemptedAt &&
      !d.messageId &&
      !d.sentAt &&
      !d.materialRefresh &&
      !db.prepare('SELECT 1 FROM outreach_reservations WHERE delivery_id=?').get(row.id)
    );
  });
  const report = {
    database: path,
    mode: values.apply ? 'apply' : 'preview',
    matched: selected.length,
    excluded: matching.length - selected.length,
    records: selected.map((row) => {
      const d = JSON.parse(row.data);
      return {
        id: row.id,
        campaignId: row.campaign_id,
        customerId: d.customerId,
        companyName: d.companyName,
        reason: d.reason,
        createdAt: d.createdAt,
      };
    }),
  };
  if (values.apply) {
    await backup(db, backupPath);
    db.exec('BEGIN IMMEDIATE');
    try {
      const skippedAt = new Date().toISOString();
      for (const row of selected) {
        const data = {
          ...JSON.parse(row.data),
          status: 'skipped',
          reasonCode: 'contact_unverified',
          skippedAt,
        };
        const result = db
          .prepare(
            "UPDATE outreach_deliveries SET state='skipped',data=? WHERE id=? AND state='blocked' AND data=?",
          )
          .run(JSON.stringify(data), row.id, row.data);
        assert.equal(result.changes, 1, '记录已变化，请停止服务后重新预览');
      }
      for (const campaignId of new Set(selected.map((row) => row.campaign_id))) {
        const row = db.prepare('SELECT data FROM outreach_campaigns WHERE id=?').get(campaignId);
        assert(row, '记录所属计划不存在');
        const campaign = JSON.parse(row.data);
        if (
          !campaign.lastError?.startsWith('暂未生成邮件。') ||
          !campaign.lastError.includes(reason)
        )
          continue;
        const reasons = new Map();
        for (const remaining of db
          .prepare("SELECT data FROM outreach_deliveries WHERE campaign_id=? AND state='blocked'")
          .all(campaignId)) {
          const message = JSON.parse(remaining.data).reason || '条件尚未补齐';
          reasons.set(message, (reasons.get(message) || 0) + 1);
        }
        const summary = [...reasons]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([message, count]) => `${count} 家：${message}`)
          .join('；');
        campaign.lastError = summary ? `暂未生成邮件。${summary}。请打开“执行详情”查看。` : '';
        db.prepare('UPDATE outreach_campaigns SET data=? WHERE id=?').run(
          JSON.stringify(campaign),
          campaignId,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    report.backup = backupPath;
    report.updated = selected.length;
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
