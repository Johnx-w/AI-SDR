import { extname } from 'node:path';
import { convertDocument } from './docling.mjs';
import { checkOfficeArchive, columnName } from './product-workbooks.mjs';

export const quoteMode = 'quote_catalog';
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function readQuoteCatalog(file) {
  const kind = extname(file.name)
    .slice(1)
    .toLowerCase()
    .replace(/^markdown$/, 'md');
  if (!['pdf', 'docx', 'xlsx', 'md'].includes(kind))
    throw fail(400, '报价清单支持 PDF、Excel、Word 和 Markdown。');
  if (['docx', 'xlsx'].includes(kind)) checkOfficeArchive(file.bytes);
  const data = await convertDocument(file.bytes, kind, { quote: true });
  if (data.error) throw fail(422, data.error);
  const sheets = new Map(),
    rows = [],
    photos = [];
  for (const { sheet, number, fields, images, columns, width = 0, sourceRefs } of data.rows) {
    const cells = Object.entries(fields).map(([field, value], i) => ({
      field,
      value,
      ref:
        columnName(columns && Object.hasOwn(columns, field) ? columns[field] : width + i) + number,
      ...(sourceRefs && Object.hasOwn(sourceRefs, field) ? { sourceRef: sourceRefs[field] } : {}),
    }));
    rows.push([sheet, number, cells[0].value, JSON.stringify(cells)]);
    sheets.set(sheet, (sheets.get(sheet) || 0) + 1);
    for (const [i, image] of images
      .toSorted((a, b) => Number(a.detail) - Number(b.detail))
      .entries())
      photos.push({
        sheet,
        item: cells[0].value,
        slot: image.detail ? '备注图 ' + (i + 1) : i ? '附图 ' + i : '主图',
        origin: image.origin,
        jpeg: Buffer.from(image.data, 'base64'),
      });
  }
  const figures = data.figures.flatMap((f) =>
    f.images.map((im) => ({
      label: f.label,
      source: f.source,
      jpeg: Buffer.from(im.data, 'base64'),
    })),
  );
  return {
    rows,
    photos,
    figures,
    extraction: {
      model: '本机报价表解析',
      mode: quoteMode,
      sheets: [...sheets].map(([name, rows]) => ({ name, rows })),
      rowCount: rows.length,
      terms: data.terms,
      figures: figures.map(({ label, source }, index) => ({ label, source, index })),
      pageCount: data.pageCount || undefined,
      facts: [],
      // File-level footnotes have no verified product scope; keep them out of reply evidence.
      warnings: data.terms.length
        ? [
            ...data.warnings,
            '文件级报价条件的适用型号尚未确认，仅供原件复核，未计入逐型号回信依据。',
          ]
        : data.warnings,
      extractedAt: new Date().toISOString(),
    },
  };
}

// Carry edits only when the same unique model still has the same original fields and terms.
export function carryQuoteEdits(db, product, prior, next) {
  const edits = (product.cellEdits || []).filter((e) => e.documentId === prior);
  if (!edits.length) return [];
  const extract = db.prepare('SELECT extraction FROM product_documents WHERE id=?');
  const old = JSON.parse(extract.get(prior)?.extraction ?? 'null'),
    current = JSON.parse(extract.get(next)?.extraction ?? 'null');
  if (
    !old?.sheets ||
    !current?.sheets ||
    JSON.stringify(old.terms) !== JSON.stringify(current.terms)
  )
    return [];
  const getRow = db.prepare(
    'SELECT label,data FROM product_workbook_rows WHERE document_id=? AND sheet=? AND row_number=?',
  );
  const matches = db.prepare(
    'SELECT sheet,data FROM product_workbook_rows WHERE document_id=? AND label=? COLLATE NOCASE LIMIT 2',
  );
  const content = (cells) =>
    JSON.stringify(
      cells
        .filter((c) => c.field !== '来源')
        .map((c) => [c.field, c.value])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return edits.flatMap((e) => {
    const row = getRow.get(prior, e.sheet, Number(e.ref.match(/\d+$/)[0]));
    if (!row || matches.all(prior, row.label).length !== 1) return [];
    const found = matches.all(next, row.label);
    if (found.length !== 1) return [];
    const before = JSON.parse(row.data),
      after = JSON.parse(found[0].data);
    const field = before.find((c) => c.ref === e.ref)?.field,
      cell = after.find((c) => c.field === field);
    return cell && field !== '来源' && content(before) === content(after)
      ? [{ ...e, documentId: next, sheet: found[0].sheet, ref: cell.ref }]
      : [];
  });
}
