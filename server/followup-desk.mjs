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
const assigned = `SELECT e.id,e.data->>'$.audit[0].mailboxThreadId' thread,e.data->>'customerId' customerId,
  e.data->>'participant' name,e.data->>'title' title,coalesce(p.next_step,'') note,
  coalesce(p.owner,e.data->>'owner') owner,coalesce(p.due_at,e.data->>'updatedAt') stamp
  FROM customer_business_entities e LEFT JOIN followup_assignment_plans p ON p.scope=e.scope AND p.id=e.id
  WHERE e.scope=$scope AND e.kind='conversations' AND e.data->>'channel'='email'
  AND e.data->>'ownership'='human' AND e.data->>'status'='active' AND coalesce(p.completed,0)=$completed`;
const priority = `SELECT c.record_id id,NULL thread,c.record_id customerId,c.summary->>'name' name,
  c.summary->>'email' title,'' note,'' owner,p.marked_at stamp FROM followup_priority p
  JOIN lead_library_customers c ON c.scope=p.scope AND c.record_id=p.customer_id WHERE p.scope=$scope`;
function statement(db, sql) {
  const stmt = db.prepare(sql);
  stmt.setAllowUnknownNamedParameters(true);
  return stmt;
}
export function followupDesk(service, store, library, params) {
  const queue = params.get('queue');
  const args = {
    q: (params.get('q') || '').trim().toLowerCase().slice(0, 160),
    customer: params.get('customerId') || '',
    completed: Number(params.get('completed') === '1'),
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
    assigned: [store.db, assigned, { scope: store.scope }],
    priority: [library.db, priority, { scope: library.scope }],
  };
  const counts = {};
  for (const [key, [db, sql, bindings]] of Object.entries(sources)) {
    counts[key] = statement(
      db,
      `SELECT count(*) n FROM (${sql}) WHERE ($customer='' OR customerId=$customer)`,
    ).get({ ...bindings, ...args, completed: 0 }).n;
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
export function saveFollowupPlan(store, id, input) {
  const row = store.get('conversations', id);
  if (row?.ownership !== 'human' || row.channel !== 'email' || row.status !== 'active')
    throw fail(409, '当前会话未由人工接手');
  const owner = String(input.owner || '').trim(),
    step = String(input.nextStep || '').trim(),
    due = Date.parse(input.dueAt);
  if (
    !owner ||
    owner.length > 120 ||
    !step ||
    step.length > 1000 ||
    !Number.isFinite(due) ||
    typeof input.completed !== 'boolean'
  )
    throw fail(400, '请填写负责人、下一步和有效的跟进时间');
  store.db
    .prepare(
      `INSERT INTO followup_assignment_plans VALUES(?,?,?,?,?,?)
  ON CONFLICT(scope,id) DO UPDATE SET owner=excluded.owner,next_step=excluded.next_step,due_at=excluded.due_at,completed=excluded.completed`,
    )
    .run(store.scope, id, owner, step, new Date(due).toISOString(), Number(input.completed));
  return { saved: true };
}
