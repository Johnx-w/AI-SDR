const invalid = () => Object.assign(new Error('文件筛选条件无效'), { status: 400 });
export function validReplyFileIds(ids) {
  return (
    Array.isArray(ids) &&
    ids.length <= 20000 &&
    ids.every((id) => typeof id === 'string' && id.trim() && id.length <= 180) &&
    new Set(ids).size === ids.length
  );
}

export function listReplyFiles(db, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
  const { q = '', ids } = input;
  let { page = 1 } = input;
  if (
    typeof q !== 'string' ||
    q.length > 200 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    (ids !== undefined && !validReplyFileIds(ids))
  )
    throw invalid();
  const params = [];
  let from = ` FROM product_knowledge p JOIN product_documents d ON d.id=COALESCE(json_extract(p.data,'$.documentIds[0]'),(SELECT id FROM product_documents WHERE product_id=p.id ORDER BY rowid DESC LIMIT 1))`;
  const conditions = [];
  if (ids !== undefined) {
    conditions.push('p.id IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify(ids));
  }
  if (q.trim()) {
    conditions.push(
      "(instr(lower(json_extract(p.data,'$.name')),lower(?))>0 OR instr(lower(json_extract(d.metadata,'$.name')),lower(?))>0)",
    );
    params.push(q.trim(), q.trim());
  }
  if (conditions.length) from += ' WHERE ' + conditions.join(' AND ');
  const total = db.prepare('SELECT COUNT(*) n' + from).get(...params).n;
  const pageSize = 20;
  page = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
  const items = db
    .prepare(
      `SELECT p.id,json_extract(p.data,'$.name') name,json_extract(d.metadata,'$.name') filename,
    json_extract(p.data,'$.status') status,json_extract(p.data,'$.effectiveDate') effectiveDate,json_extract(p.data,'$.version') version` +
        from +
        " ORDER BY json_extract(p.data,'$.updatedAt') DESC,p.id LIMIT ? OFFSET ?",
    )
    .all(...params, pageSize, (page - 1) * pageSize);
  return { items, total, page, pageSize };
}
