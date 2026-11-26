import { interpretSheet } from './workbook-layout.mjs';
import { workbookPictures } from './material-pictures.mjs';
import { hasModelHeader } from './model-parameters.mjs';
import { convertDocument } from './docling.mjs';
import * as XLSX from 'xlsx/xlsx.mjs';
import { sheetLayout, workbookHeader } from '../src/domain/workbook-layout.mjs';

export const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const fail = (status, message) => Object.assign(new Error(message), { status });

export function columnName(n) {
  let name = '';
  for (let index = n + 1; index; index = Math.floor((index - 1) / 26))
    name = String.fromCharCode(65 + ((index - 1) % 26)) + name;
  return name;
}

// Bound decompression before handing an uploaded Office ZIP to the workbook reader.
export function checkOfficeArchive(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length) throw fail(400, '工作簿 ZIP 目录无效');
  const entries = bytes.readUInt16LE(end + 10);
  // Image-heavy catalogs may already be large on disk. Bound the extra bytes produced by inflation.
  const expandedLimit = bytes.length + 32 * 1024 ** 2;
  let position = bytes.readUInt32LE(end + 16),
    size = 0;
  if (!entries || entries > 2000) throw fail(400, '工作簿文件数量超限');
  for (let index = 0; index < entries; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50)
      throw fail(400, '工作簿 ZIP 目录损坏');
    size += bytes.readUInt32LE(position + 24);
    if (size > expandedLimit)
      throw fail(413, 'Office 文件解压后的大小超过可处理范围（原件大小加 32 MiB）');
    position +=
      46 +
      bytes.readUInt16LE(position + 28) +
      bytes.readUInt16LE(position + 30) +
      bytes.readUInt16LE(position + 32);
  }
}

export async function parseWorkbook(bytes, options = {}) {
  checkOfficeArchive(bytes);
  const { sheets, pictures } = await convertDocument(bytes, 'xlsx');
  // Docling supplies layout and cells. Excel number masks carry significant printed
  // precision, leading zeros and units that are absent from Docling's text.
  const formatted = XLSX.read(bytes, {
    type: 'buffer',
    dense: true,
    cellNF: true,
    cellFormula: false,
  });
  for (const { sheet, data } of sheets) {
    const original = formatted.Sheets[sheet]?.['!data'];
    for (const [r, row] of data.entries()) {
      for (const [c, value] of row.entries()) {
        const cell = original?.[r]?.[c];
        if (value != null && cell?.t === 'n') {
          row[c] =
            cell.z && cell.z !== 'General'
              ? (cell.w ?? value)
              : String(Number(cell.v.toPrecision(15)));
        }
      }
    }
  }
  const summary = [],
    rows = [],
    owners = new Map(),
    warnings = [],
    productFields = [],
    facts = [];
  for (const { sheet, data, merges } of sheets) {
    const headerIndex = data.findIndex((row) => row.some((value) => value !== null));
    if (headerIndex < 0) continue;
    const autoHeader = options.material ? workbookHeader(data) : headerIndex;
    const layout = sheetLayout(data[autoHeader]);
    const manual = options.mappings?.[sheet];
    if (manual) {
      if (!['table', 'knowledge', 'quote'].includes(manual.kind)) throw fail(400, '工作表类型无效');
      const required =
        manual.kind === 'quote'
          ? ['model', 'price']
          : manual.kind === 'knowledge'
            ? ['topic', 'answer']
            : [];
      if (
        required.some(
          (key) =>
            typeof manual.fields?.[key] !== 'string' ||
            !layout.headers.includes(manual.fields[key]) ||
            layout.headers.indexOf(manual.fields[key]) !==
              layout.headers.lastIndexOf(manual.fields[key]),
        ) ||
        new Set(required.map((key) => manual.fields[key])).size !== required.length
      )
        throw fail(400, '请确认工作表的字段映射');
      layout.kind = manual.kind;
      for (const key of required) layout.fields[key] = manual.fields[key];
    }
    const structured = options.material && layout.kind !== 'table';
    const mappedFields =
      layout.kind === 'quote'
        ? { model: '型号或品名', price: '参考价格', unit: '单位', currency: '币种' }
        : { topic: '主题', answer: '内容', source: '来源' };
    const identity = layout.fields[layout.kind === 'quote' ? 'model' : 'topic'];
    let headers = [],
      ownerCol = -1,
      acrossItems = null;
    const sheetOwners = new Map();
    owners.set(sheet, sheetOwners);
    if (data.length > 20000 || data.some((row) => row.length > 150))
      throw fail(413, '每张工作表最多 20000 行、150 列');
    const inherited = new Map();
    for (const m of merges) {
      if (m.s.c !== m.e.c || m.e.r >= data.length) continue;
      for (let r = m.s.r + 1; r <= m.e.r; r++)
        inherited.set(r + ',' + m.s.c, { row: m.s.r, value: data[m.s.r]?.[m.s.c] });
    }
    const start = rows.length;
    if (structured) {
      headers = layout.headers;
      ownerCol = headers.indexOf(identity);
    }
    for (let index = structured ? autoHeader + 1 : headerIndex; index < data.length; index++) {
      const row = data[index],
        filled = row.filter((v) => v != null && v !== '');
      const code = row.findIndex(hasModelHeader);
      const name = row.findIndex((v) =>
        /^(产品名称|品名|系列|product name|product|item name|part name|名称)$/iu.test(
          String(v ?? '').trim(),
        ),
      );
      const generic = row.some((v) =>
        /^(项目|问题|项目名称|参数名|字段|品类|category|question|description|规格|material)$/iu.test(
          String(v ?? '').trim(),
        ),
      );
      const next = data[index + 1] ?? [];
      const across =
        !structured &&
        code === 0 &&
        filled.length > 1 &&
        hasModelHeader(row[0]) &&
        (filled.length === 2 || next.slice(1).some((v) => v && /\d/u.test(v))) &&
        !row
          .slice(1)
          .some((v) =>
            /^(材质|宽度|型号|适用条件|规格|颜色|width|material|color)|来源|参数|厚度|宽度|单价/iu.test(
              v ?? '',
            ),
          ) &&
        row.slice(1).some((v) => /\d/u.test(v ?? ''));
      if (across) {
        acrossItems = row;
        headers = [];
        ownerCol = -1;
      }
      if (acrossItems && !across && filled.length && row[0]) {
        for (let col = 1; col < row.length; col++)
          if (row[col] && acrossItems[col]) {
            productFields.push({
              sheet,
              item: acrossItems[col],
              field: row[0],
              value: row[col],
              ref: sheet + '!' + columnName(col) + (index + 1),
            });
            facts.push({
              page: 1,
              location: sheet + '!' + columnName(col) + (index + 1),
              text: acrossItems[col] + ' · ' + row[0] + ' · ' + row[col],
            });
          }
      }
      if (acrossItems)
        for (let col = 1; col < acrossItems.length; col++)
          if (acrossItems[col]) sheetOwners.set(index + 1 + ',' + col, acrossItems[col]);
      if (
        !structured &&
        !across &&
        filled.length > 1 &&
        filled.every((v) => typeof v === 'string') &&
        (code >= 0 || name >= 0 || generic)
      ) {
        headers = row;
        ownerCol = code >= 0 ? code : name;
        acrossItems = null;
        continue;
      }
      const cells = data[index].flatMap((value, col) =>
        (value === null || value === '') &&
        !(structured && layout.kind === 'quote' && headers[col] === layout.fields.price)
          ? []
          : [
              {
                ref: columnName(col) + (index + 1),
                field: String(headers[col] ?? columnName(col)),
                value: value instanceof Date ? value.toISOString() : String(value ?? ''),
              },
            ],
      );
      if (
        !structured &&
        cells.length &&
        headers[0] === '型号或品名' &&
        headers[2] === '参考价格' &&
        !cells.some((c) => c.ref === 'C' + (index + 1))
      ) {
        cells.splice(2, 0, { ref: 'C' + (index + 1), field: '参考价格', value: '' });
      }
      const merged = inherited.get(index + ',' + ownerCol);
      if (cells.length && !row[ownerCol] && merged?.value) {
        cells.unshift({
          ref: columnName(ownerCol) + (merged.row + 1),
          field: headers[ownerCol],
          value: merged.value,
        });
        if (!structured || layout.kind === 'quote') sheetOwners.set(index + 1, merged.value);
      }
      if (ownerCol >= 0 && row[ownerCol] != null && row[ownerCol] !== '') {
        const identity = cells.findIndex((c) => c.ref === columnName(ownerCol) + (index + 1));
        if (identity >= 0) {
          const [first] = cells.splice(identity, 1);
          cells.unshift(first);
          if (!structured || layout.kind === 'quote') sheetOwners.set(index + 1, first.value);
        }
      }
      if (structured) {
        if (!cells[0]?.value || cells[0].field !== identity) continue;
        for (const cell of cells) {
          const entry = Object.entries(mappedFields).find(
            ([role]) => layout.fields[role] === cell.field,
          );
          if (entry) cell.field = entry[1];
        }
      }
      if (cells.length) rows.push([sheet, index + 1, cells[0].value, JSON.stringify(cells)]);
    }
    if (ownerCol < 0 && !acrossItems && rows.length > start && options.material && options.env) {
      try {
        facts.push(...(await interpretSheet(sheet, rows.slice(start), options, productFields)));
      } catch {
        warnings.push(sheet + ' · 已保留原始单元格，产品字段关系需核对。');
      }
    }
    const rowItems = new Map();
    for (const f of productFields.filter((f) => f.sheet === sheet && f.itemRef)) {
      const row = Number(f.itemRef.match(/\d+$/u)?.[0]);
      if (row !== Number(f.valueRef.match(/\d+$/u)?.[0])) continue;
      if (!rowItems.has(row)) rowItems.set(row, new Set());
      rowItems.get(row).add(f.item);
    }
    for (const [row, items] of rowItems)
      if (items.size === 1 && !sheetOwners.has(row)) sheetOwners.set(row, [...items][0]);
    if (structured && layout.kind === 'quote') {
      const column = layout.headers.indexOf(layout.fields.photo);
      const counts = new Map();
      for (const [, , item] of rows.slice(start)) {
        const key = item.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      owners.set(
        sheet,
        new Map(
          [...sheetOwners]
            .filter(([, item]) => column >= 0 && counts.get(item.toLowerCase()) === 1)
            .map(([row, item]) => [row + ',' + column, item]),
        ),
      );
    }
    summary.push({
      name: sheet,
      rows: rows.length - start,
      ...(options.material ? layout : {}),
    });
  }
  if (!rows.length || rows.length > 30000) throw fail(400, '工作簿须包含 1 至 30000 条非空资料行');
  const extraction = {
    sheets: summary,
    productFields,
    facts,
    warnings,
    model: 'Docling',
    extractedAt: new Date().toISOString(),
  };
  const photos = await workbookPictures(pictures, owners, warnings);
  return { extraction, rows, photos };
}

export function workbookPage(
  db,
  productId,
  documentId,
  { sheet, page = 1, q = '', material = false },
) {
  page = Number(page);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 30000 ||
    typeof sheet !== 'string' ||
    !sheet ||
    typeof q !== 'string' ||
    q.length > 200
  )
    throw fail(400, '工作表或页码无效');
  const document = db
    .prepare(
      "SELECT json_extract(extraction,'$.mode') AS mode FROM product_documents WHERE id=? AND product_id=?",
    )
    .get(documentId, productId);
  if (!document) throw fail(404, '产品原文件不存在');
  const where =
    'WHERE document_id=? AND sheet=?' + (q ? ' AND instr(lower(label), lower(?))>0' : '');
  const args = q ? [documentId, sheet, q] : [documentId, sheet];
  const { total } = db
    .prepare('SELECT count(*) AS total FROM product_workbook_rows ' + where)
    .get(...args);
  const rows = db
    .prepare(
      'SELECT row_number, data FROM product_workbook_rows ' +
        where +
        ' ORDER BY row_number LIMIT 12 OFFSET ?',
    )
    .all(...args, (page - 1) * 12)
    .map((row) => ({ number: row.row_number, cells: JSON.parse(row.data) }));
  if (material || document.mode === 'quote_catalog') {
    const photos = db
      .prepare(
        "SELECT item,id,slot,origin FROM workbook_image_assets WHERE document_id=? AND sheet=? AND active=1 AND item IN (SELECT value FROM json_each(?)) ORDER BY slot!='主图',slot",
      )
      .all(documentId, sheet, JSON.stringify(rows.map((r) => r.cells[0].value)));
    for (const row of rows) row.photos = photos.filter((p) => p.item === row.cells[0].value);
  }
  return { rows, total, page, pageSize: 12 };
}

export function knowledgePage(db, doc, sheet, product, page = 1, query = '') {
  page = Number(page);
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    page > 30000 ||
    typeof query !== 'string' ||
    query.length > 200
  )
    throw fail(400, '检索条件无效');
  const layout = doc.extraction?.sheets?.find((s) => s.name === sheet);
  if (layout?.kind !== 'knowledge') throw fail(400, '请选择答复规则工作表');
  const edits = (product.cellEdits || []).filter(
    (e) => e.documentId === doc.id && e.sheet === sheet,
  );
  const sql = `WITH cells AS (
    SELECT r.row_number, json_extract(c.value,'$.field') field,
      coalesce((SELECT json_extract(e.value,'$.value') FROM json_each(?) e
        WHERE json_extract(e.value,'$.ref')=json_extract(c.value,'$.ref')),
        json_extract(c.value,'$.value')) value
    FROM product_workbook_rows r, json_each(r.data) c
    WHERE r.document_id=? AND r.sheet=?
  ), records AS (
    SELECT row_number,
      max(CASE WHEN field IN ('主题',?) THEN value ELSE '' END) topic,
      max(CASE WHEN field IN ('内容',?) THEN value ELSE '' END) answer,
      max(CASE WHEN field IN ('来源',?) THEN value ELSE '' END) source
    FROM cells GROUP BY row_number
  ), grouped AS (
    SELECT min(row_number) number,json_group_array(DISTINCT topic) topics,answer,source
    FROM records GROUP BY answer,source,CASE WHEN answer='' THEN row_number ELSE 0 END
  ), found AS (
    SELECT * FROM grouped WHERE instr(lower(answer || ' ' || source),lower(?))>0
      OR EXISTS (SELECT 1 FROM json_each(topics) WHERE instr(lower(value),lower(?))>0)
  ) `;
  const args = [
    JSON.stringify(edits),
    doc.id,
    sheet,
    layout.fields.topic ?? null,
    layout.fields.answer ?? null,
    layout.fields.source ?? null,
    query,
    query,
  ];
  const { total } = db.prepare(sql + 'SELECT count(*) total FROM found').get(...args);
  const groups = db
    .prepare(sql + 'SELECT * FROM found ORDER BY number LIMIT 12 OFFSET ?')
    .all(...args, (page - 1) * 12)
    .map((g) => ({ ...g, topics: JSON.parse(g.topics) }));
  return { groups, total, pageSize: 12 };
}
