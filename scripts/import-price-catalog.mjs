import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { MaterialLibrary } from '../server/materials.mjs';

// Provision this snapshot explicitly. Existing approvals, price edits and replaced or removed pictures survive retries.
export async function importPriceCatalog(k) {
  const root = new URL('../src/components/price-catalog/', import.meta.url);
  const read = (name) => readFile(new URL(name, root));
  const bytes = await read('pricelist.xlsx'),
    sha = createHash('sha256').update(bytes).digest('hex');
  const find = () =>
    k.db
      .prepare(
        "SELECT id,product_id FROM product_documents WHERE json_extract(metadata,'$.sha256')=?",
      )
      .all(sha);
  let docs = find();
  if (!docs.length) {
    await new MaterialLibrary(k, []).upload({
      name: '遮阳产品价格总表（型号与配置）.xlsx',
      bytes,
      key: 'shade-price-catalog-' + sha,
      env: {},
    });
    docs = find();
  }
  const { products } = JSON.parse(await read('catalog.json'));
  const encoded = new Map();
  for (const p of products)
    for (const file of p.photos) {
      if (encoded.has(file)) continue;
      const src = await read('images/' + file);
      let jpeg = file.endsWith('.jpg') ? src : await sharp(src).jpeg({ quality: 83 }).toBuffer();
      if (jpeg.length > 524288)
        jpeg = await sharp(src)
          .resize({ width: 900, height: 900, fit: 'inside' })
          .jpeg({ quality: 68 })
          .toBuffer();
      encoded.set(file, jpeg);
    }
  let added = 0;
  k.db.exec('BEGIN IMMEDIATE');
  try {
    for (const doc of docs)
      for (const p of products) {
        const { sheet, item, ref, original } = p.binding,
          row = Number(ref.slice(1));
        if (!original) {
          const result = k.db
            .prepare(
              'SELECT data FROM product_workbook_rows WHERE document_id=? AND sheet=? AND row_number=?',
            )
            .get(doc.id, sheet, row);
          if (!result) throw Error('请先完成工作簿数据解析');
          const cells = JSON.parse(result.data);
          if (!cells.some((c) => c.ref === ref)) {
            cells.splice(2, 0, { ref, field: '参考价格', value: '' });
            k.db
              .prepare(
                'UPDATE product_workbook_rows SET data=? WHERE document_id=? AND sheet=? AND row_number=?',
              )
              .run(JSON.stringify(cells), doc.id, sheet, row);
          }
        }
        for (const [i, file] of p.photos.entries()) {
          const slot = i ? '附图 ' + i : '主图';
          if (
            k.db
              .prepare(
                'SELECT 1 FROM workbook_image_assets WHERE document_id=? AND sheet=? AND item=? AND slot=?',
              )
              .get(doc.id, sheet, item, slot)
          )
            continue;
          const jpeg = encoded.get(file);
          k.db
            .prepare(
              'INSERT INTO workbook_image_assets(id,document_id,sheet,item,slot,origin,sha,jpeg) VALUES(?,?,?,?,?,?,?,?)',
            )
            .run(
              'kbphoto_' + randomUUID(),
              doc.id,
              sheet,
              item,
              slot,
              '遮阳产品价格总表 · ' + p.model,
              createHash('sha256').update(jpeg).digest('hex'),
              jpeg,
            );
          added++;
        }
      }
    k.db.exec('COMMIT');
  } catch (e) {
    k.db.exec('ROLLBACK');
    throw e;
  }
  return { materials: docs.map((d) => d.product_id), added };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const k = new ProductKnowledge(
    process.env.PRODUCT_KNOWLEDGE_DB_PATH ||
      process.env.PRODUCT_DB_PATH ||
      process.env.BATCH_DB_PATH ||
      '.data/acquisition.sqlite',
  );
  try {
    console.log(await importPriceCatalog(k));
  } finally {
    k.close();
  }
}
