import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { workbookType, workbookPage } from '../server/product-workbooks.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';

export async function honeybadgerFixture(dir = String.raw`C:\Users\Johnson\Desktop\产品资料`) {
  const knowledge = new ProductKnowledge();
  const box = { website: 'https://honeybadgerblinds.com', knowledgeProductIds: [] };
  const files = readdirSync(dir, { recursive: true }).filter(
    (f) => f.toLowerCase().endsWith('.xlsx') && !basename(f).startsWith('~$'),
  );
  assert.equal(files.length, 3, '需要三份验收工作簿');
  const imports = [];
  for (const name of files) {
    const product = knowledge.save({
      name: basename(name, '.xlsx'),
      direction: 'materials',
      brands: ['Honey Badger Blinds'],
      sourceUrl: box.website,
    });
    const document = knowledge.documents.upload(product.id, {
      name: basename(name),
      contentType: workbookType,
      contentBase64: readFileSync(join(dir, name)).toString('base64'),
    });
    const { extraction } = await knowledge.documents.extract(product.id, document.id, { env: {} });
    knowledge.save({
      ...product,
      documentIds: [document.id],
      status: 'approved',
      approvedBy: '本地验收',
    });
    imports.push({ file: document.name, sheets: extraction.sheets });
    box.knowledgeProductIds.push(product.id);
  }
  return { knowledge, box, imports };
}

export async function verifyWorkbookAnswers(dir) {
  const { knowledge, box, imports } = await honeybadgerFixture(dir);
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
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  console.log(JSON.stringify(await verifyWorkbookAnswers(process.argv[2]), null, 2));
