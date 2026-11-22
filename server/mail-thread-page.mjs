import { effectiveFolder } from './mail-thread-workflow.mjs';

const json = (field) => "json_extract(t.data,'$." + field + "')";
const searchable = (alias, fields) =>
  fields
    .map((field) => 'coalesce(json_extract(' + alias + ".data,'$." + field + "'),'')")
    .join("||' '||");

export function initializeThreadSearch(db) {
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='mail_thread_search_delete'",
      )
      .get()
  )
    return;
  db.exec('SAVEPOINT mailbox_search_init');
  try {
    const fields = ['subject', 'from', 'to', 'bodyText'];
    db.exec(`CREATE TABLE IF NOT EXISTS mailbox_search_text(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,content TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mail_search_thread ON mailbox_search_text(thread_id);
      INSERT OR REPLACE INTO mailbox_search_text SELECT m.id,m.thread_id,${searchable('m', fields)} FROM mailbox_thread_messages m;
      CREATE TRIGGER IF NOT EXISTS mail_thread_search_insert AFTER INSERT ON mailbox_thread_messages BEGIN
        INSERT INTO mailbox_search_text VALUES(new.id,new.thread_id,${searchable('new', fields)});
      END;
      CREATE TRIGGER IF NOT EXISTS mail_thread_search_update AFTER UPDATE OF data,thread_id ON mailbox_thread_messages BEGIN
        UPDATE mailbox_search_text SET thread_id=new.thread_id,content=${searchable('new', fields)} WHERE id=new.id;
      END;
      CREATE TRIGGER IF NOT EXISTS mail_thread_search_delete AFTER DELETE ON mailbox_thread_messages BEGIN
        DELETE FROM mailbox_search_text WHERE id=old.id;
      END;`);
    db.exec('RELEASE mailbox_search_init');
  } catch (error) {
    db.exec('ROLLBACK TO mailbox_search_init; RELEASE mailbox_search_init');
    throw error;
  }
}

export function listThreadPage(
  store,
  keys,
  lookup,
  { customerId, query, unread, inboundOnly, folder, page, pageSize },
) {
  const size = [10, 20, 25, 50, 100, 200].includes(Number(pageSize)) ? Number(pageSize) : 25;
  if (!keys.length) return { items: [], total: 0, page: 1, pageSize: size, hasMore: false };
  const scope = 't.account_key IN (' + keys.map(() => '?').join(',') + ')';
  const where = [scope],
    args = [...keys];
  if (folder) {
    if (!['open', 'later', 'done'].includes(folder))
      throw Object.assign(new Error('无效的会话分组'), { status: 400 });
    where.push('(' + effectiveFolder + ')=?');
    args.push(new Date(store.now()).toISOString(), folder);
  }
  if (unread) where.push(json('unread') + '=1');
  if (inboundOnly)
    where.push(
      "EXISTS(SELECT 1 FROM mailbox_reply_headers h WHERE h.thread_id=t.id AND h.direction='inbound')",
    );
  if (customerId || query) {
    const participants = store.db
      .prepare(
        `SELECT DISTINCT ${json('participant')} AS email FROM mailbox_threads t WHERE ${scope} AND coalesce(${json('customerId')},'')=''`,
      )
      .all(...keys);
    const customerEmails = [],
      nameMatches = [];
    for (const { email } of participants) {
      const match = store.localCustomer({ participant: email }, lookup);
      if (customerId && match.customerId === customerId) customerEmails.push(email);
      if (query && match.companyName?.toLowerCase().includes(query)) nameMatches.push(email);
    }
    const byEmail = `(coalesce(${json('customerId')},'')='' AND ${json('participant')} IN (SELECT value FROM json_each(?)))`;
    if (customerId) {
      where.push(`(${json('customerId')}=? OR ${byEmail})`);
      args.push(customerId, JSON.stringify(customerEmails));
    }
    if (query) {
      where.push(`(${byEmail} OR instr(mail_text_fold(${searchable('t', ['account', 'participant', 'participantName', 'subject', 'preview', 'companyName'])}),?)>0 OR EXISTS(
        SELECT 1 FROM mailbox_search_text m WHERE m.thread_id=t.id AND instr(mail_text_fold(m.content),?)>0))`);
      args.push(JSON.stringify(nameMatches), query, query);
    }
  }
  const source =
    'FROM mailbox_threads t ' +
    (folder ? 'LEFT JOIN mail_thread_workflow w ON w.thread_id=t.id ' : '') +
    'WHERE ' +
    where.join(' AND ');
  const total = store.db.prepare('SELECT count(*) AS n ' + source).get(...args).n;
  const number = Math.max(
    1,
    Math.min(Math.ceil(total / size), Number.isSafeInteger(Number(page)) ? Number(page) : 1),
  );
  const rows = store.db
    .prepare(`SELECT t.data ${source} ORDER BY ${json('updatedAt')} DESC,t.id LIMIT ? OFFSET ?`)
    .all(...args, size, (number - 1) * size);
  return {
    items: rows.map((row) => store.localCustomer(JSON.parse(row.data), lookup)),
    total,
    page: number,
    pageSize: size,
    hasMore: number * size < total,
  };
}
