import { createHash } from 'node:crypto';
import { mailSite, siteAllowsProduct } from '../src/domain/mail-site.mjs';
import { materialType, validateFile } from './material-formats.mjs';
import { parsesLocally } from './product-documents.mjs';

const fail = (status, msg) => Object.assign(new Error(msg), { status });
const formats = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'text/markdown': 'Markdown',
  'text/plain': 'TXT',
};
const kind = (t) =>
  formats[t] || (t?.startsWith('image/') ? '图片' : t?.startsWith('video/') ? '视频' : '产品资料');
export const siteOptions = (boxes) => [
  ...new Map(
    boxes
      .filter((b) => mailSite(b.website))
      .map((b) => [
        mailSite(b.website),
        { site: mailSite(b.website), brand: b.brandName || mailSite(b.website) },
      ]),
  ).values(),
];
const scoped = (product, sites) =>
  sites
    .filter((s) => siteAllowsProduct(product, { website: s.site, brandName: s.brand }, true))
    .map((s) => s.site);
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
const installed = new WeakSet();
export class MaterialLibrary {
  constructor(knowledge, boxes = []) {
    this.k = knowledge;
    this.db = knowledge.db;
    this.sites = siteOptions(boxes);
    if (!installed.has(this.db)) {
      this.db.function('asset_format', { deterministic: true }, kind);
      this.db.function('asset_sites', { deterministic: true }, (url, brands, sites) =>
        JSON.stringify(
          scoped({ sourceUrl: url || '', brands: JSON.parse(brands || '[]') }, JSON.parse(sites)),
        ),
      );
      installed.add(this.db);
    }
  }
  scope(site) {
    if (!site) return { sourceUrl: '', brands: [] };
    const info = this.sites.find((x) => x.site === site);
    if (!info) throw fail(400, '请选择已连接邮箱对应的官网');
    return { sourceUrl: 'https://' + info.site, brands: [info.site] };
  }
  list({
    q = '',
    site = '',
    category = '',
    format = '',
    status = 'active',
    page = 1,
    pageSize = 20,
  } = {}) {
    page = Number(page);
    pageSize = Number(pageSize);
    if (
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100000 ||
      ![10, 20, 50].includes(pageSize) ||
      String(q).length > 200 ||
      !['active', 'draft', 'approved', 'archived', 'all'].includes(status)
    )
      throw fail(400, '素材筛选条件无效');
    const from = `FROM product_knowledge p LEFT JOIN product_documents d ON d.id=COALESCE(json_extract(p.data,'$.documentIds[0]'),(SELECT id FROM product_documents WHERE product_id=p.id ORDER BY rowid DESC LIMIT 1))`;
    const fields = `p.id,json_extract(p.data,'$.name') AS name,json_extract(p.data,'$.version') AS version,json_extract(p.data,'$.status') AS status,
      json_extract(p.data,'$.updatedAt') AS updatedAt,COALESCE(json_extract(p.data,'$.materialCategory'),'未分类') AS category,
      COALESCE(json_extract(p.data,'$.keywords'),'[]') AS keywords, json_extract(p.data,'$.sourceUrl') AS sourceUrl, json_extract(p.data,'$.brands') AS brands,
      d.id AS documentId,json_extract(d.metadata,'$.contentType') AS contentType,COALESCE(json_extract(d.metadata,'$.size'),0) AS size,asset_format(json_extract(d.metadata,'$.contentType')) AS format`;
    const cond = ['documentId IS NOT NULL'],
      args = [];
    if (q) {
      cond.push('(instr(lower(name),lower(?))>0 OR instr(lower(keywords),lower(?))>0)');
      args.push(q, q);
    }
    if (site) {
      const expr = 'asset_sites(sourceUrl,brands,?)';
      cond.push(
        site === 'unassigned'
          ? expr + "='[]'"
          : 'EXISTS(SELECT 1 FROM json_each(' + expr + ') WHERE value=?)',
      );
      args.push(JSON.stringify(this.sites));
      if (site !== 'unassigned') args.push(site);
    }
    if (category) {
      const values = Array.isArray(category) ? category : [category];
      if (values.length > 100) throw fail(400, '品类数量过多');
      cond.push('category IN (' + values.map(() => '?').join(',') + ')');
      args.push(...values);
    }
    if (format) {
      cond.push('format=?');
      args.push(format);
    }
    if (status !== 'all') {
      cond.push(status === 'active' ? "status!='archived'" : 'status=?');
      if (status !== 'active') args.push(status);
    }
    const select =
      ' FROM (SELECT ' +
      fields +
      ' ' +
      from +
      ')' +
      (cond.length ? ' WHERE ' + cond.join(' AND ') : '');
    const total = this.db.prepare('SELECT COUNT(*) n' + select).get(...args).n;
    page = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const rows = this.db
      .prepare(
        `SELECT visible.*, (SELECT json_array(w.sheet,
        substr(json_extract(w.data,'$[0].field'),1,48),substr(json_extract(w.data,'$[0].value'),1,64),
        substr(json_extract(w.data,'$[1].field'),1,48),substr(json_extract(w.data,'$[1].value'),1,64),
        substr(json_extract(w.data,'$[2].field'),1,48),substr(json_extract(w.data,'$[2].value'),1,64))
        FROM product_workbook_rows w WHERE w.document_id=visible.documentId
        ORDER BY w.sheet,w.row_number LIMIT 1) preview FROM (SELECT *` +
          select +
          ' ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?) visible',
      )
      .all(...args, pageSize, (page - 1) * pageSize);
    const items = rows.map(({ brands, sourceUrl, ...x }) => ({
      ...x,
      sites: scoped({ sourceUrl, brands: JSON.parse(brands || '[]') }, this.sites),
      keywords: JSON.parse(x.keywords),
      preview: x.preview ? JSON.parse(x.preview) : null,
    }));
    const categories = this.db
      .prepare(
        "SELECT DISTINCT COALESCE(json_extract(p.data,'$.materialCategory'),'未分类') v " +
          from +
          ' WHERE d.id IS NOT NULL ORDER BY v',
      )
      .all()
      .map((r) => r.v);
    return { items, total, page, pageSize, categories, sites: this.sites };
  }
  get(id) {
    const p = this.k.get(id);
    if (!p) throw fail(404, '素材不存在');
    return p;
  }
  detail(id, revision) {
    const current = this.get(id);
    let p = current;
    if (revision && Number(revision) !== current.version) {
      const row = this.db
        .prepare('SELECT data FROM material_versions WHERE product_id=? AND revision=?')
        .get(id, Number(revision));
      if (!row) throw fail(404, '资料版本不存在');
      p = JSON.parse(row.data);
    }
    const all = this.k.documents.list(id);
    const linked = (p.documentIds || []).map((id) => all.find((d) => d.id === id)).filter(Boolean);
    return {
      product: p,
      sites: scoped(p, this.sites),
      siteOptions: this.sites,
      currentVersion: current.version,
      documents:
        p === current && !p.materialOnly
          ? [...linked, ...all.filter((d) => !linked.some((x) => x.id === d.id))]
          : linked,
      history: [
        current.version,
        ...this.db
          .prepare(
            'SELECT revision FROM material_versions WHERE product_id=? ORDER BY revision DESC',
          )
          .all(id)
          .map((r) => r.revision),
      ],
    };
  }
  async upload({
    name,
    bytes,
    site = '',
    category = '',
    id = '',
    version,
    key,
    env = {},
    fetchImpl,
    onPage,
  }) {
    if (typeof key !== 'string' || !/^[\w-]{8,128}$/.test(key))
      throw fail(400, '缺少有效的上传操作编号');
    const contentType = materialType(name);
    validateFile(name, contentType, bytes);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([id, version, name, site, category]))
      .update(bytes)
      .digest('hex');
    const file = { name, contentType, bytes };
    const findRequest = this.db.prepare(
      'SELECT * FROM material_upload_requests WHERE request_key=?',
    );
    const currentVersion = () => {
      const p = this.get(id);
      if (p.version !== Number(version) || p.status === 'archived')
        throw fail(409, '资料状态已变化，请刷新');
      return p;
    };
    // Parse outside the write transaction. A bad replacement must leave the active version usable.
    let prepared;
    if (id && parsesLocally(contentType) && !findRequest.get(key)) {
      currentVersion();
      prepared = await this.k.documents.prepareReplacement(file, onPage);
    }
    const record = transaction(this.db, () => {
      const prior = findRequest.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw fail(409, '此操作编号已用于其他文件');
        return { id: prior.product_id, documentId: prior.document_id, reused: true };
      }
      if (!id) {
        const digest = createHash('sha256').update(bytes).digest('hex');
        const matches = this.db
          .prepare(
            "SELECT id,product_id FROM product_documents WHERE json_extract(metadata,'$.sha256')=? AND json_extract(metadata,'$.contentType')=? ORDER BY rowid",
          )
          .all(digest, contentType);
        for (const d of matches) {
          const p = this.get(d.product_id),
            sites = scoped(p, this.sites);
          if (
            !p.documentIds?.includes(d.id) ||
            (site ? !sites.includes(site) : p.sourceUrl || p.brands?.length)
          )
            continue;
          if (p.status === 'archived') throw fail(409, '该原件已撤回，可在已撤回素材中恢复');
          this.db
            .prepare('INSERT INTO material_upload_requests VALUES(?,?,?,?)')
            .run(key, fingerprint, p.id, d.id);
          return { id: p.id, documentId: d.id, reused: true };
        }
      }
      const product = id
        ? currentVersion()
        : this.k.save({
            name: name.replace(/\.[^.]+$/, '').slice(0, 160) || name,
            direction: 'materials',
            materialOnly: true,
            materialCategory: category || '未分类',
            ...this.scope(site),
          });
      const document = this.k.documents.store(product.id, file);
      if (
        prepared &&
        (!document.extraction ||
          (contentType === 'application/pdf' && !document.extraction.facts.length))
      )
        this.k.documents.saveLocalExtraction(document.id, prepared);
      const ids = product.documentIds || [];
      // Historical products may link several independent files. Replace only the primary file.
      const documentIds = [...new Set([document.id, ...ids.slice(1)])];
      if (document.id !== ids[0]) {
        this.k.save(
          {
            ...product,
            documentIds,
            status: 'draft',
            cellEdits: (product.cellEdits || []).filter((e) => documentIds.includes(e.documentId)),
            sourceFacts: (product.sourceFacts || []).filter((e) =>
              documentIds.includes(e.documentId),
            ),
          },
          { initialUpload: !id },
        );
      }
      this.db
        .prepare('INSERT INTO material_upload_requests VALUES(?,?,?,?)')
        .run(key, fingerprint, product.id, document.id);
      return { id: product.id, documentId: document.id, reused: document.id === ids[0] };
    });
    let warning = '';
    try {
      if (!prepared && parsesLocally(contentType))
        await this.k.documents.extract(record.id, record.documentId, {
          env,
          fetchImpl,
          pdfText: true,
          onPage,
        });
    } catch (e) {
      warning = e.message;
    }
    return { ...record, warning };
  }
  edit(id, value) {
    const p = this.get(id);
    if (!value || value.version !== p.version) throw fail(409, '素材已变更，请刷新后重试');
    const allowed = new Set([
      'version',
      'name',
      'category',
      'keywords',
      'site',
      'status',
      'approvedBy',
      'cellEdits',
      'sourceFacts',
      'adoptDocumentId',
    ]);
    if (Object.keys(value).some((k) => !allowed.has(k))) throw fail(400, '素材编辑字段无效');
    const updates = {};
    if (value.adoptDocumentId) {
      if (
        !this.db
          .prepare('SELECT 1 FROM product_documents WHERE id=? AND product_id=?')
          .get(value.adoptDocumentId, id)
      )
        throw fail(400, '原文件不属于当前资料');
      updates.documentIds = [...new Set([...(p.documentIds || []), value.adoptDocumentId])];
    }
    for (const k of ['name', 'keywords', 'status', 'approvedBy', 'cellEdits', 'sourceFacts'])
      if (Object.hasOwn(value, k)) updates[k] = value[k];
    if (Object.hasOwn(value, 'category')) updates.materialCategory = value.category || '未分类';
    if (Object.hasOwn(value, 'site')) Object.assign(updates, this.scope(value.site));
    if (
      value.status === 'approved' &&
      !(
        updates.documentIds?.length ||
        p.documentIds?.length ||
        p.sourceUrl ||
        p.attachments?.length
      )
    )
      throw fail(400, '需要有可核对的来源');
    return this.k.save({ ...p, ...updates });
  }
  bulk(value) {
    if (
      !Array.isArray(value?.items) ||
      !value.items.length ||
      value.items.length > 500 ||
      new Set(value.items.map((x) => x.id)).size !== value.items.length
    )
      throw fail(400, '请选择 1 至 500 份素材');
    if (
      !value.changes ||
      Object.keys(value.changes).some(
        (k) => !['category', 'site', 'keywords', 'status'].includes(k),
      ) ||
      ('status' in value.changes && !['archived', 'draft'].includes(value.changes.status))
    )
      throw fail(400, '无效的批量操作');
    return transaction(this.db, () => {
      for (const { id, version } of value.items) this.edit(id, { ...value.changes, version });
      return { updated: value.items.length };
    });
  }
}
