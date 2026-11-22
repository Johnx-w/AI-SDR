import { randomUUID } from 'node:crypto';

const invalid = (message, status = 400) => Object.assign(new Error(message), { status });
export class MailboxTags {
  constructor(db, mailboxes) {
    this.db = db;
    this.mailboxes = mailboxes;
    db.exec(`CREATE TABLE IF NOT EXISTS mailbox_tags(id TEXT PRIMARY KEY,name TEXT NOT NULL,folded TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS mailbox_tag_assignments(mailbox_id TEXT NOT NULL,tag_id TEXT NOT NULL,PRIMARY KEY(mailbox_id,tag_id));
      CREATE INDEX IF NOT EXISTS mailbox_tags_by_tag ON mailbox_tag_assignments(tag_id,mailbox_id);`);
  }
  list() {
    return {
      tags: this.db.prepare('SELECT id,name FROM mailbox_tags ORDER BY folded').all(),
      assignments: this.db
        .prepare(
          'SELECT mailbox_id AS mailboxId,tag_id AS tagId FROM mailbox_tag_assignments ORDER BY mailbox_id,tag_id',
        )
        .all(),
    };
  }
  requireTag(id) {
    if (typeof id !== 'string' || !this.db.prepare('SELECT 1 FROM mailbox_tags WHERE id=?').get(id))
      throw invalid('标签不存在', 404);
  }
  save(raw, id) {
    const name = typeof raw === 'string' ? raw.normalize('NFKC').trim() : '';
    if (!name || name.length > 64 || /[\p{Cc}]/u.test(name))
      throw invalid('标签名称须为 1 至 64 个可显示字符');
    if (id) this.requireTag(id);
    const folded = name.toLowerCase();
    const existing = this.db.prepare('SELECT id FROM mailbox_tags WHERE folded=?').get(folded);
    if (existing && existing.id !== id) throw invalid('该标签名称已存在', 409);
    if (id)
      this.db.prepare('UPDATE mailbox_tags SET name=?,folded=? WHERE id=?').run(name, folded, id);
    else this.db.prepare('INSERT INTO mailbox_tags VALUES(?,?,?)').run(randomUUID(), name, folded);
  }
  remove(id, targetId) {
    this.requireTag(id);
    if (targetId !== undefined) {
      this.requireTag(targetId);
      if (targetId === id) throw invalid('请选择另一个标签');
      this.db
        .prepare(
          'INSERT OR IGNORE INTO mailbox_tag_assignments SELECT mailbox_id,? FROM mailbox_tag_assignments WHERE tag_id=?',
        )
        .run(targetId, id);
    }
    this.db.prepare('DELETE FROM mailbox_tag_assignments WHERE tag_id=?').run(id);
    this.db.prepare('DELETE FROM mailbox_tags WHERE id=?').run(id);
  }
  assign({ mailboxIds, tagIds, action }) {
    if (
      !['add', 'remove'].includes(action) ||
      ![mailboxIds, tagIds].every((a) => Array.isArray(a) && a.length > 0 && a.length <= 500)
    )
      throw invalid('请选择邮箱、标签及批量操作');
    const available = new Set(this.mailboxes.list().map((box) => box.id));
    if (mailboxIds.some((id) => !available.has(id))) throw invalid('选中的邮箱不存在', 404);
    const tags = new Set(tagIds);
    for (const id of tags) this.requireTag(id);
    const stmt = this.db.prepare(
      action === 'add'
        ? 'INSERT OR IGNORE INTO mailbox_tag_assignments VALUES(?,?)'
        : 'DELETE FROM mailbox_tag_assignments WHERE mailbox_id=? AND tag_id=?',
    );
    for (const mailbox of new Set(mailboxIds)) for (const id of tags) stmt.run(mailbox, id);
  }
}
