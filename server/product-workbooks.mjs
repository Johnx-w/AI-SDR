import { interpretSheet } from './workbook-layout.mjs';
import { workbookPictures } from './material-pictures.mjs';
import { hasModelHeader } from './model-parameters.mjs';
import { convertDocument } from './docling.mjs';
import * as XLSX from 'xlsx/xlsx.mjs';

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
    for (let index = headerIndex; index < data.length; index++) {
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
        value === null || value === ''
          ? []
          : [
              {
                ref: columnName(col) + (index + 1),
                field: String(headers[col] ?? columnName(col)),
                value: value instanceof Date ? value.toISOString() : String(value),
              },
            ],
      );
      if (
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
        sheetOwners.set(index + 1, merged.value);
      }
      if (ownerCol >= 0 && row[ownerCol] != null && row[ownerCol] !== '') {
        const identity = cells.findIndex((c) => c.ref === columnName(ownerCol) + (index + 1));
        if (identity >= 0) {
          const [first] = cells.splice(identity, 1);
          cells.unshift(first);
          sheetOwners.set(index + 1, first.value);
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
    summary.push({ name: sheet, rows: rows.length - start });
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

export function workbookPage(db, productId, documentId, { sheet, page = 1, q = '' }) {
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
  if (document.mode === 'quote_catalog') {
    const photos = db
      .prepare(
        "SELECT item,id,slot,origin FROM workbook_image_assets WHERE document_id=? AND sheet=? AND active=1 AND item IN (SELECT value FROM json_each(?)) ORDER BY slot!='主图',slot",
      )
      .all(documentId, sheet, JSON.stringify(rows.map((r) => r.cells[0].value)));
    for (const row of rows) row.photos = photos.filter((p) => p.item === row.cells[0].value);
  }
  return { rows, total, page, pageSize: 12 };
}
