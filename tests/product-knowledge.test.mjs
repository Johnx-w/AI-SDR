import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ProductKnowledge } from '../server/product-knowledge.mjs';

const draft = { name: '卷帘', category: 'indoor', direction: 'finished' };
const approved = {
  ...draft,
  sourceUrl: 'https://example.com/roller',
  approvedBy: '业务审核人',
  status: 'approved',
};

test('T5 不预置供货事实，新产品默认草稿并跨重启保存', () => {
  const folder = mkdtempSync(join(tmpdir(), 'product-knowledge-'));
  const path = join(folder, 'knowledge.sqlite');
  let knowledge;
  try {
    knowledge = new ProductKnowledge(path);
    assert.deepEqual(knowledge.list(), []);
    const product = knowledge.save(draft);
    assert.equal(product.version, 1);
    assert.equal(product.status, 'draft');
    assert.equal(product.specifications, '');
    assert.equal(product.moq, '');
    assert.equal(product.leadTime, '');
    assert.deepEqual(product.outreachFacts, []);
    assert.equal(product.approvedBy, '');
    assert.equal(product.approvedAt, '');
    assert.deepEqual(knowledge.list({ usableOnly: true }), []);
    product.name = '仅修改返回对象';
    knowledge.close();
    knowledge = new ProductKnowledge(path);
    assert.equal(knowledge.list()[0].name, draft.name);
  } finally {
    knowledge?.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('T5 审核需要明确来源与审核人，审核时间只能由后台生成', () => {
  const knowledge = new ProductKnowledge();
  try {
    for (const invalid of [
      { ...draft, status: 'approved' },
      { ...draft, status: 'approved', approvedBy: '审核人' },
      { ...draft, status: 'approved', sourceUrl: approved.sourceUrl },
    ])
      assert.throws(
        () => knowledge.save(invalid),
        (error) => error.status === 400,
      );
    assert.deepEqual(knowledge.list(), []);
    const product = knowledge.save({ ...approved, approvedAt: '1970-01-01T00:00:00.000Z' });
    assert.equal(knowledge.list({ usableOnly: true }).length, 1);
    assert.notEqual(product.approvedAt, '1970-01-01T00:00:00.000Z');
    assert(product.approvedAt.startsWith(new Date().toISOString().slice(0, 10)));
    const attachmentOnly = knowledge.save({
      ...approved,
      sourceUrl: '',
      attachments: ['https://example.com/catalog.pdf'],
    });
    assert.equal(attachmentOnly.status, 'approved');
  } finally {
    knowledge.close();
  }
});

test('修改已审核事实必须重新审核，归档资料仍可查但不可作为可用事实', () => {
  const knowledge = new ProductKnowledge();
  try {
    const original = knowledge.save(approved);
    const changed = knowledge.save({ ...original, specifications: '已核对的尺寸范围' });
    assert.equal(changed.status, 'draft');
    assert.equal(changed.approvedBy, '');
    assert.equal(changed.approvedAt, '');
    assert.equal(knowledge.list({ usableOnly: true }).length, 0);
    const reviewed = knowledge.save({
      ...changed,
      status: 'approved',
      approvedBy: approved.approvedBy,
    });
    assert.equal(reviewed.status, 'approved');
    assert.equal(reviewed.version, 3);
    const archived = knowledge.save({ ...reviewed, status: 'archived' });
    assert.equal(knowledge.get(archived.id).status, 'archived');
    assert.equal(knowledge.list({ usableOnly: true }).length, 0);
    assert.equal(knowledge.list().length, 1);
    assert.equal(knowledge.list({ status: 'archived' }).length, 1);
  } finally {
    knowledge.close();
  }
});

test('跨连接版本冲突不覆盖他人修改，客户端不能指定未知产品编号', () => {
  const folder = mkdtempSync(join(tmpdir(), 'product-knowledge-version-'));
  const path = join(folder, 'knowledge.sqlite');
  const first = new ProductKnowledge(path);
  const second = new ProductKnowledge(path);
  try {
    const original = first.save(draft);
    assert.throws(
      () => second.save({ ...draft, id: 'made_up' }),
      (error) => error.status === 404,
    );
    assert.throws(
      () => second.save({ ...draft, id: original.id }),
      (error) => error.status === 409,
    );
    const changed = first.save({ ...original, notes: '较新资料' }, { expectedVersion: 1 });
    assert.equal(changed.version, 2);
    assert.throws(
      () => second.save({ ...original, notes: '旧页面覆盖' }),
      (error) => error.status === 409,
    );
    assert.equal(second.get(original.id).notes, '较新资料');
    assert.equal(second.list().length, 1);
  } finally {
    first.close();
    second.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('未来生效的审核资料尚不可用，日期、链接与输入规模经过校验', () => {
  const knowledge = new ProductKnowledge();
  try {
    const future = knowledge.save({ ...approved, effectiveDate: '2999-01-01' });
    assert.equal(future.status, 'approved');
    assert.equal(knowledge.list({ usableOnly: true }).length, 0);
    for (const value of [
      { ...draft, sourceUrl: 'javascript:alert(1)' },
      { ...draft, sourceUrl: 'https://user:password@example.com/private' },
      { ...draft, sourceUrl: 'http://127.0.0.1/private' },
      { ...draft, attachments: ['https://example.com/good', 'data:text/plain,secret'] },
      { ...draft, effectiveDate: '2026-02-30' },
      { ...draft, specifications: 'x'.repeat(12001) },
      { ...draft, aliases: Array(21).fill('roll') },
      { ...draft, category: 'imaginary' },
      { ...draft, status: 'published' },
    ])
      assert.throws(
        () => knowledge.save(value),
        (error) => error.status === 400,
      );
    assert.equal(knowledge.list().length, 1);
  } finally {
    knowledge.close();
  }
});

const productFact = {
  id: 'supply-roller',
  kind: 'product',
  text: 'We supply finished roller blinds.',
  conditions: '',
  validUntil: null,
};
const priceFact = {
  id: 'roller-price-500',
  kind: 'price',
  text: 'Our standard price is USD 30 per set.',
  conditions: 'For orders of at least 500 sets, FOB Shanghai.',
  validUntil: '2026-12-31T23:59:59Z',
};

test('开发信事实随产品确认、保留编号和条件，实质变更后重新审核', () => {
  const knowledge = new ProductKnowledge();
  try {
    const original = knowledge.save({ ...approved, outreachFacts: [productFact, priceFact] });
    assert.deepEqual(original.outreachFacts, [
      productFact,
      { ...priceFact, validUntil: '2026-12-31T23:59:59.000Z' },
    ]);
    assert.deepEqual(knowledge.get(original.id).outreachFacts, original.outreachFacts);
    assert.deepEqual(knowledge.list()[0].outreachFacts, original.outreachFacts);
    const changed = knowledge.save({
      ...original,
      outreachFacts: [productFact, { ...priceFact, text: 'Our standard price is USD 32 per set.' }],
    });
    assert.equal(changed.status, 'draft');
    assert.equal(changed.approvedAt, '');
    assert.equal(changed.version, 2);
    assert.equal(changed.outreachFacts[1].id, priceFact.id);
    const confirmed = knowledge.save({ ...changed, status: 'approved', approvedBy: '审核人' });
    assert.equal(confirmed.status, 'approved');
    assert.equal(confirmed.version, 3);
  } finally {
    knowledge.close();
  }
});

test('开发信事实校验类型、唯一编号、完整报价条件和动态事实有效期', () => {
  const knowledge = new ProductKnowledge();
  try {
    for (const facts of [
      null,
      {},
      Array(31).fill(productFact),
      [null],
      [{ ...productFact, unexpected: true }],
      [{ ...productFact, id: '' }],
      [{ ...productFact, id: 'line\nbreak' }],
      [productFact, { ...productFact }],
      [{ ...productFact, kind: 'unknown' }],
      [{ ...productFact, text: '' }],
      [{ ...productFact, text: 'x'.repeat(1201) }],
      [{ ...productFact, conditions: 'x'.repeat(801) }],
      [{ ...priceFact, conditions: '' }],
      [{ ...priceFact, validUntil: null }],
      [{ ...productFact, kind: 'stock' }],
      [{ ...productFact, kind: 'leadTime' }],
      [{ ...productFact, kind: 'freight' }],
      [{ ...priceFact, validUntil: '2026-12-31' }],
      [{ ...priceFact, validUntil: '2026-02-30T12:00:00Z' }],
      [{ ...priceFact, validUntil: '2026-12-31T24:00:00Z' }],
      [{ ...priceFact, validUntil: '2026-12-31T12:00:00' }],
    ])
      assert.throws(
        () => knowledge.save({ ...draft, outreachFacts: facts }),
        (error) => error.status === 400,
        JSON.stringify(facts),
      );
    assert.deepEqual(knowledge.list(), []);
    const expired = knowledge.save({
      ...approved,
      outreachFacts: [{ ...priceFact, validUntil: '2020-01-01T08:00:00+08:00' }],
    });
    assert.equal(expired.outreachFacts[0].validUntil, '2020-01-01T00:00:00.000Z');
    assert.equal(expired.status, 'approved');
  } finally {
    knowledge.close();
  }
});

test('旧资料缺少开发信事实时视为空列表，保存不会仅因新增字段撤销审核', () => {
  const knowledge = new ProductKnowledge();
  try {
    const original = knowledge.save(approved);
    const { outreachFacts, ...legacy } = original;
    knowledge.db
      .prepare('UPDATE product_knowledge SET data=? WHERE id=?')
      .run(JSON.stringify(legacy), original.id);
    assert.deepEqual(knowledge.get(original.id).outreachFacts, []);
    assert.deepEqual(knowledge.list()[0].outreachFacts, []);
    const saved = knowledge.save(legacy);
    assert.equal(saved.status, 'approved');
    assert.equal(saved.approvedAt, original.approvedAt);
    assert.deepEqual(saved.outreachFacts, []);
  } finally {
    knowledge.close();
  }
});

test('升级前创建产品的操作编号仍可重试，新增事实不能复用同一操作编号', () => {
  const knowledge = new ProductKnowledge();
  try {
    const idempotencyKey = 'legacy-product-request';
    const saved = knowledge.save(approved, { idempotencyKey });
    const { id, version, approvedAt, createdAt, updatedAt, outreachFacts, ...legacyInput } = saved;
    const legacyHash = createHash('sha256').update(JSON.stringify(legacyInput)).digest('hex');
    knowledge.db
      .prepare('UPDATE product_knowledge_requests SET body_hash=? WHERE request_key=?')
      .run(legacyHash, idempotencyKey);
    assert.equal(knowledge.save(approved, { idempotencyKey }).id, id);
    assert.equal(knowledge.list().length, 1);
    assert.throws(
      () => knowledge.save({ ...approved, outreachFacts: [productFact] }, { idempotencyKey }),
      (error) => error.status === 409,
    );
  } finally {
    knowledge.close();
  }
});
