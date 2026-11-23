import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { ProductDocuments } from './product-documents.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const categories = ['ventilation', 'shutters', 'indoor', 'outdoor', 'other'];
const directions = ['finished', 'materials', 'samples'];
const statuses = ['draft', 'approved', 'archived'];
const factKeys = [
  'name',
  'englishName',
  'category',
  'direction',
  'deliveryForms',
  'aliases',
  'specifications',
  'moq',
  'leadTime',
  'brands',
  'markets',
  'sourceUrl',
  'attachments',
  'effectiveDate',
  'notes',
  'outreachFacts',
  'documentIds',
  'cellEdits',
  'materialOnly',
  'materialCategory',
  'keywords',
  'sourceFacts',
];
const allowedKeys = new Set([
  ...factKeys,
  'id',
  'status',
  'version',
  'approvedBy',
  'approvedAt',
  'updatedAt',
  'createdAt',
]);

function text(value, name, max, required = false) {
  if (value === undefined && !required) return '';
  if (
    typeof value !== 'string' ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  )
    throw fail(400, name + '格式错误或内容过长');
  const result = value.trim();
  if (required && !result) throw fail(400, '请填写' + name);
  return result;
}

function list(value, name, maxItems, maxLength) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw fail(400, name + '数量或格式不正确');
  return [...new Set(value.map((item) => text(item, name, maxLength, true)))];
}

function outreachFacts(value = []) {
  if (!Array.isArray(value) || value.length > 30)
    throw fail(400, '开发信事实最多30条，且必须为列表');
  const ids = new Set();
  return value.map((fact) => {
    if (
      !fact ||
      typeof fact !== 'object' ||
      Array.isArray(fact) ||
      Object.keys(fact).some(
        (key) => !['id', 'kind', 'text', 'conditions', 'validUntil'].includes(key),
      )
    )
      throw fail(400, '开发信事实包含无效或不支持的字段');
    const id = text(fact.id, '开发信事实编号', 100, true);
    if (!/^[A-Za-z0-9_-]+$/u.test(id) || ids.has(id))
      throw fail(400, '开发信事实编号必须唯一，且只能包含英文字母、数字、下划线和连字符');
    ids.add(id);
    if (!['product', 'price', 'moq', 'stock', 'leadTime', 'freight', 'payment'].includes(fact.kind))
      throw fail(400, '开发信事实类型不正确');
    const conditions = text(fact.conditions, '开发信事实适用条件', 800, fact.kind === 'price');
    let validUntil = null;
    if (fact.validUntil != null) {
      const date = text(fact.validUntil, '开发信事实有效期', 40, true);
      if (
        !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(
          date,
        ) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date.slice(0, 10)).toISOString().slice(0, 10) !== date.slice(0, 10)
      )
        throw fail(400, '开发信事实有效期必须为有效且包含时区的 ISO 时间');
      validUntil = new Date(date).toISOString();
    }
    if (['price', 'stock', 'leadTime', 'freight'].includes(fact.kind) && !validUntil)
      throw fail(400, '价格、库存、交期和运费事实必须填写有效期');
    return {
      id,
      kind: fact.kind,
      text: text(fact.text, '开发信事实正文', 1200, true),
      conditions,
      validUntil,
    };
  });
}

function storedProduct(row) {
  const product = JSON.parse(row.data);
  return { ...product, outreachFacts: product.outreachFacts ?? [] };
}

function safeUrl(value, name) {
  const result = text(value, name, 2000);
  if (!result) return '';
  let url;
  try {
    url = new URL(result);
  } catch {
    throw fail(400, name + '必须为有效的公开网页链接');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipv4 = isIP(host) === 4 ? host.split('.').map(Number) : null;
  const localIp =
    ipv4 &&
    (ipv4[0] === 0 ||
      ipv4[0] === 10 ||
      ipv4[0] === 127 ||
      ipv4[0] >= 224 ||
      (ipv4[0] === 169 && ipv4[1] === 254) ||
      (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
      (ipv4[0] === 192 && ipv4[1] === 168) ||
      (ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127));
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    /[\s\\]/u.test(result) ||
    !host.includes('.') ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    localIp ||
    isIP(host) === 6
  )
    throw fail(400, name + '只支持不含账号密码的公开 HTTP/HTTPS 链接');
  return url.href;
}

function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fail(400, '产品资料格式不正确');
  if (Object.keys(value).some((key) => !allowedKeys.has(key)))
    throw fail(400, '产品资料包含不支持的字段');
  const category = value.category ?? 'other';
  const direction = value.direction;
  const status = value.status ?? 'draft';
  if (!categories.includes(category)) throw fail(400, '请选择有效的产品品类');
  if (!directions.includes(direction)) throw fail(400, '请选择产品供货方向');
  if (!statuses.includes(status)) throw fail(400, '产品审核状态不正确');
  const effectiveDate = text(value.effectiveDate, '生效日期', 10);
  if (
    effectiveDate &&
    (!/^\d{4}-\d{2}-\d{2}$/u.test(effectiveDate) ||
      !Number.isFinite(Date.parse(effectiveDate)) ||
      new Date(effectiveDate).toISOString().slice(0, 10) !== effectiveDate)
  )
    throw fail(400, '生效日期必须是有效的 YYYY-MM-DD 日期');
  const attachments = list(value.attachments, '附件链接', 10, 2000).map((url) =>
    safeUrl(url, '附件链接'),
  );
  const documentIds = list(value.documentIds, '原文件编号', 20, 67);
  const edits = value.cellEdits ?? [];
  if (!Array.isArray(edits) || edits.length > 500) throw fail(400, '每个产品最多校对 500 个单元格');
  const cellEdits = edits.map((edit) => {
    if (
      !edit ||
      !documentIds.includes(edit.documentId) ||
      !/^[A-Z]{1,3}[1-9]\d{0,4}$/u.test(edit.ref)
    )
      throw fail(400, '校对单元格必须属于已关联工作簿');
    return {
      documentId: edit.documentId,
      sheet: text(edit.sheet, '工作表', 100, true),
      ref: edit.ref,
      value: text(edit.value, '校对值', 4000),
    };
  });
  if (value.materialOnly !== undefined && value.materialOnly !== true)
    throw fail(400, '资料类型无效');
  const keywords = list(value.keywords, '素材关键词', 32, 100);
  const materialCategory = text(value.materialCategory, '素材品类', 100);
  const sourceFacts = value.sourceFacts ?? [];
  if (!Array.isArray(sourceFacts) || sourceFacts.length > 200)
    throw fail(400, '最多可核对 200 个引用片段');
  const checked = sourceFacts.map((f) => {
    if (!f || !documentIds.includes(f.documentId)) throw fail(400, '引用原件必须属于当前资料');
    return {
      documentId: f.documentId,
      location: text(f.location, '原件位置', 160, true),
      text: text(f.text, '引用片段', 4000, true),
    };
  });
  if (documentIds.some((id) => !/^pd_[a-f0-9]{64}$/u.test(id))) throw fail(400, '原文件编号无效');
  return {
    name: text(value.name, '产品名称', 160, true),
    englishName: text(value.englishName, '产品英文名称', 160),
    category,
    direction,
    deliveryForms: list(value.deliveryForms, '采购形态', 10, 80),
    aliases: list(value.aliases, '产品别名', 20, 100),
    specifications: text(value.specifications, '已核实参数', 12000),
    moq: text(value.moq, '起订量', 500),
    leadTime: text(value.leadTime, '常规交期', 500),
    brands: list(value.brands, '适用品牌', 20, 100),
    markets: list(value.markets, '适用市场', 30, 100),
    sourceUrl: safeUrl(value.sourceUrl, '来源链接'),
    attachments: [...new Set(attachments)],
    effectiveDate,
    status,
    approvedBy: text(value.approvedBy, '审核人', 100),
    notes: text(value.notes, '备注', 4000),
    outreachFacts: outreachFacts(value.outreachFacts),
    ...(value.materialOnly ? { materialOnly: true } : {}),
    ...(materialCategory ? { materialCategory } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(checked.length ? { sourceFacts: checked } : {}),
    ...(documentIds.length ? { documentIds } : {}),
    ...(cellEdits.length ? { cellEdits } : {}),
  };
}

// Company supply facts are separate from the acquisition search vocabulary.
// Approval applies to the current facts. Previous revisions keep their document links for review.
export class ProductKnowledge {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS product_knowledge(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS material_updated ON product_knowledge(json_extract(data,'$.updatedAt') DESC,id);
      CREATE INDEX IF NOT EXISTS material_category_page ON product_knowledge(
        COALESCE(json_extract(data,'$.materialCategory'),'未分类'),json_extract(data,'$.updatedAt') DESC,id,json_extract(data,'$.documentIds[0]'));
      CREATE TABLE IF NOT EXISTS product_knowledge_requests(
        request_key TEXT PRIMARY KEY, body_hash TEXT NOT NULL, product_id TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS material_versions(
        product_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(product_id,revision)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS material_upload_requests(
        request_key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, product_id TEXT NOT NULL, document_id TEXT NOT NULL
      );`);
    this.documents = new ProductDocuments(this.db);
  }
  get(id) {
    const row = this.db.prepare('SELECT data FROM product_knowledge WHERE id=?').get(id);
    return row ? storedProduct(row) : null;
  }
  list({ status, usableOnly = false } = {}) {
    if (status !== undefined && !statuses.includes(status)) throw fail(400, '产品审核状态不正确');
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
      new Date(),
    );
    return this.db
      .prepare('SELECT data FROM product_knowledge ORDER BY rowid')
      .all()
      .map(storedProduct)
      .filter(
        (product) =>
          (!status || product.status === status) &&
          (!usableOnly ||
            (product.status === 'approved' &&
              (!product.effectiveDate || product.effectiveDate <= today))),
      );
  }
  save(value, { expectedVersion, idempotencyKey, initialUpload = false } = {}) {
    const normalized = normalize(value);
    if (
      idempotencyKey !== undefined &&
      (value.id || typeof idempotencyKey !== 'string' || !/^[\w-]{8,100}$/.test(idempotencyKey))
    )
      throw fail(400, '新增产品资料需要有效的操作编号');
    const { outreachFacts: facts, ...legacyFacts } = normalized;
    const bodyHash = createHash('sha256')
      .update(JSON.stringify(facts.length ? normalized : legacyFacts))
      .digest('hex');
    const owned = !this.db.isTransaction;
    if (owned) this.db.exec('BEGIN IMMEDIATE');
    try {
      if (idempotencyKey) {
        const request = this.db
          .prepare('SELECT * FROM product_knowledge_requests WHERE request_key=?')
          .get(idempotencyKey);
        if (request) {
          if (request.body_hash !== bodyHash) throw fail(409, '同一操作编号不能提交不同的产品资料');
          const existing = this.get(request.product_id);
          if (!existing) throw fail(409, '产品操作结果待核对，请刷新资料库');
          if (owned) this.db.exec('COMMIT');
          return existing;
        }
      }
      const prior = value.id ? this.get(value.id) : null;
      if (value.id && !prior) throw fail(404, '产品资料不存在，请刷新资料库');
      if (prior && !!prior.materialOnly !== !!normalized.materialOnly)
        throw fail(400, '不能变更资料类型');
      const expected = expectedVersion ?? value.version;
      if (prior && (!Number.isInteger(expected) || expected !== prior.version))
        throw fail(409, '产品资料已更新，请刷新后再保存');
      if (!prior && expected !== undefined && expected !== 0)
        throw fail(409, '新产品资料不能指定已有版本');
      for (const id of normalized.documentIds || []) {
        const document = this.db
          .prepare('SELECT product_id FROM product_documents WHERE id=?')
          .get(id);
        if (!document || document.product_id !== prior?.id)
          throw fail(400, '原文件必须属于当前产品，请刷新资料后重试');
      }
      for (const edit of normalized.cellEdits || []) {
        const row = this.db
          .prepare(
            'SELECT data FROM product_workbook_rows WHERE document_id=? AND sheet=? AND row_number=?',
          )
          .get(edit.documentId, edit.sheet, Number(edit.ref.match(/\d+$/u)[0]));
        if (!row || !JSON.parse(row.data).some((cell) => cell.ref === edit.ref))
          throw fail(400, '校对位置在原工作簿中不存在');
      }
      const changedFacts =
        prior &&
        factKeys.some((key) => JSON.stringify(prior[key]) !== JSON.stringify(normalized[key]));
      const needsReview =
        prior?.status === 'approved' && changedFacts && normalized.status !== 'archived';
      if (needsReview) normalized.status = 'draft';
      if (
        normalized.status === 'approved' &&
        (!normalized.approvedBy ||
          (!normalized.sourceUrl &&
            !normalized.attachments.length &&
            !normalized.documentIds?.length))
      )
        throw fail(400, '审核通过需要填写审核人及产品来源、附件链接或已关联原文件');
      const now = new Date().toISOString();
      const approvedUnchanged =
        prior?.status === 'approved' && !changedFacts && prior.approvedBy === normalized.approvedBy;
      const product = {
        id: prior?.id || 'pk_' + randomUUID().replaceAll('-', ''),
        ...normalized,
        version: initialUpload ? 1 : (prior?.version || 0) + 1,
        approvedBy: normalized.status === 'approved' ? normalized.approvedBy : '',
        approvedAt:
          normalized.status === 'approved' ? (approvedUnchanged ? prior.approvedAt : now) : '',
        createdAt: prior?.createdAt || now,
        updatedAt: now,
      };
      this.db
        .prepare(
          'INSERT INTO product_knowledge(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(product.id, JSON.stringify(product));
      if (idempotencyKey)
        this.db
          .prepare('INSERT INTO product_knowledge_requests VALUES(?,?,?)')
          .run(idempotencyKey, bodyHash, product.id);
      if (prior && !initialUpload)
        this.db
          .prepare('INSERT OR IGNORE INTO material_versions VALUES(?,?,?)')
          .run(prior.id, prior.version, JSON.stringify(prior));
      if (owned) this.db.exec('COMMIT');
      return product;
    } catch (error) {
      if (owned) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
