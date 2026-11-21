import readWorkbook from 'read-excel-file/node';

export const workbookType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const fail = (status, message) => Object.assign(new Error(message), { status });

function columnName(n) {
  let name = '';
  for (let index = n + 1; index; index = Math.floor((index - 1) / 26))
    name = String.fromCharCode(65 + ((index - 1) % 26)) + name;
  return name;
}

// Bound decompression before handing an uploaded Office ZIP to the workbook reader.
function checkArchive(bytes) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > bytes.length) throw fail(400, '工作簿 ZIP 目录无效');
  const entries = bytes.readUInt16LE(end + 10);
  let position = bytes.readUInt32LE(end + 16),
    size = 0;
  if (!entries || entries > 2000) throw fail(400, '工作簿文件数量超限');
  for (let index = 0; index < entries; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50)
      throw fail(400, '工作簿 ZIP 目录损坏');
    size += bytes.readUInt32LE(position + 24);
    if (size > 32 * 1024 * 1024) throw fail(413, '工作簿解压后超过 32 MB');
    position +=
      46 +
      bytes.readUInt16LE(position + 28) +
      bytes.readUInt16LE(position + 30) +
      bytes.readUInt16LE(position + 32);
  }
}

export async function extractWorkbook(db, file) {
  checkArchive(file.bytes);
  let sheets;
  try {
    sheets = await readWorkbook(file.bytes, { parseNumber: (value) => value });
  } catch {
    throw fail(400, '无法解析此 XLSX，请检查文件或用 Excel 另存为工作簿');
  }
  const summary = [],
    rows = [];
  for (const { sheet, data } of sheets) {
    const headerIndex = data.findIndex((row) => row.some((value) => value !== null));
    if (headerIndex < 0) continue;
    const headers = data[headerIndex];
    if (data.length > 20000 || headers.length > 150)
      throw fail(413, '每张工作表最多 20000 行、150 列');
    const start = rows.length;
    for (let index = headerIndex + 1; index < data.length; index++) {
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
      if (cells.length)
        rows.push([file.id, sheet, index + 1, cells[0].value, JSON.stringify(cells)]);
    }
    summary.push({ name: sheet, rows: rows.length - start });
  }
  if (!rows.length || rows.length > 30000)
    throw fail(400, '工作簿须包含表头及 1 至 30000 条资料行');
  const extraction = {
    sheets: summary,
    facts: [],
    warnings: [],
    model: 'read-excel-file',
    extractedAt: new Date().toISOString(),
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    const insert = db.prepare('INSERT OR REPLACE INTO product_workbook_rows VALUES(?,?,?,?,?)');
    for (const row of rows) insert.run(...row);
    db.prepare('UPDATE product_documents SET extraction=? WHERE id=?').run(
      JSON.stringify(extraction),
      file.id,
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return extraction;
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
  if (
    !db
      .prepare('SELECT 1 FROM product_documents WHERE id=? AND product_id=?')
      .get(documentId, productId)
  )
    throw fail(404, '产品原文件不存在');
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
  return { rows, total, page, pageSize: 12 };
}
