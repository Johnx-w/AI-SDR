import { overviewRange } from '../src/domain/overview-rules.mjs';
import { legacyFollowUpStep } from './outreach-sequence-policy.mjs';

const replyReason = '收到客户来信，结束本轮追信';
const replied = "status='cancelled' AND reason=$received";
const attention =
  "(status IN ('unknown','failed','bounced') OR (status='cancelled' AND (reason LIKE '%退信%' OR reason LIKE '%拒收%')) OR (status='pending' AND (reason LIKE '%待核实%' OR reason LIKE '%核对后%')))";
const queues = {
  upcoming: "status='pending' AND dueAt >= $now AND dueAt < $until",
  review: attention,
  responded: replied,
};
const taskSource = `SELECT f.id, f.state AS status, f.data->>'customerId' AS customerId,
  coalesce(nullif(f.data->>'companyName',''), d.data->>'companyName', f.data->>'to') AS customerName,
  f.data->>'to' AS recipient, f.data->>'from' AS account, f.data->>'dueAt' AS dueAt,
  f.data->>'step' AS step, f.data->>'day' AS day, f.data->>'reason' AS reason,
  c.id AS campaignId, c.data->>'name' AS campaignName,NULL AS firstSentAt
  FROM outreach_followups f
  CROSS JOIN outreach_deliveries d ON d.id=json_extract(f.data,'$.firstId') AND d.state='accepted'
  JOIN outreach_campaigns c ON c.id=d.campaign_id AND c.id=json_extract(f.data,'$.campaignId')
  WHERE c.data->>'mode'='production' AND c.data->>'scope'=$scope
    AND f.data->>'customerId'=d.data->>'customerId'
    AND f.data->>'mailboxId'=d.data->>'mailboxId'`;
// Unary + removes column affinity so SQLite can use the firstId JSON expression index.
// A candidate is a read-only view of an accepted first email.
const candidateSource = `SELECT 'candidate-'||d.id AS id,'candidate' AS status,
  d.data->>'customerId' AS customerId,coalesce(nullif(d.data->>'companyName',''),d.data->>'to') AS customerName,
  d.data->>'to' AS recipient,d.data->>'from' AS account,NULL AS dueAt,NULL AS step,NULL AS day,
  '首封已获服务商接受，尚无追信排期。请核对原会话和客户联系意愿。' AS reason,
  c.id AS campaignId,c.data->>'name' AS campaignName,d.data->>'sentAt' AS firstSentAt
  FROM outreach_campaigns c JOIN outreach_deliveries d ON d.campaign_id=c.id AND d.state='accepted'
  WHERE c.data->>'mode'='production' AND c.data->>'scope'=$scope
    AND coalesce(c.data->>'status','')!='cancelled' AND d.data->>'mode'='production'
    AND d.data->>'customerId' > '' AND d.data->>'to' > '' AND d.data->>'mailboxId' > ''
    AND d.data->>'sentAt' > ''
    AND NOT EXISTS (SELECT 1 FROM outreach_followups f WHERE json_extract(f.data,'$.firstId')=+d.id)
    AND NOT EXISTS (SELECT 1 FROM outreach_delivery_bounces b WHERE b.delivery_id=d.id)
    AND NOT EXISTS (SELECT 1 FROM outreach_suppression s WHERE s.identity IN (
      'company:'||(d.data->>'customerId'),'domain:'||lower(d.data->>'$.candidate.companyDomain'),
      'email:'||lower(d.data->>'to')))
    AND NOT EXISTS (SELECT 1 FROM mailbox_reply_headers h
      WHERE h.account_key=mail_account_key(d.data->>'mailboxId',d.data->>'from')
        AND h.sender=lower(d.data->>'to') AND h.direction='inbound' AND h.source='imap'
        AND h.classification!='auto_reply' AND h.stamp>=d.data->>'sentAt')
    AND NOT EXISTS (SELECT 1 FROM mailbox_thread_links l JOIN mailbox_reply_headers h
      ON h.account_key=l.account_key AND h.thread_id=l.thread_id
      WHERE l.account_key=mail_account_key(d.data->>'mailboxId',d.data->>'from')
        AND l.external_id=d.data->>'messageId' AND h.stamp>=d.data->>'sentAt'
        AND ((h.direction='inbound' AND h.source='imap' AND h.classification!='auto_reply')
          OR (h.direction='outbound' AND coalesce(h.external_id,'')!=coalesce(d.data->>'messageId','')
            AND EXISTS (SELECT 1 FROM mailbox_thread_messages m WHERE m.id=h.id
              AND m.data->>'deliveryStatus' IN ('sent','accepted')))))`;
const bounceSource = `SELECT 'bounce-'||d.id id,'bounced' status,d.data->>'customerId' customerId,
  coalesce(nullif(d.data->>'companyName',''),d.data->>'to') customerName,d.data->>'to' recipient,
  d.data->>'from' account,b.received_at dueAt,NULL step,NULL day,'原邮件已确认退信' reason,
  c.id campaignId,c.data->>'name' campaignName,d.data->>'sentAt' firstSentAt
  FROM outreach_delivery_bounces b JOIN outreach_deliveries d ON d.id=b.delivery_id
  JOIN outreach_campaigns c ON c.id=d.campaign_id WHERE c.data->>'scope'=$scope AND c.data->>'mode'='production'
  AND d.data->>'mode'='production' AND d.data->>'customerId'>''`;
const fail = () => Object.assign(new Error('追信任务不存在'), { status: 404 });

export function listFollowupTasks(service, params) {
  const now = service.now(),
    stamp = (ms) => new Date(ms).toISOString();
  const at = Date.parse(params.get('asOf') || '');
  const range = overviewRange('7d', Number.isFinite(at) ? at : now);
  const bindings = {
    scope: service.getScope(),
    now: stamp(now),
    until: stamp(now + 7 * 86400000),
    received: replyReason,
    customer: (params.get('customerId') || '').slice(0, 100),
    campaign: (params.get('campaignId') || '').slice(0, 100),
    q: (params.get('q') || '').trim().toLowerCase().slice(0, 160),
    id: (params.get('task') || '').replace(/^task_/, '').slice(0, 200),
    end: range.todayEnd,
    start: range.asOf,
  };
  const base = `WITH tasks AS (${taskSource}
    UNION ALL ${candidateSource} UNION ALL ${bounceSource}), scoped AS (
    SELECT * FROM tasks WHERE ($customer='' OR customerId=$customer)
      AND ($campaign='' OR campaignId=$campaign)), matched AS (
    SELECT * FROM scoped WHERE ($id='' OR id=$id)
      AND ($q='' OR instr(lower(concat_ws(' ',customerName,recipient,campaignName,'第 '||step||' 次追信')), $q)>0))`;
  // Use the dashboard's Beijing-day links and the four queue predicates on the same read model.
  const status = {
    candidate: "status='candidate'",
    scheduled: "status IN ('pending','sending')",
    attention: "status IN ('unknown','failed')",
    bounced: "status='bounced'",
    pending: "status NOT IN ('accepted','skipped','cancelled')",
    completed: "status='accepted'",
    skipped: "status='skipped'",
    cancelled: "status='cancelled'",
  };
  const periods = {
    today: 'dueAt >= $start AND dueAt < $end',
    overdue: 'dueAt < $start',
    due: 'dueAt < $end',
  };
  const queue = Object.hasOwn(queues, params.get('queue')) ? params.get('queue') : 'all';
  const filters =
    [
      queues[queue],
      Object.hasOwn(status, params.get('state')) && status[params.get('state')],
      Object.hasOwn(periods, params.get('bucket')) &&
        `status='pending' AND ${periods[params.get('bucket')]}`,
    ]
      .filter(Boolean)
      .join(' AND ') || '1';
  const sql = `${base}, filtered AS (SELECT * FROM matched WHERE ${filters})`;
  const count = service.db.prepare(`${sql} SELECT count(*) AS total,
    (SELECT count(*) FROM scoped) AS allCount,
    (SELECT count(*) FROM scoped WHERE ${queues.upcoming}) AS upcoming,
    (SELECT count(*) FROM scoped WHERE ${attention}) AS review,
    (SELECT count(*) FROM scoped WHERE ${replied}) AS responded FROM filtered`);
  count.setAllowUnknownNamedParameters(true);
  const { total, allCount, upcoming, review, responded } = count.get(bindings);
  const pageSize = 25,
    page = Math.max(
      1,
      Math.min(Math.ceil(total / pageSize), Math.trunc(Number(params.get('page'))) || 1),
    );
  const rows = service.db.prepare(`${sql} SELECT *, (${replied}) AS replied FROM filtered
    ORDER BY coalesce(dueAt,firstSentAt) ${queue === 'upcoming' ? 'ASC' : 'DESC'},id LIMIT $limit OFFSET $offset`);
  rows.setAllowUnknownNamedParameters(true);
  return {
    total,
    page,
    pageSize,
    counts: { all: allCount, upcoming, review, responded },
    items: rows
      .all({ ...bindings, limit: pageSize, offset: (page - 1) * pageSize })
      .map((r) => ({ ...r, day: r.day ?? legacyFollowUpStep(r.step)?.day, replied: !!r.replied })),
  };
}

export function readFollowupTask(service, id) {
  const { db } = service;
  const candidate = id.startsWith('candidate-');
  const bounce = id.startsWith('bounce-');
  const sourceId = candidate || bounce ? id.slice(id.indexOf('-') + 1) : id;
  const source =
    candidate || bounce
      ? (bounce ? bounceSource : candidateSource) + ' AND d.id=$id'
      : taskSource + ' AND f.id=$id';
  const row = db.prepare(source).get({ scope: service.getScope(), id: sourceId });
  if (!row) throw fail();
  const task = candidate || bounce ? null : service.followUps.get(id);
  const first = service.deliveryRecord(candidate || bounce ? sourceId : task.firstId);
  if (!first) throw fail();
  const thread = db
    .prepare(
      `SELECT l.thread_id AS id FROM mailbox_thread_links l
    JOIN mailbox_threads t ON t.id=l.thread_id WHERE l.account_key=mail_account_key(?,?)
    AND l.external_id=? AND t.account_key=l.account_key
    AND coalesce(t.data->>'customerId','') IN ('',?)`,
    )
    .get(first.mailboxId, first.from, first.messageId, row.customerId)?.id;
  const messages = [];
  const mail = (item, kind, at) => ({
    id: item.id,
    kind,
    at,
    subject: item.subject || '',
    from: item.from || '',
    to: item.to || '',
    source: item.source || 'outreach',
    bodyFormatVersion: item.bodyFormatVersion,
    bodyText: item.bodyText || '',
    bodyHtml: item.bodyHtml || '',
    inlineImages: item.inlineImages,
    bodyUnavailable: item.bodyUnavailable,
  });
  messages.push(mail(first, 'first', first.sentAt));
  if (candidate || bounce) return { thread, messages, recordedAt: bounce ? row.dueAt : undefined };
  if (task.subject || task.bodyText || task.bodyHtml)
    messages.push(
      mail(task, task.status === 'accepted' ? 'sent' : 'prepared', task.sentAt || task.attemptedAt),
    );
  if (thread && task.status === 'cancelled' && task.reason === replyReason) {
    const evidence = db
      .prepare(
        `SELECT m.data FROM mailbox_reply_headers h JOIN mailbox_thread_messages m ON m.id=h.id
      WHERE h.thread_id=? AND h.direction='inbound' AND h.source='imap' AND h.classification='normal'
      AND h.sender=lower(?) AND h.stamp>=? AND h.stamp<=?
      ORDER BY h.stamp DESC,h.id LIMIT 1`,
      )
      .get(thread, first.to, first.sentAt, task.updatedAt);
    if (evidence) {
      const reply = JSON.parse(evidence.data);
      messages.push(mail(reply, 'reply', reply.receivedAt || reply.occurredAt));
    }
  }
  const step = legacyFollowUpStep(task.step);
  return {
    thread,
    messages,
    recordedAt: task.updatedAt,
    attemptedAt: task.attemptedAt,
    sentAt: task.sentAt,
    day: task.day ?? step?.day,
    instruction: task.instruction ?? step?.instruction,
    policyRevision: task.policyRevision ?? (step ? 1 : undefined),
    policyName: task.policyName,
  };
}
