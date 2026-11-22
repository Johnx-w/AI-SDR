const production = "json_extract(c.data,'$.mode')='production'";
const fields = `c.id,json_extract(c.data,'$.name') AS name,json_extract(c.data,'$.status') AS status,
  json_extract(c.data,'$.mailboxIds') AS mailboxIds,json_extract(c.data,'$.followUpEnabled') AS enabled,
  json_extract(c.data,'$.followUpPaused') AS paused,
  (SELECT count(*) FROM outreach_deliveries d WHERE d.campaign_id=c.id AND d.state='accepted') AS firstCount,
  (SELECT count(*) FROM outreach_followups f WHERE json_extract(f.data,'$.campaignId')=c.id AND f.state='pending') AS pendingCount`;
const summary = ({ mailboxIds, enabled, paused, ...row }) => ({
  ...row,
  mailboxIds: JSON.parse(mailboxIds || '[]'),
  followUpEnabled: !!enabled,
  followUpPaused: !!paused,
});
function pagination(params, total) {
  const pageSize = [10, 20, 50, 100].includes(Number(params.get('pageSize')))
    ? Number(params.get('pageSize'))
    : 20;
  const requested = Number(params.get('page'));
  const page = Math.max(
    1,
    Math.min(Math.ceil(total / pageSize), Number.isSafeInteger(requested) ? requested : 1),
  );
  return { page, pageSize, total };
}
export function listSequences(db, params) {
  const source = `FROM outreach_campaigns c WHERE ${production}`;
  const total = db.prepare('SELECT count(*) AS n ' + source).get().n;
  const result = pagination(params, total);
  const rows = db
    .prepare(`SELECT ${fields} ${source} ORDER BY c.rowid DESC LIMIT ? OFFSET ?`)
    .all(result.pageSize, (result.page - 1) * result.pageSize);
  return { ...result, items: rows.map(summary) };
}
export function sequenceDetail(db, id, params) {
  const row = db
    .prepare(`SELECT ${fields} FROM outreach_campaigns c WHERE c.id=? AND ${production}`)
    .get(id);
  if (!row) throw Object.assign(new Error('跟进序列不存在'), { status: 404 });
  const sequence = summary(row),
    result = pagination(params, sequence.firstCount);
  const items = db
    .prepare(
      `SELECT id AS firstId,json_extract(data,'$.customerId') AS customerId,
    json_extract(data,'$.companyName') AS companyName,json_extract(data,'$.from') AS "from",
    json_extract(data,'$.to') AS "to",json_extract(data,'$.sentAt') AS sentAt,
    json_extract(data,'$.mailboxId') AS mailboxId,
    (SELECT thread_id FROM mailbox_thread_links WHERE account_key=mail_account_key(json_extract(d.data,'$.mailboxId'),json_extract(d.data,'$.from'))
     AND external_id=json_extract(d.data,'$.messageId')) AS threadId
    FROM outreach_deliveries d WHERE campaign_id=? AND state='accepted'
    ORDER BY json_extract(data,'$.sentAt') DESC,id LIMIT ? OFFSET ?`,
    )
    .all(id, result.pageSize, (result.page - 1) * result.pageSize);
  const lookup = new Map(
    items.map((item) => [item.firstId, Object.assign(item, { followUps: [] })]),
  );
  if (items.length) {
    const rows = db
      .prepare(
        `SELECT json_extract(data,'$.firstId') AS firstId,json_extract(data,'$.step') AS step,
      state AS status,json_extract(data,'$.reason') AS reason,json_extract(data,'$.sentAt') AS sentAt,
      json_extract(data,'$.dueAt') AS dueAt FROM outreach_followups
      WHERE json_extract(data,'$.firstId') IN (${items.map(() => '?').join(',')})
      ORDER BY json_extract(data,'$.firstId'),json_extract(data,'$.step')`,
      )
      .all(...lookup.keys());
    for (const { firstId, ...step } of rows) lookup.get(firstId).followUps.push(step);
  }
  return {
    ...result,
    sequence,
    steps: [0, 72, 168].map((offsetHours, step) => ({ step, offsetHours })),
    items,
  };
}
