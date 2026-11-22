const columns =
  'id,account_key,thread_id,direction,source,origin,sender,recipients,subject,stamp,external_id,parent_id,classification';
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
  ].join(',');
}

// Keep list queries and exact reply links off the potentially megabyte-sized MIME body.
export function initializeReplyHistory(db) {
  if (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mailbox_reply_headers'")
      .get()
  )
    return;
  db.exec(`
    CREATE TABLE mailbox_reply_headers(
      id TEXT PRIMARY KEY, account_key TEXT NOT NULL, thread_id TEXT NOT NULL,
      direction TEXT, source TEXT, origin TEXT, sender TEXT, recipients TEXT, subject TEXT,
      stamp TEXT, external_id TEXT, parent_id TEXT, classification TEXT
    );
    CREATE INDEX mailbox_reply_scope ON mailbox_reply_headers(account_key,stamp DESC,id DESC) WHERE direction='inbound' AND source='imap';
    CREATE INDEX mailbox_reply_recent ON mailbox_reply_headers(stamp DESC,id DESC) WHERE direction='inbound' AND source='imap';
    CREATE INDEX mailbox_reply_parent ON mailbox_reply_headers(account_key,parent_id,sender,stamp) WHERE direction='outbound';
    CREATE INDEX mailbox_reply_message ON mailbox_reply_headers(account_key,external_id,sender) WHERE direction='outbound';
    INSERT INTO mailbox_reply_headers(${columns}) SELECT ${values('m')} FROM mailbox_thread_messages m;
    CREATE TRIGGER mailbox_reply_insert AFTER INSERT ON mailbox_thread_messages BEGIN
      INSERT INTO mailbox_reply_headers(${columns}) VALUES(${values('new')});
    END;
    CREATE TRIGGER mailbox_reply_update AFTER UPDATE OF data ON mailbox_thread_messages BEGIN
      INSERT OR REPLACE INTO mailbox_reply_headers(${columns}) VALUES(${values('new')});
    END;
    CREATE TRIGGER mailbox_reply_merge AFTER UPDATE OF thread_id ON mailbox_thread_messages BEGIN
      UPDATE mailbox_reply_headers SET thread_id=new.thread_id WHERE id=new.id;
    END;
    CREATE TRIGGER mailbox_reply_delete AFTER DELETE ON mailbox_thread_messages BEGIN
      DELETE FROM mailbox_reply_headers WHERE id=old.id;
    END;`);
}
const kinds = new Set([
  'all',
  'reply',
  'inquiry',
  'notification',
  'bounce',
  'unsubscribe',
  'complaint',
  'internal',
  'test',
]);
const pageSize = 25;
export function listReplyHistory(
  store,
  { mailboxId = 'all', kind = 'reply', page = '1' } = {},
  keyFor,
) {
  page = Number(page);
  if (!Number.isSafeInteger(page) || page < 1 || page > 1000000 || !kinds.has(kind))
    throw Object.assign(new Error('来信类型或页码无效'), { status: 400 });
  const accounts = store.mailboxes.list(),
    selected = store.selected(mailboxId);
  const mailboxes = accounts.map(({ id, email }) => ({ id, email })),
    keys = selected.map(keyFor);
  if (!keys.length) return { items: [], total: 0, page, pageSize, mailboxes };
  const byKey = new Map(selected.map((box) => [keyFor(box), box]));
  const known = accounts.map((box) => box.email.toLowerCase());
  const internal = 'h.sender IN (' + known.map(() => '?').join(',') + ')';
  const classify = `CASE WHEN ${internal} THEN CASE WHEN instr(lower(h.subject),'[ai-sdr internal qa ')>0 THEN 'test' ELSE 'internal' END
    WHEN h.classification='hard_bounce' THEN 'bounce' WHEN h.classification='auto_reply' THEN 'notification'
    WHEN h.classification IN ('unsubscribe','complaint') THEN h.classification
    WHEN h.parent_id IS NULL THEN 'inquiry' ELSE 'reply' END`;
  const where =
    `h.direction='inbound' AND h.source='imap' AND h.account_key IN (${keys.map(() => '?').join(',')})` +
    (kind === 'all' ? '' : ` AND (${classify})=?`);
  const args = kind === 'all' ? keys : [...keys, ...known, kind];
  const total = store.db
    .prepare('SELECT count(*) AS n FROM mailbox_reply_headers h WHERE ' + where)
    .get(...args).n;
  const rows = store.db
    .prepare(
      `SELECT h.id,h.thread_id,h.account_key,h.sender,h.subject,h.stamp,h.external_id,h.parent_id,${classify} AS kind
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
  return { items, total, page, pageSize, mailboxes };
}
