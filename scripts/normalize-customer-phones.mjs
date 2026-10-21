// Plan first; only --apply writes the reviewed phone changes.
import fs from 'node:fs/promises';
import { FeishuClient } from '../server/feishu-direct.mjs';
import { fieldText } from '../server/feishu.mjs';
import { normalizePhoneLines, selectBusinessPhones } from '../server/phone-format.mjs';
import { extractContacts } from '../server/contact-extractor.mjs';
import { readPublicHtml, websiteUrl } from '../server/branding.mjs';
import { connectionEnvironment } from '../server/api-connections.mjs';
const env = connectionEnvironment();
const client = new FeishuClient({ env });
const path = '.data/customer-phone-cleanup-plan.json';
if (!process.argv.includes('--apply')) {
  const records = await client.records();
  const changes = [],
    unresolved = [];
  for (const record of records) {
    const f = record.fields,
      before = fieldText(f['电话']);
    if (!before.trim()) continue;
    const country = fieldText(f['国家']),
      source = fieldText(f['来源链接']);
    let after = normalizePhoneLines(before, country),
      verifiedSource = false;
    if (before.split('\n').filter(Boolean).length > 3) {
      try {
        let url = websiteUrl(source),
          html = '';
        if (!url) throw new Error('Invalid website');
        const domain = url.hostname.replace(/^www\./, '');
        for (let hop = 0; hop < 4; hop++) {
          const page = await readPublicHtml(url, AbortSignal.timeout(12000));
          if (page.redirect) {
            const next = websiteUrl(page.redirect, url);
            if (!next || next.hostname.replace(/^www\./, '') !== domain)
              throw new Error('Cross-domain redirect');
            url = next;
          } else {
            html = page.html || '';
            break;
          }
        }
        const found = selectBusinessPhones(
          extractContacts({ content: html, sourceUrl: source, country }),
          country,
          source,
        );
        if (found.length) {
          after = found.map((c) => c.value).join('\n');
          verifiedSource = true;
        }
      } catch {
        unresolved.push({ record_id: record.record_id, reason: '来源页读取失败，仅规范已有格式' });
      }
    }
    if (!after) {
      unresolved.push({
        record_id: record.record_id,
        reason: '没有可确定区号的有效号码，保留原字段',
      });
      continue;
    }
    if (after !== before)
      changes.push({ record_id: record.record_id, before, after, verifiedSource });
  }
  await fs.mkdir('.data', { recursive: true });
  const plan = {
    createdAt: new Date().toISOString(),
    table: env.FEISHU_APP_TOKEN + '/' + env.FEISHU_TABLE_ID,
    total: records.length,
    changes,
    unresolved,
  };
  await fs.writeFile(path, JSON.stringify(plan, null, 2));
  console.log(
    JSON.stringify({
      total: records.length,
      changes: changes.length,
      verifiedSources: changes.filter((c) => c.verifiedSource).length,
      unresolved,
    }),
  );
} else {
  const plan = JSON.parse(await fs.readFile(path, 'utf8'));
  if (plan.table !== env.FEISHU_APP_TOKEN + '/' + env.FEISHU_TABLE_ID)
    throw new Error('表格与计划不符');
  const applied = [];
  for (const change of plan.changes) {
    const current = await client.record(change.record_id);
    const value = fieldText(current.fields['电话']);
    if (value === change.after) {
      applied.push(change.record_id);
      continue;
    }
    if (value !== change.before) throw new Error('电话字段已被修改，停止覆盖：' + change.record_id);
    await client.write('update', { 电话: change.after }, change.record_id);
    const readback = await client.record(change.record_id);
    if (fieldText(readback.fields['电话']) !== change.after) throw new Error('电话写入核验失败');
    applied.push(change.record_id);
  }
  await fs.writeFile(
    '.data/customer-phone-cleanup-verified.json',
    JSON.stringify({ at: new Date().toISOString(), applied }, null, 2),
  );
  console.log(JSON.stringify({ verifiedUpdates: applied.length, total: plan.total }));
}
