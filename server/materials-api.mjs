import { randomUUID } from 'node:crypto';
import { MaterialLibrary } from './materials.mjs';
import { materialType } from './material-formats.mjs';
import {
  isPagedMaterial,
  checkMaterialSize,
  materialPartBytes,
  videoLimitMiB,
} from '../src/domain/material-upload.mjs';
import { workbookPage } from './product-workbooks.mjs';
const fail = (n, msg) => Object.assign(new Error(msg), { status: n });

// Return promptly through the public proxy while a catalogue is being recognised.
// Only progress and the small final receipt live here. Originals and passages are stored in SQLite.
function processMaterial(jobs, action) {
  const processingId = randomUUID();
  const job = { status: 202, result: { processingId } };
  jobs.set(processingId, job);
  void action((page, total) => {
    job.result = { processingId, page, total };
  })
    .then((result) => {
      job.status = 200;
      job.result = result;
    })
    .catch((error) => {
      job.status = error.status || 500;
      job.result = { error: error.status ? error.message : '原件提取失败，请重新打开资料重试。' };
    })
    .finally(() => setTimeout(() => jobs.delete(processingId), 5 * 60 * 1000).unref());
  return { processingId };
}
async function contents(request, name, expected) {
  const declared = Number(request.headers['content-length']);
  checkMaterialSize(name, declared);
  if (expected !== undefined && Number.isFinite(declared) && declared !== expected)
    throw fail(400, '素材分段长度无效');
  const chunks = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    checkMaterialSize(name, size);
    if (expected !== undefined && size > expected) throw fail(400, '素材分段长度无效');
    chunks.push(part);
  }
  if (expected !== undefined && size !== expected) throw fail(400, '素材分段不完整');
  return Buffer.concat(chunks, size);
}

// Keep incomplete uploads outside the library. Only the complete file enters its normal
// validation, parsing, idempotency and version transaction.
async function readUpload(request, name, key, target, uploads) {
  const range = request.headers['content-range'];
  if (range === undefined) return { bytes: await contents(request, name) };
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(range);
  if (!match || typeof key !== 'string' || !/^[\w-]{8,128}$/u.test(key))
    throw fail(400, '素材分段或操作编号无效');
  const [start, end, total] = match.slice(1).map(Number);
  checkMaterialSize(name, total);
  if (
    !Number.isSafeInteger(total) ||
    total <= materialPartBytes ||
    start >= total ||
    start % materialPartBytes !== 0 ||
    end !== Math.min(start + materialPartBytes, total) - 1
  )
    throw fail(400, '素材分段范围无效');
  const part = await contents(request, name, end - start + 1);
  let entry = uploads.get(key);
  if (!entry) {
    if (start !== 0) throw fail(409, '素材分段已失效，请重新上传');
    const reserved = [...uploads.values()].reduce((sum, item) => sum + item.buffer.length, 0);
    if (reserved + total > 2 * videoLimitMiB * 1024 ** 2)
      throw fail(429, '正在接收其他大文件，请稍后重试');
    entry = {
      target,
      buffer: Buffer.alloc(total),
      received: 0,
      timer: setTimeout(() => uploads.delete(key), 5 * 60 * 1000).unref(),
    };
    uploads.set(key, entry);
  }
  if (
    entry.target !== target ||
    entry.buffer.length !== total ||
    start > entry.received ||
    (start < entry.received && !entry.buffer.subarray(start, end + 1).equals(part))
  )
    throw fail(409, '素材分段冲突，请重新上传');
  if (start === entry.received) {
    part.copy(entry.buffer, start);
    entry.received = end + 1;
  }
  if (entry.received < total) {
    entry.timer.refresh();
    return { received: end + 1 };
  }
  clearTimeout(entry.timer);
  uploads.delete(key);
  return { bytes: entry.buffer };
}
export async function handleMaterials({
  request,
  response,
  url,
  knowledge,
  getEnv,
  fetchImpl,
  readJson,
  json,
  onChange,
  sites,
  uploads,
  jobs,
}) {
  const library = new MaterialLibrary(knowledge, sites?.() || []);
  const method = request.method,
    endpoint = url.pathname.slice('/api/v1/materials'.length);
  const progress = /^\/processing\/([\da-f-]{36})$/u.exec(endpoint);
  if (progress && method === 'GET') {
    const job = jobs.get(progress[1]);
    if (!job) throw fail(410, '提取进度已过期，请重新打开资料查看结果。');
    return json(response, job.status, job.result);
  }
  const respondAsync = request.headers.prefer === 'respond-async';
  const parts = method === 'POST' && /^\/(?:pk_[a-f0-9]{32}\/versions\/)?parts$/u.test(endpoint);
  const path = parts ? endpoint.slice(0, -'/parts'.length) : endpoint,
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
    if (parts !== (request.headers['content-range'] !== undefined))
      throw fail(400, '素材分段请求无效');
    const upload = await readUpload(request, name, key, url.pathname + url.search, uploads);
    if (!upload.bytes) return json(response, 202, upload);
    const save = async (onPage) => {
      const data = await library.upload({
        name,
        mode: q.mode,
        site: q.site || '',
        category: q.category || '',
        version: q.version === undefined ? undefined : Number(q.version),
        id,
        bytes: upload.bytes,
        key,
        env: getEnv(),
        fetchImpl,
        onPage,
      });
      onChange?.();
      return data;
    };
    if (isPagedMaterial(type) && respondAsync)
      return json(response, 202, processMaterial(jobs, save));
    return json(response, 201, await save());
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
    if (q.reparse === '1') {
      const { product, documents } = library.detail(id);
      if (product.status === 'archived' || !documents.some((d) => d.id === docId))
        throw fail(409, '只能重新解析当前在用版本。');
    }
    const extract = async (onPage) => {
      await knowledge.documents.extract(id, docId, {
        env: getEnv(),
        fetchImpl,
        material: true,
        onPage,
        mode: q.mode,
        reparse: q.reparse === '1',
      });
      return { ok: true };
    };
    if (respondAsync) return json(response, 202, processMaterial(jobs, extract));
    return json(response, 200, await extract());
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
