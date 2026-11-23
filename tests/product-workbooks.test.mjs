import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { workbookPage, workbookType } from '../server/product-workbooks.mjs';

test('工作簿按原位置解析、数据库分页、校对后重新审核并保留原件', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  let product = k.save({ name: '样品', direction: 'materials' });
  const bytes = readFileSync(new URL('./fixtures/mail-specimen.xlsx', import.meta.url));
  const file = k.documents.upload(product.id, {
    name: '样品.xlsx',
    contentType: workbookType,
    contentBase64: bytes.toString('base64'),
  });
  const result = await k.documents.extract(product.id, file.id, { env: {} });
  assert.equal(result.extraction.sheets[0].rows, 16);
  const second = workbookPage(k.db, product.id, file.id, { sheet: '规格', page: 2 });
  assert.equal(second.rows[0].cells[0].ref, 'A14');
  assert.equal(second.total, 16);
  const row = workbookPage(k.db, product.id, file.id, { sheet: '规格', q: 'ZX-01' }).rows[0];
  assert.deepEqual(row.cells[1], { ref: 'B2', field: '材质', value: 'Aluminium' });
  product = k.save({
    ...product,
    documentIds: [file.id],
    approvedBy: '业务员',
    status: 'approved',
  });
  const change = { documentId: file.id, sheet: '规格', ref: 'B2', value: 'Aluminum alloy' };
  product = k.save({ ...product, cellEdits: [change] });
  assert.equal(product.status, 'draft');
  assert.equal(k.documents.get(product.id, file.id).bytes.compare(bytes), 0);
  assert.throws(() => k.save({ ...product, cellEdits: [{ ...change, ref: 'Z999' }] }), /不存在/);
});
