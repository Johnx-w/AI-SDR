import { MaterialLibrary } from './materials.mjs';
import { materialType } from './material-formats.mjs';
import { checkMaterialSize } from '../src/domain/material-upload.mjs';
import { workbookPage } from './product-workbooks.mjs';
const fail = (n, msg) => Object.assign(new Error(msg), { status: n });
async function contents(request, name) {
  checkMaterialSize(name, Number(request.headers['content-length']));
  const chunks = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    checkMaterialSize(name, size);
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}
export async function handleMaterials({
  request,
  response,
  url,
  knowledge,
  env = {},
  fetchImpl,
  readJson,
  json,
  onChange,
  sites,
}) {
  const library = new MaterialLibrary(knowledge, sites?.() || []),
    path = url.pathname.slice('/api/v1/materials'.length);
  const method = request.method,
    q = Object.fromEntries(url.searchParams);
  if (!path && method === 'GET') {
    const categories = url.searchParams.getAll('category').filter(Boolean);
    return json(
      response,
      200,
      library.list({ ...q, category: categories.length ? categories : '' }),
    );
  }
  if (path === '/bulk' && method === 'POST') {
    const result = library.bulk(await readJson(request));
    onChange?.();
    return json(response, 200, result);
  }
  const match =
    /^\/(pk_[a-f0-9]{32})(?:\/(versions|restore|extract|document)(?:\/(pd_[a-f0-9]{64})(?:\/(rows))?)?)?$/.exec(
      path,
    );
  const [, id, op, docId, rows] = match || [];
  if (method === 'POST' && (!path || (op === 'versions' && !docId))) {
    const name = q.name || '',
      type = materialType(name);
    if (!type) throw fail(400, '不支持该文件类型');
    const key = request.headers['idempotency-key'];
    const data = await library.upload({
      name,
      site: q.site || '',
      category: q.category || '',
      version: q.version === undefined ? undefined : Number(q.version),
      id,
      bytes: await contents(request, name),
      key,
      env,
      fetchImpl,
    });
    onChange?.();
    return json(response, 201, data);
  }
  if (id && !op) {
    if (method === 'GET') return json(response, 200, library.detail(id, q.revision));
    if (method === 'PATCH') {
      const value = library.edit(id, await readJson(request, 4 * 1024 * 1024));
      onChange?.();
      return json(response, 200, { id, version: value.version });
    }
  }
  if (id && op === 'restore' && !docId && method === 'POST') {
    const { revision, version } = await readJson(request);
    if (!Number.isSafeInteger(revision) || revision >= version) throw fail(400, '请选择历史版本');
    const prior = library.detail(id, revision).product;
    const product = knowledge.save(
      { ...prior, version, status: 'draft', approvedBy: '' },
      { expectedVersion: version },
    );
    onChange?.();
    return json(response, 200, { id, version: product.version });
  }
  if (id && op === 'extract' && docId && method === 'POST') {
    await knowledge.documents.extract(id, docId, { env, fetchImpl });
    return json(response, 200, { ok: true });
  }
  if (id && op === 'document' && docId && method === 'GET') {
    if (rows) return json(response, 200, workbookPage(knowledge.db, id, docId, q));
    const meta = knowledge.db
      .prepare('SELECT metadata FROM product_documents WHERE id=? AND product_id=?')
      .get(docId, id);
    if (!meta) throw fail(404, '原件不存在');
    const file = JSON.parse(meta.metadata);
    const disposition = q.download === '1' ? 'attachment' : 'inline';
    const headers = {
      'Content-Type': file.contentType,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition + "; filename*=UTF-8''" + encodeURIComponent(file.name),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    };
    const range = request.headers.range;
    let start = 0,
      end = file.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match && match[1]) {
        start = Number(match[1]);
        if (match[2]) end = Math.min(end, Number(match[2]));
      } else if (match?.[2]) start = Math.max(0, file.size - Number(match[2]));
      if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || start > end) {
        response.writeHead(416, { ...headers, 'Content-Range': 'bytes */' + file.size });
        return response.end();
      }
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + file.size;
    }
    const length = end - start + 1;
    const { bytes } = knowledge.db
      .prepare(
        'SELECT substr(content,?,?) bytes FROM product_documents WHERE id=? AND product_id=?',
      )
      .get(start + 1, length, docId, id);
    response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': length });
    return response.end(Buffer.from(bytes));
  }
  throw fail(404, '素材接口不存在');
}
