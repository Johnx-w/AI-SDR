import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { MaterialLibrary } from '../server/materials.mjs';

const dir = mkdtempSync(join(tmpdir(), 'material-reads-'));
const env = {
  PRODUCT_KNOWLEDGE_DB_PATH: join(dir, 'materials.sqlite'),
  CONNECTIONS_PATH: join(dir, 'connections.json'),
  BATCH_DB_PATH: join(dir, 'batch.sqlite'),
};
const boxes = [{ website: 'https://catalog.example', brandName: 'Catalog' }];
const knowledge = new ProductKnowledge(env.PRODUCT_KNOWLEDGE_DB_PATH);
const count = 2500;
let app;
try {
  const db = knowledge.db,
    product = db.prepare('INSERT INTO product_knowledge VALUES(?,?)'),
    document = db.prepare('INSERT INTO product_documents VALUES(?,?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    const id = 'sample-' + String(i).padStart(4, '0'),
      doc = 'doc-' + id;
    product.run(
      id,
      JSON.stringify({
        name: 'Catalogue ' + i,
        version: 1,
        status: 'approved',
        updatedAt: new Date(i * 86400000).toISOString(),
        documentIds: [doc],
        materialCategory: 'category-' + (i % 10),
        keywords: ['technical'],
        sourceUrl: boxes[0].website,
        sourceFacts: [{ text: 'x'.repeat(4096) }],
      }),
    );
    document.run(
      doc,
      id,
      JSON.stringify({ contentType: 'text/plain', size: 8192 }),
      Buffer.alloc(8192),
      '{}',
    );
  }
  db.exec('COMMIT');
  app = createApp({
    env,
    outreachServiceFactory: () => ({ mailboxes: { list: () => boxes }, close() {} }),
    fetchImpl: async () => {
      throw Error('offline');
    },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.address().port + '/api/v1/materials?';
  for (const [label, params, total, first] of [
    ['首页', {}, count, 2499],
    ['第100页', { page: '100' }, count, 519],
    [
      '组合筛选',
      {
        site: 'catalog.example',
        category: 'category-3',
        format: 'TXT',
        q: 'technical',
        status: 'approved',
        page: '2',
      },
      250,
      2293,
    ],
  ]) {
    const times = [];
    let bytes;
    for (let i = 0; i < 22; i++) {
      const start = performance.now();
      const response = await fetch(base + new URLSearchParams(params));
      assert.equal(response.status, 200);
      const raw = await response.text();
      times.push(performance.now() - start);
      const result = JSON.parse(raw);
      assert.equal(result.total, total);
      assert.equal(result.items.length, 20);
      assert.equal(result.items[0].name, 'Catalogue ' + first);
      assert.ok(result.items.every((x) => !('sourceFacts' in x) && !('content' in x)));
      bytes = Buffer.byteLength(raw);
    }
    const cold = times.shift(),
      warm = times.sort((a, b) => a - b);
    console.log(label, {
      firstMs: Math.round(cold),
      p50Ms: Math.round(warm[10]),
      p95Ms: Math.round(warm[19]),
      maxMs: Math.round(warm.at(-1)),
      bytes,
    });
    const library = new MaterialLibrary(knowledge, boxes);
    // Explain the statements actually executed by list(), with the same filters and bindings.
    library.db = {
      prepare(sql) {
        const stmt = db.prepare(sql);
        const execute = (method, args) => {
          const rows = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args);
          console.log(label, method, rows.map((r) => r.detail).join(' / '));
          return stmt[method](...args);
        };
        return { get: (...args) => execute('get', args), all: (...args) => execute('all', args) };
      },
    };
    library.list(params);
  }
} finally {
  if (app?.listening) await new Promise((resolve) => app.close(resolve));
  knowledge.close();
  rmSync(dir, { recursive: true, force: true });
}
