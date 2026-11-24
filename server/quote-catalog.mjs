import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname } from 'node:path';
import { checkOfficeArchive, columnName } from './product-workbooks.mjs';

export const quoteMode = 'quote_catalog';
const windows = process.platform === 'win32';
const local = fileURLToPath(
  new URL(
    '../.data/quote-python/' + (windows ? 'Scripts/python.exe' : 'bin/python'),
    import.meta.url,
  ),
);
const script = fileURLToPath(new URL('./quote_catalog.py', import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });

export async function readQuoteCatalog(file, env = {}) {
  const kind = extname(file.name)
    .slice(1)
    .toLowerCase()
    .replace(/^markdown$/, 'md');
  if (!['pdf', 'docx', 'xlsx', 'md'].includes(kind))
    throw fail(400, '报价清单支持 PDF、Excel、Word 和 Markdown。');
  if (['docx', 'xlsx'].includes(kind)) checkOfficeArchive(file.bytes);
  const executable =
    env.MATERIAL_PYTHON ||
    process.env.MATERIAL_PYTHON ||
    (existsSync(local) ? local : windows ? 'python' : 'python3');
  const data = await new Promise((resolve, reject) => {
    const child = execFile(
      executable,
      ['-I', '-B', script, kind],
      { windowsHide: true, timeout: 120000, maxBuffer: 46 * 1024 ** 2, encoding: 'utf8' },
      (err, stdout) => {
        if (err)
          return reject(
            fail(
              err.code === 'ENOENT' ? 503 : 422,
              err.code === 'ENOENT'
                ? '请配置素材库报价解析的 Python 环境。'
                : '报价清单读取失败或超过处理上限，请核对原件或分册导入。',
            ),
          );
        try {
          const result = JSON.parse(stdout);
          if (result.error) return reject(fail(422, result.error));
          resolve(result);
        } catch {
          reject(fail(422, '本机未返回有效的报价清单，请检查解析环境。'));
        }
      },
    );
    child.stdin.on('error', () => {}); // An early reader exit is reported by execFile.
    child.stdin.end(file.bytes);
  });
  const sheets = new Map(),
    rows = [],
    photos = [];
  for (const { sheet, number, fields, images, columns, width = 0, sourceRefs } of data.rows) {
    if (data.terms.length)
      fields['适用条件'] = [fields['适用条件'], ...data.terms].filter(Boolean).join('\n');
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
      warnings: data.warnings,
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
    old?.mode !== quoteMode ||
    current?.mode !== quoteMode ||
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
