import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { convertDocument } from '../server/docling.mjs';

// Release installations include an offline interpreter and parser. Check them before activation.
if (existsSync(new URL('../server/docling/reader-linux', import.meta.url))) {
  const result = await convertDocument(Buffer.from('# Docling runtime check'), 'md');
  assert.ok(result.blocks.some((b) => b.text === 'Docling runtime check'));
  for (const extension of ['pdf', 'docx', 'xlsx']) {
    const bytes = readFileSync(
      new URL('../tests/fixtures/quote-table.' + extension, import.meta.url),
    );
    const quote = await convertDocument(bytes, extension, { quote: true });
    assert.equal(quote.rows?.length, 1, quote.error ?? extension);
    assert.equal(quote.rows[0].images.length, 1, extension);
  }
}
