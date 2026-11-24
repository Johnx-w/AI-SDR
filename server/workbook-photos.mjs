import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { mentionsModel } from './model-parameters.mjs';
import { otherSitesInText, siteAllowsProduct } from '../src/domain/mail-site.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const conflict = () => fail(409, '图片、型号或资料版本已变化，请刷新后重新核对');
const photoId = () => 'kbphoto_' + randomUUID();
const metadata = 'id,document_id AS documentId,sheet,item,slot,origin';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function transaction(db, fn) {
  const nested = db.isTransaction;
  db.exec(nested ? 'SAVEPOINT workbook_images' : 'BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec(nested ? 'RELEASE workbook_images' : 'COMMIT');
    return value;
  } catch (e) {
    db.exec(nested ? 'ROLLBACK TO workbook_images; RELEASE workbook_images' : 'ROLLBACK');
    throw e;
  }
}
export function declinesPhotos(query) {
  return /(?:不要|无需|不用|不需要|请勿|别发).{0,10}(?:图|附件)|(?:no|without|do not (?:send|attach)|don't (?:send|attach))\s+(?:any\s+)?(?:product\s+)?(?:photos?|images?|pictures?|attachments?)|text[- ]only|仅需文字|只要文字/iu.test(
    query,
  );
}
export class WorkbookPhotos {
  constructor(db) {
    this.db = db;
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='workbook_image_assets'").get()) return;
    transaction(db, () => {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='workbook_image_assets'").get())
        return;
      db.exec(`CREATE TABLE workbook_image_assets(id TEXT PRIMARY KEY, document_id TEXT NOT NULL,sheet TEXT NOT NULL,item TEXT NOT NULL,slot TEXT NOT NULL,origin TEXT NOT NULL,sha TEXT NOT NULL,jpeg BLOB NOT NULL CHECK(length(jpeg) BETWEEN 1 AND 524288),active INTEGER NOT NULL DEFAULT 1,legacy_id TEXT);
      CREATE UNIQUE INDEX workbook_image_slot ON workbook_image_assets(document_id,sheet,item,slot) WHERE active=1;
      CREATE INDEX workbook_image_legacy ON workbook_image_assets(legacy_id) WHERE legacy_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS workbook_row_model ON product_workbook_rows(document_id,label COLLATE NOCASE,sheet);`);
      const insert = db.prepare('INSERT INTO workbook_image_assets VALUES(?,?,?,?,?,?,?,?,1,?)');
      for (const r of db.prepare('SELECT * FROM product_workbook_photos').all()) {
        const legacy =
          'attachment_' +
          createHash('sha256')
            .update(r.item + '.jpg')
            .update(r.jpeg)
            .digest('hex')
            .slice(0, 24);
        insert.run(
          photoId(),
          r.document_id,
          r.sheet,
          r.item,
          '主图',
          r.sheet + '!' + r.source_cell,
          digest(r.jpeg),
          r.jpeg,
          legacy,
        );
      }
    });
  }
  owned(product, doc, write = false) {
    if (
      !this.db
        .prepare('SELECT 1 FROM product_documents WHERE id=? AND product_id=?')
        .get(doc, product)
    )
      throw fail(404, '工作簿不存在');
    if (write) {
      const p = this.db.prepare('SELECT data FROM product_knowledge WHERE id=?').get(product);
      const current = JSON.parse(p.data);
      if (current.status === 'archived' || current.documentIds?.[0] !== doc) throw conflict();
    }
  }
  list(product, doc, q) {
    this.owned(product, doc);
    const filter = ['r.document_id=?', "r.sheet!='品类索引'"],
      args = [doc];
    if (q.sheet) {
      filter.push('r.sheet=?');
      args.push(q.sheet);
    }
    if (q.q) {
      filter.push('instr(lower(r.label),lower(?))>0');
      args.push(q.q);
    }
    if (q.missing === '1')
      filter.push(
        "NOT EXISTS(SELECT 1 FROM workbook_image_assets a WHERE a.active=1 AND a.document_id=r.document_id AND a.sheet=r.sheet AND a.item=r.label AND a.slot='主图')",
      );
    const grouped =
      ' FROM product_workbook_rows r WHERE ' + filter.join(' AND ') + ' GROUP BY r.sheet,r.label';
    const total = this.db
      .prepare('SELECT COUNT(*) n FROM (SELECT 1' + grouped + ')')
      .get(...args).n;
    const page = Math.min(Math.max(1, Math.ceil(total / 20)), Math.max(1, parseInt(q.page) || 1));
    const rows = this.db
      .prepare(
        'SELECT sheet,label AS item,count(*) AS occurrences' +
          grouped +
          ' ORDER BY r.sheet,min(r.row_number) LIMIT 20 OFFSET ?',
      )
      .all(...args, (page - 1) * 20);
    const photos = this.db
      .prepare(
        'SELECT ' +
          metadata +
          " FROM workbook_image_assets WHERE active=1 AND document_id=? AND (sheet,item) IN (SELECT json_extract(value,'$.sheet'),json_extract(value,'$.item') FROM json_each(?)) ORDER BY slot!='主图',slot",
      )
      .all(doc, JSON.stringify(rows));
    return {
      page,
      total,
      rows: rows.map((r) => ({
        ...r,
        photos: photos.filter((p) => p.sheet === r.sheet && p.item === r.item),
      })),
    };
  }
  image(product, doc, id) {
    this.owned(product, doc);
    const row = this.db
      .prepare('SELECT jpeg FROM workbook_image_assets WHERE active=1 AND document_id=? AND id=?')
      .get(doc, id);
    if (!row) throw fail(404, '该图片已被移除或替换');
    return Buffer.from(row.jpeg);
  }
  async change(product, doc, input) {
    const { sheet, item, slot, expectedId, remove, contentBase64 } = input;
    if (
      ![sheet, item, slot].every(
        (v) => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 255,
      ) ||
      slot.length > 40 ||
      /[\\/\p{Cc}]/u.test(slot) ||
      !(expectedId === null || typeof expectedId === 'string')
    )
      throw fail(400, '请指定工作表、型号、图片用途及当前版本');
    this.owned(product, doc, true);
    let bytes;
    if (remove !== true) {
      if (typeof contentBase64 !== 'string' || contentBase64.length > 8 * 1024 * 1024)
        throw fail(413, '请选择 6 MB 以内的图片');
      try {
        const src = Buffer.from(contentBase64, 'base64');
        const image = sharp(src, { limitInputPixels: 32 * 1024 * 1024 });
        if (!['jpeg', 'png', 'webp'].includes((await image.metadata()).format)) throw Error();
        bytes = await image
          .rotate()
          .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: 'white' })
          .jpeg({ quality: 80 })
          .toBuffer();
        if (bytes.length > 524288)
          bytes = await sharp(bytes)
            .resize({ width: 900, height: 900, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 67 })
            .toBuffer();
      } catch {
        throw fail(422, '请选择可读取的 JPEG、PNG 或 WebP 图片');
      }
      if (bytes.length > 524288) throw fail(413, '图片压缩后仍过大，请缩小图片再试');
    }
    return transaction(this.db, () => {
      this.owned(product, doc, true);
      if (this.count(doc, sheet, item) !== 1) throw conflict();
      const old = this.db
        .prepare(
          'SELECT id FROM workbook_image_assets WHERE active=1 AND document_id=? AND sheet=? AND item=? AND slot=?',
        )
        .get(doc, sheet, item, slot);
      if ((old?.id ?? null) !== expectedId || (!bytes && !old)) throw conflict();
      if (old) this.db.prepare('UPDATE workbook_image_assets SET active=0 WHERE id=?').run(old.id);
      const id = bytes ? photoId() : null;
      if (bytes)
        this.db
          .prepare(
            'INSERT INTO workbook_image_assets(id,document_id,sheet,item,slot,origin,sha,jpeg) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(id, doc, sheet, item, slot, '人工上传', digest(bytes), bytes);
      return { id };
    });
  }
  count(doc, sheet, item) {
    return this.db
      .prepare(
        'SELECT count(*) n FROM product_workbook_rows WHERE document_id=? AND sheet=? AND label=? COLLATE NOCASE',
      )
      .get(doc, sheet, item).n;
  }
  previous(product, doc) {
    return this.db
      .prepare(
        "SELECT json_extract(data,'$.documentIds[0]') id FROM material_versions WHERE product_id=? AND json_extract(data,'$.documentIds[0]')<>? ORDER BY revision DESC LIMIT 1",
      )
      .get(product, doc)?.id;
  }
  suggestions(product, doc) {
    this.owned(product, doc, true);
    const prior = this.previous(product, doc);
    if (!prior) return [];
    const pics = this.db
      .prepare(
        'SELECT ' +
          metadata +
          ' FROM workbook_image_assets WHERE active=1 AND document_id=? ORDER BY sheet,item,slot',
      )
      .all(prior);
    const occupied = this.db.prepare(
      'SELECT 1 FROM workbook_image_assets WHERE active=1 AND document_id=? AND sheet=? AND item=? AND slot=?',
    );
    return pics.map((p) => {
      const n = this.count(doc, p.sheet, p.item);
      const exact = this.db
        .prepare('SELECT 1 FROM product_workbook_rows WHERE document_id=? AND sheet=? AND label=?')
        .get(doc, p.sheet, p.item);
      const reason = !exact
        ? '型号缺失或已更名'
        : n !== 1 || this.count(prior, p.sheet, p.item) !== 1
          ? '型号重复'
          : occupied.get(doc, p.sheet, p.item, p.slot)
            ? '已有图片'
            : '';
      return { ...p, reason };
    });
  }
  carry(product, doc, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || new Set(ids).size !== ids.length)
      throw fail(400, '请选择要沿用的图片');
    return transaction(this.db, () => {
      const valid = new Map(this.suggestions(product, doc).map((p) => [p.id, p]));
      const copy = this.db.prepare(
        'INSERT INTO workbook_image_assets(id,document_id,sheet,item,slot,origin,sha,jpeg) SELECT ?,?,sheet,item,slot,?,sha,jpeg FROM workbook_image_assets WHERE id=? AND active=1',
      );
      for (const id of ids) {
        const p = valid.get(id);
        if (!p || p.reason) throw conflict();
        copy.run(photoId(), doc, '沿用上版 · ' + p.origin, id);
      }
      return { count: ids.length };
    });
  }
  modelUnchanged(doc, sheet, item) {
    return !this.db
      .prepare(
        `SELECT 1 FROM product_documents d JOIN product_knowledge p ON p.id=d.product_id,
      json_each(p.data,'$.cellEdits') e JOIN product_workbook_rows r ON r.document_id=d.id AND r.sheet=? AND r.label=?
      WHERE d.id=? AND json_extract(e.value,'$.documentId')=d.id AND json_extract(e.value,'$.sheet')=r.sheet
      AND json_extract(e.value,'$.ref')=json_extract(r.data,'$[0].ref') AND json_extract(e.value,'$.value')<>r.label LIMIT 1`,
      )
      .get(sheet, item, doc);
  }
  options(documents, query, sourceItems = []) {
    if (!documents.length) return [];
    const terms = [
      ...new Set([
        ...(query.match(/[A-Za-z0-9_‐‑–-]+/gu) || []),
        ...sourceItems.filter((t) => typeof t === 'string' && mentionsModel(query, t)),
      ]),
    ];
    if (!terms.length) return [];
    const rows = this.db
      .prepare(
        `SELECT r.document_id AS documentId,d.product_id AS productId,r.sheet,r.label AS item,count(*) occurrences
    FROM product_workbook_rows r JOIN product_documents d ON d.id=r.document_id WHERE r.document_id IN(SELECT value FROM json_each(?)) AND r.label COLLATE NOCASE IN(SELECT value FROM json_each(?))
    GROUP BY r.document_id,r.sheet,r.label`,
      )
      .all(JSON.stringify(documents), JSON.stringify(terms));
    if (!rows.length) return [];
    const sheets = this.db
      .prepare(
        `SELECT r.document_id id,r.sheet,json_extract(r.data,'$[1].field') field,json_extract(r.data,'$[1].value') category
      FROM product_workbook_rows r JOIN (SELECT document_id,sheet,min(row_number) first FROM product_workbook_rows WHERE document_id IN (SELECT value FROM json_each(?)) AND sheet!='品类索引' GROUP BY document_id,sheet) head
      ON r.document_id=head.document_id AND r.sheet=head.sheet AND r.row_number=head.first`,
      )
      .all(JSON.stringify(documents));
    const namedSheets = sheets.filter((r) =>
      [
        r.sheet,
        ...(/^(?:品类|category)$/iu.test(r.field) ? String(r.category).split('/') : []),
      ].some((name) => {
        const t = name.trim();
        return (
          t &&
          (mentionsModel(query, t) || (/blinds$/iu.test(t) && mentionsModel(query, t.slice(0, -1))))
        );
      }),
    );
    const groups = Map.groupBy(
      rows.filter((r) => r.sheet !== '品类索引'),
      (r) => r.item.toLowerCase(),
    );
    const result = [];
    const pics = this.db.prepare(
      'SELECT ' +
        metadata +
        " FROM workbook_image_assets WHERE active=1 AND document_id=? AND sheet=? AND item=? ORDER BY slot!='主图',slot",
    );
    for (const group of groups.values()) {
      const candidates = namedSheets.length
        ? group.filter((r) => namedSheets.some((s) => s.id === r.documentId && s.sheet === r.sheet))
        : group;
      for (const r of candidates) {
        const photos = this.modelUnchanged(r.documentId, r.sheet, r.item)
          ? pics.all(r.documentId, r.sheet, r.item)
          : [];
        result.push({
          documentId: r.documentId,
          sheet: r.sheet,
          item: r.item,
          ambiguous: candidates.length > 1 || r.occurrences !== 1,
          photos: photos.map((p) => ({ ...p, productId: r.productId })),
        });
      }
    }
    return result;
  }
  attachment(id) {
    const r = this.db
      .prepare('SELECT item,slot,jpeg FROM workbook_image_assets WHERE id=? AND active=1')
      .get(id);
    if (!r) throw conflict();
    return {
      id,
      name: r.item + (r.slot === '主图' ? '' : '-' + r.slot) + '.jpg',
      contentType: 'image/jpeg',
      size: r.jpeg.byteLength,
      contentBase64: Buffer.from(r.jpeg).toString('base64'),
    };
  }
  automaticMatch(options, query) {
    const ambiguous = options.filter((g) => g.ambiguous && g.photos.length);
    return {
      attachments: this.automatically(options, query),
      photoNote:
        !declinesPhotos(query) && ambiguous.length
          ? '型号 ' +
            [...new Set(ambiguous.map((g) => g.item))].join('、') +
            ' 有多条记录，请从该型号选图并核对品类。'
          : '',
    };
  }
  automatically(options, query) {
    if (declinesPhotos(query)) return [];
    return options
      .filter((o) => !o.ambiguous)
      .flatMap((o) => o.photos.filter((p) => p.slot === '主图'))
      .slice(0, 5)
      .map((p) => this.attachment(p.id));
  }
  guard(documents, draft) {
    for (const a of draft.attachments || []) {
      const tracked = a.id?.startsWith('kbphoto_');
      const rows = tracked
        ? this.db
            .prepare(
              'SELECT active,sha,document_id,sheet,item FROM workbook_image_assets WHERE id=?',
            )
            .all(a.id)
        : a.id?.startsWith('attachment_') && draft.provenance
          ? this.db
              .prepare(
                'SELECT active,sha,document_id,sheet,item FROM workbook_image_assets WHERE legacy_id=?',
              )
              .all(a.id)
          : [];
      if (!tracked && !rows.length) continue;
      if (
        !rows.some(
          (r) =>
            r.active &&
            documents.includes(r.document_id) &&
            this.modelUnchanged(r.document_id, r.sheet, r.item) &&
            digest(Buffer.from(a.contentBase64, 'base64')) === r.sha,
        )
      )
        throw Object.assign(
          fail(
            409,
            '产品图片「' +
              a.name +
              '」已更换、移除或超出邮箱引用范围。请在草稿移除旧图，再从该型号选图并核对正文。',
          ),
          { code: 'REPLY_POLICY_CHANGED' },
        );
    }
  }
}

export function scopedPhotoDocs(knowledge, box, now, query = '') {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
  const sites = otherSitesInText(query, box);
  return knowledge
    .replyProducts(box, day)
    .filter(
      (p) => !sites.length || sites.some((website) => siteAllowsProduct(p, { website }, true)),
    )
    .flatMap((p) => p.documentIds || []);
}
