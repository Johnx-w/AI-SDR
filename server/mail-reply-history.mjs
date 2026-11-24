const columns =
  'id,account_key,thread_id,direction,source,origin,sender,recipients,subject,stamp,external_id,parent_id,classification,business_kind,request_type';
function values(alias) {
  const data = alias + '.data',
    get = (field) => `json_extract(${data},'$.${field}')`;
  return [
    alias + '.id',
    alias + '.account_key',
    alias + '.thread_id',
    get('direction'),
    get('source'),
    `coalesce(${get('sendOrigin')},${get('source')})`,
    `lower(${get('from')})`,
    `CASE WHEN json_array_length(${data},'$.toAddresses')>0 THEN ${get('toAddresses')} ELSE json_array(lower(${get('to')})) END`,
    get('subject'),
    `coalesce(${get('receivedAt')},${get('occurredAt')})`,
    get('messageId'),
    `coalesce(nullif(${get('inReplyTo')},''),json_extract(${data},'$.references[#-1]'))`,
    get('classification'),
    get('businessKind'),
    get('requestType'),
  ].join(',');
}

// Keep list queries and exact reply links off the potentially megabyte-sized MIME body.
export function initializeReplyHistory(db) {
  const timeout = db.prepare('PRAGMA busy_timeout').get().timeout;
  try {
    if (!timeout) db.exec('PRAGMA busy_timeout=5000');
    const schema = db.prepare(`SELECT count(*) AS n FROM sqlite_schema WHERE name IN (
      'mailbox_reply_headers', 'mailbox_reply_scope', 'mailbox_reply_recent', 'mailbox_reply_parent',
      'mailbox_reply_message', 'mailbox_reply_insert', 'mailbox_reply_update', 'mailbox_reply_merge',
      'mailbox_reply_delete')`);
    const complete = () => {
      if (schema.get().n !== 9) return false;
      const fields = new Set(
        db
          .prepare('PRAGMA table_info(mailbox_reply_headers)')
          .all()
          .map((row) => row.name),
      );
      return fields.has('business_kind') && fields.has('request_type');
    };
    if (complete()) return;
    const nested = db.isTransaction;
    db.exec(nested ? 'SAVEPOINT reply_history_init' : 'BEGIN IMMEDIATE');
    try {
      // Another process may have completed the backfill while this connection waited for the lock.
      if (!complete()) {
        db.exec(`
        CREATE TABLE IF NOT EXISTS mailbox_reply_headers(
          id TEXT PRIMARY KEY, account_key TEXT NOT NULL, thread_id TEXT NOT NULL,
          direction TEXT, source TEXT, origin TEXT, sender TEXT, recipients TEXT, subject TEXT,
          stamp TEXT, external_id TEXT, parent_id TEXT, classification TEXT,
          business_kind TEXT, request_type TEXT
        );`);
        const fields = new Set(
          db
            .prepare('PRAGMA table_info(mailbox_reply_headers)')
            .all()
            .map((row) => row.name),
        );
        if (!fields.has('business_kind'))
          db.exec('ALTER TABLE mailbox_reply_headers ADD COLUMN business_kind TEXT');
        if (!fields.has('request_type'))
          db.exec('ALTER TABLE mailbox_reply_headers ADD COLUMN request_type TEXT');
        db.exec(`
        DROP TRIGGER IF EXISTS mailbox_reply_insert;
        DROP TRIGGER IF EXISTS mailbox_reply_update;
        DROP TRIGGER IF EXISTS mailbox_reply_merge;
        DROP TRIGGER IF EXISTS mailbox_reply_delete;
        CREATE INDEX IF NOT EXISTS mailbox_reply_scope ON mailbox_reply_headers(account_key,stamp DESC,id DESC) WHERE direction='inbound' AND source='imap';
        CREATE INDEX IF NOT EXISTS mailbox_reply_recent ON mailbox_reply_headers(stamp DESC,id DESC) WHERE direction='inbound' AND source='imap';
        CREATE INDEX IF NOT EXISTS mailbox_reply_parent ON mailbox_reply_headers(account_key,parent_id,sender,stamp) WHERE direction='outbound';
        CREATE INDEX IF NOT EXISTS mailbox_reply_message ON mailbox_reply_headers(account_key,external_id,sender) WHERE direction='outbound';
        DELETE FROM mailbox_reply_headers WHERE NOT EXISTS (SELECT 1 FROM mailbox_thread_messages m WHERE m.id=mailbox_reply_headers.id);
        INSERT OR REPLACE INTO mailbox_reply_headers(${columns}) SELECT ${values('m')} FROM mailbox_thread_messages m;
        CREATE TRIGGER IF NOT EXISTS mailbox_reply_insert AFTER INSERT ON mailbox_thread_messages BEGIN
          INSERT INTO mailbox_reply_headers(${columns}) VALUES(${values('new')});
        END;
        CREATE TRIGGER IF NOT EXISTS mailbox_reply_update AFTER UPDATE OF data ON mailbox_thread_messages BEGIN
          INSERT OR REPLACE INTO mailbox_reply_headers(${columns}) VALUES(${values('new')});
        END;
        CREATE TRIGGER IF NOT EXISTS mailbox_reply_merge AFTER UPDATE OF thread_id ON mailbox_thread_messages BEGIN
          UPDATE mailbox_reply_headers SET thread_id=new.thread_id WHERE id=new.id;
        END;
        CREATE TRIGGER IF NOT EXISTS mailbox_reply_delete AFTER DELETE ON mailbox_thread_messages BEGIN
          DELETE FROM mailbox_reply_headers WHERE id=old.id;
        END;`);
      }
      db.exec(nested ? 'RELEASE reply_history_init' : 'COMMIT');
    } catch (error) {
      if (db.isTransaction)
        db.exec(nested ? 'ROLLBACK TO reply_history_init; RELEASE reply_history_init' : 'ROLLBACK');
      throw error;
    }
  } finally {
    if (!timeout) db.exec('PRAGMA busy_timeout=0');
  }
}
export function replyHeaderKindSql(known) {
  const internal = 'h.sender IN (' + known.map(() => '?').join(',') + ')';
  return `CASE WHEN ${internal} THEN CASE WHEN instr(lower(h.subject),'[ai-sdr internal qa ')>0 THEN 'test' ELSE 'internal' END
    WHEN h.classification='hard_bounce' THEN 'bounce' WHEN h.classification='auto_reply' THEN 'notification'
    WHEN h.classification IN ('unsubscribe','complaint','unverified') THEN h.classification
    WHEN h.parent_id IS NULL THEN 'inquiry' ELSE 'reply' END`;
}

const kinds = new Set([
  'all',
  'reply',
  'inquiry',
  'notification',
  'unverified',
  'bounce',
  'unsubscribe',
  'complaint',
  'internal',
  'test',
]);
const pageSize = 25;
export function listReplyHistory(
  store,
  { mailboxId = 'all', kind = 'reply', businessKind = 'all', handling = 'all', page = '1' } = {},
  keyFor,
) {
  page = Number(page);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 1000000 ||
    !kinds.has(kind) ||
    !['all', 'answered', 'unanswered'].includes(handling) ||
    ![
      'all',
      'positive',
      'refusal',
      'referral',
      'notification',
      'bounce',
      'unverified',
      'other',
    ].includes(businessKind)
  )
    throw Object.assign(new Error('来信类型或页码无效'), { status: 400 });
  const accounts = store.mailboxes.list(),
    selected = store.selected(mailboxId);
  const mailboxes = accounts.map(({ id, email }) => ({ id, email })),
    keys = selected.map(keyFor);
  if (!keys.length) return { items: [], total: 0, page, pageSize, mailboxes };
  const byKey = new Map(selected.map((box) => [keyFor(box), box]));
  const known = accounts.map((box) => box.email.toLowerCase());
  const classify = replyHeaderKindSql(known);
  let where =
    `h.direction='inbound' AND h.source='imap' AND h.account_key IN (${keys.map(() => '?').join(',')})` +
    (kind === 'all' ? '' : ` AND (${classify})=?`);
  const args = kind === 'all' ? [...keys] : [...keys, ...known, kind];
  if (handling !== 'all') {
    const senderByKey =
      'CASE h.account_key ' + selected.map(() => 'WHEN ? THEN ?').join(' ') + ' END';
    where += ` AND ${handling === 'unanswered' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM mailbox_reply_headers o
      WHERE o.direction='outbound' AND o.account_key=h.account_key AND o.parent_id=h.external_id
      AND o.sender=(${senderByKey}) AND o.stamp>=h.stamp
      AND EXISTS(SELECT 1 FROM json_each(o.recipients) r WHERE lower(r.value)=h.sender))`;
    for (const box of selected) args.push(keyFor(box), box.email.toLowerCase());
  }
  const countRows = store.db
    .prepare(
      `SELECT coalesce(h.business_kind,'other') AS kind,count(*) AS count
       FROM mailbox_reply_headers h WHERE ${where} GROUP BY coalesce(h.business_kind,'other')`,
    )
    .all(...args);
  const businessCounts = Object.fromEntries(
    ['positive', 'refusal', 'referral', 'notification', 'bounce', 'unverified', 'other'].map(
      (value) => [value, countRows.find((row) => row.kind === value)?.count || 0],
    ),
  );
  if (businessKind !== 'all') {
    where += ` AND coalesce(h.business_kind,'other')=?`;
    args.push(businessKind);
  }
  const total = store.db
    .prepare('SELECT count(*) AS n FROM mailbox_reply_headers h WHERE ' + where)
    .get(...args).n;
  const rows = store.db
    .prepare(
      `SELECT h.id,h.thread_id,h.account_key,h.sender,h.subject,h.stamp,h.external_id,h.parent_id,
      coalesce(h.business_kind,'other') AS business_kind,h.request_type,${classify} AS kind
    FROM mailbox_reply_headers h WHERE ${where} ORDER BY h.stamp DESC,h.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...known, ...args, pageSize, (page - 1) * pageSize);
  const related = (column) =>
    store.db.prepare(`SELECT origin FROM mailbox_reply_headers o
    WHERE o.account_key=? AND o.direction='outbound' AND o.${column}=? AND o.sender=? AND o.stamp ${column === 'parent_id' ? '>=' : '<='} ?
      AND EXISTS (SELECT 1 FROM json_each(o.recipients) r WHERE lower(r.value)=?)
    ORDER BY o.stamp LIMIT 1`);
  const prior = related('external_id'),
    answer = related('parent_id'),
    lookup = store.customerLookup();
  const items = rows.map((m) => {
    const box = byKey.get(m.account_key),
      match = (id) => [m.account_key, id, box.email.toLowerCase(), m.stamp, m.sender];
    const hasParent = !!(m.parent_id && prior.get(...match(m.parent_id)));
    const sent = m.external_id && answer.get(...match(m.external_id));
    const customer = store.localCustomer({ participant: m.sender }, lookup);
    return {
      id: m.id,
      threadId: m.thread_id,
      mailboxId: box.id,
      account: box.email,
      from: m.sender,
      subject: m.subject,
      receivedAt: m.stamp,
      kind: m.kind,
      businessKind: m.business_kind,
      requestType: m.request_type || null,
      customerId: customer.customerId || null,
      companyName: customer.companyName || null,
      hasLocalParent: hasParent,
      handling: sent
        ? sent.origin === 'manual'
          ? 'manual'
          : sent.origin === 'automatic'
            ? 'automatic'
            : 'sent'
        : 'unanswered',
    };
  });
  return { items, total, page, pageSize, mailboxes, businessCounts };
}
