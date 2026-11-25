const fail = (status, message) => Object.assign(new Error(message), { status });

const approvals = `SELECT r.source_id id,r.thread_id thread,r.info->>'customerId' customerId,
  coalesce(t.data->>'companyName',r.info->>'from') name,r.info->>'subject' title,
  r.info->>'reason' note,r.info->>'owner' owner,datetime(r.received_at/1000,'unixepoch')||'Z' stamp
  FROM mail_reception r JOIN mailbox_threads t ON t.id=r.thread_id
  WHERE r.info->>'scope'=$scope AND r.state IN ('review','attention','uncertain')
  UNION ALL SELECT d.data->>'replyToMessageId',t.id,t.data->>'customerId',
  coalesce(t.data->>'companyName',t.data->>'participant'),t.data->>'subject','AI 草稿待审核','',
  d.data->>'updatedAt' FROM mail_reply_drafts d JOIN mailbox_threads t ON t.id=d.conversation_id
  WHERE d.data->>'$.provenance.generator'='model' AND t.data->>'customerId' IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM mail_reception r WHERE r.source_id=d.data->>'replyToMessageId')
  AND EXISTS(SELECT 1 FROM json_each($customers) WHERE value=t.data->>'customerId')`;
const priority = `SELECT c.record_id id,NULL thread,c.record_id customerId,c.summary->>'name' name,
  c.summary->>'email' title,'' note,'' owner,p.marked_at stamp FROM followup_priority p
  JOIN lead_library_customers c ON c.scope=p.scope AND c.record_id=p.customer_id WHERE p.scope=$scope`;
function statement(db, sql) {
  const stmt = db.prepare(sql);
  stmt.setAllowUnknownNamedParameters(true);
  return stmt;
}
export function followupDesk(service, library, params) {
  const queue = params.get('queue');
  const args = {
    q: (params.get('q') || '').trim().toLowerCase().slice(0, 160),
    customer: params.get('customerId') || '',
  };
  if (queue === 'lookup') {
    const items = args.q
      ? library.db
          .prepare(
            `SELECT c.record_id id,c.summary->>'name' name,c.summary->>'email' title
      FROM lead_library_customers c WHERE scope=? AND instr(lower(concat_ws(' ',c.summary->>'name',c.summary->>'email')),?)>0
      AND NOT EXISTS(SELECT 1 FROM followup_priority p WHERE p.scope=c.scope AND p.customer_id=c.record_id)
      ORDER BY name,id LIMIT 15`,
          )
          .all(library.scope, args.q)
      : [];
    return { items };
  }
  const draftCustomers = service.db
    .prepare(
      `SELECT DISTINCT t.data->>'customerId' id
    FROM mail_reply_drafts d JOIN mailbox_threads t ON t.id=d.conversation_id
    WHERE d.data->>'$.provenance.generator'='model' AND t.data->>'customerId' IS NOT NULL`,
    )
    .all()
    .map((r) => r.id);
  const customers = library.db
    .prepare(
      'SELECT record_id FROM lead_library_customers WHERE scope=? AND record_id IN (SELECT value FROM json_each(?))',
    )
    .all(library.scope, JSON.stringify(draftCustomers))
    .map((r) => r.record_id);
  const sources = {
    approval: [
      service.db,
      approvals,
      { scope: service.getScope(), customers: JSON.stringify(customers) },
    ],
    priority: [library.db, priority, { scope: library.scope }],
  };
  const counts = {};
  for (const [key, [db, sql, bindings]] of Object.entries(sources)) {
    counts[key] = statement(
      db,
      `SELECT count(*) n FROM (${sql}) WHERE ($customer='' OR customerId=$customer)`,
    ).get({ ...bindings, ...args }).n;
  }
  if (!Object.hasOwn(sources, queue)) return { counts };
  const [db, sql, bindings] = sources[queue];
  const where = `FROM (${sql}) WHERE ($customer='' OR customerId=$customer) AND ($q='' OR instr(lower(concat_ws(' ',name,title,note,owner)),$q)>0)`;
  const bind = { ...bindings, ...args };
  const total = statement(db, 'SELECT count(*) n ' + where).get(bind).n;
  const pageSize = 25,
    page = Math.max(
      1,
      Math.min(Math.ceil(total / pageSize), Math.trunc(Number(params.get('page'))) || 1),
    );
  const items = statement(
    db,
    'SELECT * ' + where + ' ORDER BY stamp DESC,id LIMIT 25 OFFSET $offset',
  ).all({ ...bind, offset: (page - 1) * 25 });
  return { counts, items, total, page, pageSize };
}

export function setFollowupPriority(library, id, marked) {
  if (typeof marked !== 'boolean') throw fail(400, '请选择标记状态');
  if (
    !library.db
      .prepare('SELECT 1 FROM lead_library_customers WHERE scope=? AND record_id=?')
      .get(library.scope, id)
  )
    throw fail(404, '客户不存在');
  if (marked)
    library.db
      .prepare('INSERT OR IGNORE INTO followup_priority VALUES(?,?,?)')
      .run(library.scope, id, new Date().toISOString());
  else
    library.db
      .prepare('DELETE FROM followup_priority WHERE scope=? AND customer_id=?')
      .run(library.scope, id);
  return { marked };
}
