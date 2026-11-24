import { mailboxAccountKey } from './mail-conversations.mjs';
import { classifyInboundReply } from './communication-rounds.mjs';

const pageSize = 25;
const fail = (status, message) => Object.assign(new Error(message), { status });
const field = (name) => `json_extract(data,'$.${name}')`;

// Both stores can live in separate databases, including separate in-memory databases.
// Transfer only the indexed customer's display fields, never the CRM mail bodies.
function businessRows(store, customerId) {
  const columns = [
    'title',
    'subject',
    'account',
    'externalId',
    'mailboxMessageId',
    'occurredAt',
    'dueAt',
    'status',
    'deliveryStatus',
    'notes',
    'completionNotes',
    'campaignId',
    'origin',
  ];
  return store.db
    .prepare(
      `SELECT kind,id,${columns.map((name) => field(name) + ' AS ' + name).join(',')}
    FROM customer_business_entities WHERE scope=? AND kind IN ('tasks','messages')
    AND json_extract(data,'$.customerId')=? AND coalesce(json_extract(data,'$.origin'),'')!='mock'
    AND NOT (kind='tasks' AND upper(coalesce(json_extract(data,'$.notes'),'')) LIKE 'MOCK%')
    AND (kind='tasks' OR (json_extract(data,'$.channel')='email' AND json_extract(data,'$.direction')='outbound'
    AND json_extract(data,'$.deliveryStatus') IN ('sent','accepted')))`,
    )
    .all(store.scope, customerId);
}

export function initializeCustomerTimeline(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS timeline_delivery_customer ON outreach_deliveries(json_extract(data,'$.customerId'));
    CREATE INDEX IF NOT EXISTS timeline_followup_customer ON outreach_followups(json_extract(data,'$.customerId'));
    CREATE INDEX IF NOT EXISTS timeline_customer_thread ON mailbox_threads(json_extract(data,'$.customerId'));
    CREATE INDEX IF NOT EXISTS timeline_participant ON mailbox_threads(json_extract(data,'$.participant'));
    CREATE INDEX IF NOT EXISTS timeline_headers ON mailbox_reply_headers(thread_id,direction)`);
  db.function(
    'timeline_request',
    { deterministic: true },
    (data) => classifyInboundReply(JSON.parse(data)).requestType,
  );
}

export function readCustomerTimeline(store, service, customerId, requestedPage = 1) {
  const page = Number(requestedPage);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) throw fail(400, '时间线页码无效');
  const { db, conversations } = service;
  const accounts = service.mailboxes
    .list()
    .map((box) => ({ key: mailboxAccountKey(box), email: box.email.toLowerCase() }));
  const contacts = accounts.length ? conversations.customers() : [];
  const customer = contacts.find((c) => c.id === customerId);
  const lookup = conversations.customerLookup();
  const emails = [
    customer?.email,
    ...(customer?.contactEvidence || []).filter((e) => e.kind === 'email').map((e) => e.value),
  ]
    .flatMap((s) => (s || '').toLowerCase().split(/[\s,;；、]+/u))
    .filter((s) => s && lookup(s)?.id === customerId);
  const offline = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='mail_offline_handled'").get();
  const closed = offline
    ? 'EXISTS(SELECT 1 FROM mail_offline_handled WHERE message_id=h.id)'
    : "EXISTS(SELECT 1 FROM mail_thread_workflow WHERE thread_id=h.thread_id AND state='done' AND updated_at>=h.stamp)";
  const result = db
    .prepare(
      `WITH accounts AS (SELECT value->>'key' AS key,value->>'email' AS email FROM json_each($accounts)),
    threads AS MATERIALIZED (SELECT t.id,t.account_key FROM mailbox_threads t JOIN accounts a ON t.account_key=a.key
      WHERE json_extract(t.data,'$.customerId')=$id OR (coalesce(json_extract(t.data,'$.customerId'),'')=''
      AND json_extract(t.data,'$.participant') IN (SELECT value FROM json_each($emails)))),
    crm AS (SELECT value AS data FROM json_each($crm)),
    firsts AS MATERIALIZED (SELECT d.id,d.state,d.data FROM outreach_deliveries d JOIN outreach_campaigns c ON c.id=d.campaign_id
      WHERE json_extract(d.data,'$.customerId')=$id AND c.data->>'mode'='production' AND c.data->>'scope'=$scope),
    follow AS MATERIALIZED (SELECT f.id,f.state,f.data FROM outreach_followups f JOIN firsts d ON d.id=f.data->>'firstId'
      WHERE json_extract(f.data,'$.customerId')=$id),
    inbound AS MATERIALIZED (SELECT h.id,h.subject,h.thread_id,h.stamp,timeline_request(m.data) AS request
      FROM threads t JOIN mailbox_reply_headers h ON h.thread_id=t.id JOIN mailbox_thread_messages m ON m.id=h.id
      JOIN accounts a ON a.key=h.account_key
      WHERE h.direction='inbound' AND h.source='imap' AND h.sender NOT IN (SELECT email FROM accounts)
      AND NOT ${closed} AND NOT EXISTS (SELECT 1 FROM mailbox_reply_headers o WHERE o.direction='outbound'
        AND o.account_key=h.account_key AND o.parent_id=h.external_id AND o.sender=a.email AND o.stamp>=h.stamp
        AND EXISTS(SELECT 1 FROM json_each(o.recipients) WHERE lower(value)=h.sender))),
    events(kind,id,title,state,stamp,clock,note,thread,campaign,source,identity,priority) AS (
      SELECT 'mail',h.id,h.subject,'sent',m.data->>'occurredAt','发送',NULL,h.thread_id,NULL,'thread',
        coalesce(nullif(h.external_id,''),h.id)||':'||lower(h.sender),1
        FROM threads t JOIN mailbox_reply_headers h ON h.thread_id=t.id JOIN mailbox_thread_messages m ON m.id=h.id
        WHERE h.direction='outbound' AND m.data->>'deliveryStatus' IN ('sent','accepted')
      UNION ALL SELECT 'mail',data->>'id',data->>'subject','sent',data->>'occurredAt','发送',NULL,NULL,NULL,'message',
        coalesce(nullif(data->>'externalId',''),data->>'mailboxMessageId',data->>'id')||':'||lower(coalesce(data->>'account','')),3 FROM crm WHERE data->>'kind'='messages'
      UNION ALL SELECT CASE state WHEN 'accepted' THEN 'mail' ELSE 'first' END,id,
        CASE state WHEN 'accepted' THEN data->>'subject' ELSE '首封开发信' END,
        CASE WHEN state='failed' AND data->>'$.resolution.outcome'='failed' THEN 'verifiedFailed'
             WHEN state='draft' AND coalesce(data->>'subject','')='' THEN 'generating' ELSE state END,
        CASE WHEN state='accepted' THEN data->>'sentAt' WHEN state IN ('draft','queued','sending','blocked') THEN data->>'scheduledAt'
             ELSE coalesce(data->>'skippedAt',data->>'cancelledAt',data->>'attemptedAt',data->>'createdAt') END,
        CASE WHEN state='accepted' THEN '发送' WHEN state IN ('draft','queued','sending','blocked') THEN '计划' ELSE '记录' END,
        data->>'reason',NULL,data->>'campaignId','delivery',coalesce(nullif(data->>'messageId',''),id)||':'||lower(coalesce(data->>'from','')),2 FROM firsts
      UNION ALL SELECT 'auto','task_'||id,'首封未回复 · 第 '||coalesce(data->>'step','')||' 次追信',state,data->>'dueAt','计划',
        data->>'reason',NULL,data->>'campaignId','followup','task_'||id,1 FROM follow
      UNION ALL SELECT 'mail',id,data->>'subject','sent',data->>'sentAt','发送',NULL,NULL,data->>'campaignId','followup',
        coalesce(nullif(data->>'messageId',''),id)||':'||lower(coalesce(data->>'from','')),2 FROM follow WHERE state='accepted'
      UNION ALL SELECT CASE WHEN data->>'origin'='automatic-followup' THEN 'auto' ELSE 'manual' END,data->>'id',data->>'title',
        coalesce(nullif(data->>'deliveryStatus',''),data->>'status'),data->>'dueAt','计划',
        coalesce(nullif(data->>'notes',''),data->>'completionNotes'),NULL,data->>'campaignId','task',data->>'id',2 FROM crm WHERE data->>'kind'='tasks'
      UNION ALL SELECT 'reply',id,subject,request,stamp,'收到',NULL,thread_id,NULL,'thread',id,1 FROM inbound WHERE request IS NOT NULL
    ), ranked AS (SELECT *,row_number() OVER (PARTITION BY kind,CASE WHEN kind IN ('mail','auto') THEN identity ELSE id END ORDER BY priority,id) AS rank FROM events),
    selected AS MATERIALIZED (SELECT * FROM ranked WHERE rank=1),
    slice AS (SELECT * FROM selected ORDER BY (stamp IS NULL OR stamp='') DESC,julianday(stamp) DESC,kind,id LIMIT $size OFFSET $offset)
    SELECT (SELECT count(*) FROM selected) AS total,(SELECT count(*) FROM selected WHERE kind='mail') AS sentCount,
      (SELECT count(*) FROM selected WHERE kind='first') AS firstCount,
      (SELECT json_group_array(json_object('id',id,'kind',kind,'title',title,'state',state,'stamp',stamp,'clock',clock,'note',note,
        'thread',thread,'campaign',campaign,'source',source)) FROM slice) AS items`,
    )
    .get({
      id: customerId,
      accounts: JSON.stringify(accounts),
      emails: JSON.stringify(emails),
      crm: JSON.stringify(businessRows(store, customerId)),
      scope: service.getScope(),
      size: pageSize,
      offset: (page - 1) * pageSize,
    });
  const context = store.context(customerId);
  return {
    items: JSON.parse(result.items),
    total: result.total,
    sentCount: result.sentCount,
    firstCount: result.firstCount,
    page,
    pageSize,
    fixedEmail: context.fixedEmail,
    doNotContact: context.doNotContact,
  };
}

export function timelineOriginal(store, service, customerId, source, id) {
  const item =
    source === 'message'
      ? store.get('messages', id)
      : source === 'followup'
        ? service.followUps.get(id)
        : service.deliveryRecord(id);
  if (
    !item ||
    item.customerId !== customerId ||
    (source === 'message'
      ? !(
          item.channel === 'email' &&
          item.direction === 'outbound' &&
          ['accepted', 'sent'].includes(item.deliveryStatus)
        )
      : !(
          item.status === 'accepted' &&
          service.campaign(item.campaignId).scope === service.getScope() &&
          service.campaign(item.campaignId).mode === 'production'
        ))
  )
    throw fail(404, '未找到该客户的已发送邮件');
  return {
    subject: item.subject,
    from: item.from,
    to: item.to,
    bodyText: item.bodyText || item.body || '',
    bodyHtml: item.bodyHtml || '',
    sentAt: item.sentAt || item.occurredAt,
  };
}
