import { lexer } from 'marked';
import { hasModelHeader } from './model-parameters.mjs';
import { jpegPreview, photoRows } from './material-pictures.mjs';
import { extractText } from './material-formats.mjs';

// Parse GFM tables before chunking so embedded data URLs never become product facts.
export async function markdownMaterial(file) {
  const source = file.bytes.toString('utf8'),
    photos = [],
    warnings = [];
  const text = [];
  for (const block of lexer(source)) {
    if (block.type !== 'table') {
      text.push(block.raw.replace(/!\[([^\]]*)\]\(data:image\/[^)]+\)/giu, '[$1]'));
      continue;
    }
    const headers = block.header.map((c) => c.text);
    let id = headers.findIndex(hasModelHeader);
    if (id < 0) id = headers.findIndex((h) => /^(产品名称|品名|product name)$/iu.test(h));
    for (const [index, row] of block.rows.entries()) {
      const item = row[id]?.text.trim();
      const values = [];
      for (const [col, cell] of row.entries()) {
        const value = cell.tokens
          .filter((t) => t.type !== 'image')
          .map((t) => t.text ?? t.raw)
          .join('')
          .trim();
        if (value) values.push(headers[col] + ' · ' + value);
        for (const t of cell.tokens.filter((t) => t.type === 'image')) {
          const b64 = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/iu.exec(
            t.href,
          );
          if (!b64 || !item) {
            warnings.push('第 ' + (index + 1) + ' 条配图需核对原件');
            continue;
          }
          try {
            const jpeg = await jpegPreview(Buffer.from(b64[1], 'base64'));
            if (jpeg.length > 524288) throw Error();
            photos.push({ sheet: '产品图片', item, origin: 'Markdown 表格 · ' + item, jpeg });
          } catch {
            warnings.push(item + ' · 图片无法生成预览');
          }
        }
      }
      text.push(values.join(' | ') + '\n');
    }
  }
  const extraction = await extractText({ ...file, bytes: Buffer.from(text.join('\n')) });
  extraction.warnings.push(...warnings);
  extraction.photoCount = photos.length;
  return { photos, rows: photoRows(photos), extraction };
}
