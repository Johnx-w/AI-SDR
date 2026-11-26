import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { convertDocument } from '../server/docling.mjs';

// Release installations include an offline interpreter and parser. Check them before activation.
if (existsSync(new URL('../server/docling/reader-linux', import.meta.url))) {
  const result = await convertDocument(Buffer.from('# Docling runtime check'), 'md');
  assert.ok(result.blocks.some((b) => b.text === 'Docling runtime check'));
}
