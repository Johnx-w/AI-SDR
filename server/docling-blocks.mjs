import { convertDocument } from './docling.mjs';
import { checkOfficeArchive } from './product-workbooks.mjs';
import { hasModelHeader, tableParameters } from './model-parameters.mjs';

export function tableProduct(headers, row) {
  const clean = headers.map((h) => h.trim().replace(/\s+/gu, ' '));
  // A quotation can contain both an ordinal “Item No.” and a manufacturer product code.
  for (const match of [
    (h) => /^(?:production code|product code|model(?: no\.?)?|sku|产品编码|型号)$/iu.test(h),
    (h) => hasModelHeader(h) && !/^item no\.?$/iu.test(h),
    (h) => /^(?:产品名称|品名|名称|product name|item name|item|系列|series)$/iu.test(h),
    hasModelHeader,
  ]) {
    const value = row[clean.findIndex(match)];
    if (value?.trim()) return value.trim();
  }
}
export async function officeBlocks(file) {
  const markdown = file.contentType === 'text/markdown';
  const word = file.contentType.endsWith('wordprocessingml.document');
  if (!markdown) checkOfficeArchive(file.bytes);
  const { blocks } = await convertDocument(file.bytes, markdown ? 'md' : word ? 'docx' : 'pptx');
  const results = [],
    counts = new Map();
  for (const b of blocks) {
    const locator = markdown ? 'Markdown 正文' : word ? 'Word 正文' : '幻灯片 ' + b.page;
    const kind = b.picture ? '插图' : b.rows ? '表' : '段';
    const key = locator + kind;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    if (b.picture) {
      const item = tableProduct(b.headers, b.row);
      const context = b.row.length
        ? b.row.join(' · ')
        : [
            b.caption,
            ...results
              .filter((r) => r.page === b.page && !r.picture && !word && !markdown)
              .map((r) => r.text),
          ]
            .filter(Boolean)
            .join('\n');
      results.push({ ...b, item, text: context.slice(0, 1800), ref: locator + ' · 插图 ' + n });
    } else if (b.rows) {
      const [headers, ...rows] = b.rows;
      if (!headers) continue;
      const model = headers.findIndex(hasModelHeader);
      if (!rows.length)
        results.push({ page: b.page, ref: locator + ' · 表 ' + n, text: headers.join(' | ') });
      for (const [index, row] of rows.entries()) {
        const ref = locator + ' · 表 ' + n + ' 第 ' + (index + 2) + ' 行';
        const text = headers.join(' | ') + '\n' + row.join(' | ');
        const item = tableProduct(headers, row);
        const block = {
          page: b.page,
          ref,
          text,
          productFields: item
            ? row.flatMap((value, col) =>
                value && headers[col]
                  ? [{ item, field: headers[col], value, ref: ref + ' · 第 ' + (col + 1) + ' 列' }]
                  : [],
              )
            : [],
        };
        if (model >= 0 && row[model] && headers.every(Boolean) && row.length === headers.length) {
          const cells = row
            .map((value, col) => ({
              value,
              field: headers[col],
              ref: ref + ' · 第 ' + (col + 1) + ' 列',
            }))
            .filter((c) => c.value);
          block.records = tableParameters(cells, { page: b.page }).map((p) => ({
            ...p,
            quote: text,
          }));
        }
        results.push(block);
      }
    } else {
      results.push({ ...b, ref: locator + ' · 第 ' + n + ' 段' });
    }
  }
  return results;
}
