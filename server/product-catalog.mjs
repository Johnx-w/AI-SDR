import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { builtinProducts, validateProduct } from '../src/domain/acquisition-products.mjs';

export class ProductCatalog {
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS acquisition_products(id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    );
  }
  list() {
    return [
      ...builtinProducts,
      ...this.db
        .prepare('SELECT data FROM acquisition_products ORDER BY rowid')
        .all()
        .map((row) => JSON.parse(row.data)),
    ];
  }
  save(value) {
    const product = validateProduct(value);
    const key = product.direction + ':' + product.value.toLowerCase();
    const existing = this.list().find((p) => p.direction + ':' + p.value.toLowerCase() === key);
    if (existing) return existing;
    product.id = 'product_' + createHash('sha256').update(key).digest('hex').slice(0, 20);
    this.db
      .prepare('INSERT INTO acquisition_products VALUES(?,?)')
      .run(product.id, JSON.stringify(product));
    return product;
  }
  close() {
    this.db.close();
  }
}
