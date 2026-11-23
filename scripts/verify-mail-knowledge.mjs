import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { workbookPage } from '../server/product-workbooks.mjs';
import { MaterialLibrary } from '../server/materials.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';

export async function honeybadgerFixture(
  dir = process.env.MAIL_QA_MATERIALS_DIR || String.raw`C:\Users\Johnson\Desktop\工作\产品资料`,
  databasePath = ':memory:',
) {
  if (databasePath !== ':memory:' && existsSync(databasePath))
    throw new Error('验收数据库必须是新文件');
  const knowledge = new ProductKnowledge(databasePath);
  const box = { website: 'https://honeybadgerblinds.com', knowledgeProductIds: [] };
  const materials = new MaterialLibrary(knowledge, [{ ...box, brandName: 'Honey Badger Blinds' }]);
  const files = readdirSync(dir, { recursive: true }).filter(
    (f) => f.toLowerCase().endsWith('.xlsx') && !basename(f).startsWith('~$'),
  );
  assert.equal(files.length, 3, '需要三份验收工作簿');
  const imports = [];
  for (const name of files) {
    const result = await materials.upload({
      name: basename(name),
      bytes: readFileSync(join(dir, name)),
      site: 'honeybadgerblinds.com',
      key: randomUUID(),
    });
    assert.equal(result.warning, '');
    const {
      product,
      documents: [document],
    } = materials.detail(result.id);
    const { extraction } = document;
    materials.edit(product.id, {
      version: product.version,
      status: 'approved',
      approvedBy: '本地验收',
    });
    imports.push({ file: document.name, sheets: extraction.sheets });
    box.knowledgeProductIds.push(product.id);
  }
  return { knowledge, box, imports };
}

export async function verifyWorkbookAnswers(dir, databasePath) {
  const { knowledge, box, imports } = await honeybadgerFixture(dir, databasePath);
  try {
    const answers = [];
    for (const [question, sheet, ref, value, automatic] of [
      [
        'Super Silent Middle Track 的用途是什么？',
        '画册产品参数',
        'F2',
        '家居、酒店、会议室',
        true,
      ],
      ['What material is A211 made of?', '产品规格', 'B2', '100%Polyester', true],
      ['付款方式的定金比例是多少？', '公司规则', 'B2', '50%', false],
      ['A211 的参考价格是多少？', '参考价格', 'B2', '9.595', false],
    ]) {
      const answer = answerMailQuestion(knowledge, box, question);
      const source = answer.sources.find((s) => s.sheet === sheet && s.ref === ref);
      assert.equal(source?.value, value);
      assert.ok(answer.body.includes(value));
      assert.equal(answer.automatic, automatic);
      const page = workbookPage(knowledge.db, source.productId, source.documentId, { sheet });
      assert.equal(page.rows[0].cells.find((c) => c.ref === ref).value, value);
      if (sheet === '参考价格') {
        for (const [coordinate, expected] of [
          ['C2', 'USD/㎡'],
          ['D2', '品类：卷帘；配置：拉珠/拉绳；EXW；不足1㎡按1㎡计'],
        ]) {
          assert.equal(page.rows[0].cells.find((c) => c.ref === coordinate)?.value, expected);
          assert.equal(
            answer.sources.find((s) => s.sheet === sheet && s.ref === coordinate)?.value,
            expected,
          );
          assert.ok(answer.body.includes(expected));
        }
      }
      answers.push({ question, sheet, ref, value, automatic });
    }
    for (const website of ['https://shuangshengshutter.com', 'https://shutterblindssolutions.com'])
      assert.equal(
        answerMailQuestion(knowledge, { ...box, website }, 'What material is A211 made of?').sources
          .length,
        0,
      );
    return { imports, answers, foreignSitesBlocked: 2 };
  } finally {
    knowledge.close();
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { imports, answers, foreignSitesBlocked } = await verifyWorkbookAnswers(
    process.argv[2],
    process.argv[3],
  );
  console.log(
    JSON.stringify(
      {
        files: imports.length,
        sheets: imports.reduce((n, f) => n + f.sheets.length, 0),
        rows: imports.flatMap((f) => f.sheets).reduce((n, s) => n + s.rows, 0),
        verifiedAnswers: answers.length,
        foreignSitesBlocked,
      },
      null,
      2,
    ),
  );
}
