import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { FollowUpFeishu, followUpEnvironment } from '../server/follow-up-feishu.mjs';
import { safeWrite, sameFields } from '../server/customer-business-feishu.mjs';
import { fieldText } from '../server/feishu.mjs';

const beijingDay = (time) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(time));

export function referenceRows(mailboxes, deliveries, markdown, day) {
  const owners = mailboxes.map((mailbox) => {
    assert(
      mailbox.email && mailbox.displayName && Number.isInteger(mailbox.dailyLimit),
      '邮箱业务资料不完整',
    );
    const sent = deliveries.filter(
      (row) =>
        row.mailboxId === mailbox.id &&
        row.status === 'accepted' &&
        row.sentAt &&
        beijingDay(row.sentAt) === day,
    ).length;
    return {
      业务员名称: mailbox.displayName,
      账号类型: '邮箱账号',
      '账号地址/号码': mailbox.email,
      每日发送额度: mailbox.dailyLimit,
      今日已发送数量: sent,
      账号状态: mailbox.paused ? '暂停' : mailbox.verification?.smtpVerified ? '正常' : null,
      备注: `本地邮箱配置；品牌：${mailbox.brandName || ''}。今日已发送数量为 ${day} 北京时间本地留存的成功发送数。`,
    };
  });
  const templates = markdown
    .split(/\r?\n/)
    .filter((line) => /^\|\s*[123]\s*\|/.test(line))
    .map((line) => {
      const cells = line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim());
      const [scenario, grade] = cells[2].split('／');
      assert(
        /^首次开发邮件-[ABC]类客户$/.test(scenario) && ['A', 'B', 'C'].includes(grade),
        '首次开发模板场景不符',
      );
      return {
        模板名称: cells[1],
        沟通场景: scenario,
        适用客户等级: grade,
        沟通目标: cells[3],
        模板主体文案: cells[4],
        提示词附加业务指引: cells[5],
        启用状态: '停用',
        模板类型: '邮件模板',
        适用开发阶段: '首封开发',
        备注: '2026-11-06 用户确认的模板草稿；本次从本地填写，初始停用。',
      };
    });
  assert(templates.length === 3, '应找到三条已确认的首次开发模板');
  return { owners, templates };
}

async function main() {
  assert(
    process.argv.slice(2).every((arg) => arg === '--write'),
    '仅支持 --write；省略时预览',
  );
  const folder = process.env.OUTREACH_DATA_DIR || '.data/outreach';
  const mailboxes = JSON.parse(readFileSync(resolve(folder, 'mailboxes.json'), 'utf8')).mailboxes;
  const db = new DatabaseSync(process.env.OUTREACH_DB_PATH || resolve(folder, 'outreach.sqlite'), {
    readOnly: true,
  });
  let deliveries;
  try {
    deliveries = db
      .prepare('SELECT data FROM outreach_deliveries')
      .all()
      .map((r) => JSON.parse(r.data));
  } finally {
    db.close();
  }
  const day = beijingDay(Date.now());
  const rows = referenceRows(
    mailboxes,
    deliveries,
    readFileSync('docs/new-feishu-bitable-filling-spec.md', 'utf8'),
    day,
  );
  const mirror = new FollowUpFeishu({
    env: followUpEnvironment(process.env),
    journalPath: '.data/follow-up-reference-journal.json',
  });
  const { related } = await mirror.definition();
  const plans = [];
  for (const [kind, relation, key] of [
    ['owners', '负责业务员', '账号地址/号码'],
    ['templates', '使用模板', '模板名称'],
  ]) {
    const table = related[relation];
    const [fields, records] = await Promise.all([
      mirror.client.fields(table),
      mirror.client.records(table),
    ]);
    for (const row of rows[kind]) {
      for (const [name, value] of Object.entries(row)) {
        const field = fields.find((f) => f.field_name === name);
        assert(field && [1, 2, 3].includes(field.type), '填写字段不符合目标结构：' + name);
        if (field.type === 3 && value !== null)
          assert(
            field.property.options.some((o) => o.name === value),
            '目标表缺少选项：' + value,
          );
      }
      const matches = records.filter(
        (r) => fieldText(r.fields[key]).toLowerCase() === row[key].toLowerCase(),
      );
      assert(matches.length <= 1, '目标表存在重复记录：' + row[key]);
      if (kind === 'templates' && matches[0])
        assert(
          fieldText(matches[0].fields.沟通场景) === row.沟通场景,
          '同名模板场景不同，请先核对',
        );
      plans.push({ table, fields, key, row, record: matches[0], kind });
    }
  }
  console.log(
    JSON.stringify(
      {
        day,
        write: process.argv.includes('--write'),
        records: plans.map((p) => ({
          table: p.table,
          action: p.record ? 'update' : 'insert',
          fields: p.row,
        })),
      },
      null,
      2,
    ),
  );
  if (!process.argv.includes('--write')) return;
  for (const plan of plans) {
    const key = `${mirror.scope}:${plan.table}:${plan.row[plan.key]}`;
    const digest = createHash('sha256').update(key).digest('hex');
    const token = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    await safeWrite(
      {
        journal: mirror.journal,
        checkpoint: () => mirror.persistJournal(),
        retry: Boolean(plan.record),
      },
      key,
      async () => {
        plan.record = await mirror.client.write(
          plan.record ? 'update' : 'insert',
          plan.row,
          plan.record?.record_id,
          token,
          plan.table,
        );
      },
      async () => {
        const records = plan.record
          ? [await mirror.client.record(plan.record.record_id, plan.table)]
          : (await mirror.client.records(plan.table)).filter(
              (r) =>
                fieldText(r.fields[plan.key]).toLowerCase() === plan.row[plan.key].toLowerCase(),
            );
        assert(records.length <= 1, '目标表记录重复');
        if (!records[0] || !sameFields(records[0], plan.row, plan.fields)) return false;
        plan.record = records[0];
        return true;
      },
    );
  }
  console.log(
    JSON.stringify({
      status: 'verified',
      owners: rows.owners.length,
      templates: rows.templates.length,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main();
