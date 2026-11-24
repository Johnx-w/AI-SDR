import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProductKnowledge } from '../server/product-knowledge.mjs';
import { MaterialLibrary } from '../server/materials.mjs';
import { answerMailQuestion } from '../server/mail-knowledge.mjs';
import { composeMailDraft } from '../server/mail-assisted-draft.mjs';
import { verifyGrounding } from '../server/mail-reception.mjs';
import { createApp } from '../server/app.mjs';
import { regionImage } from '../server/parameter-extraction.mjs';
import sharp from 'sharp';

const fixture = (name) => readFileSync(new URL('./fixtures/' + name, import.meta.url));
const site = 'honeybadgerblinds.com',
  box = { website: 'https://' + site, brandName: 'Honey Badger' };
const mode = 'model_parameters';
test('清洗表从上传、来源 PDF、采用到试运行草稿逐项引用，跨邮箱选材、缺项及歧义复核', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'parameter-mail-')),
    path = join(dir, 'knowledge.sqlite');
  const k = new ProductKnowledge(path);
  const app = createApp({
    env: { PRODUCT_KNOWLEDGE_DB_PATH: path },
    outreachServiceFactory: () => ({ mailboxes: { list: () => [box] }, close() {} }),
    fetchImpl: () => {
      throw Error('清洗表不应调用远端');
    },
  });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => app.close(r));
    k.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + app.address().port + '/api/v1/materials';
  const request = async (path, body, method = 'POST') => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: Buffer.isBuffer(body) ? body : JSON.stringify(body),
    });
    return [res.status, await res.json()];
  };
  const [code, receipt] = await request(
    '?name=clean.xlsx&site=' + site + '&mode=' + mode,
    fixture('model-parameters.xlsx'),
  );
  assert.equal(code, 201);
  assert.equal(receipt.warning, '');
  const id = receipt.id;
  const get = async () => await (await fetch(base + '/' + id)).json();
  const ask = (question, mailbox = box) =>
    answerMailQuestion(k, { ...mailbox, knowledgeProductIds: [id] }, question, Date.now(), {
      forDraft: true,
    });
  let detail = await get();
  const candidates = detail.documents[0].extraction.parameters;
  assert.ok(candidates.find((c) => c.item === 'ZX-04').issue.includes('单位'));
  assert.ok(candidates.find((c) => c.item === 'ZX-05').issue.includes('冲突'));
  assert.ok(candidates.find((c) => c.item === 'ZX-06').issue.includes('重复'));
  assert.equal(ask('How wide is 0128?').sources.length, 0);
  const [, attached] = await request(
    '/' + id + '/evidence?name=catalog.pdf&version=' + detail.currentVersion,
    fixture('material-mixed-catalog.pdf'),
  );
  assert.ok(attached.documentId);
  const keys = candidates.filter((c) => !c.issue).map((c) => c.key);
  const approval = {
    version: attached.version,
    status: 'approved',
    approvedBy: 'QA',
    parameterKeys: keys,
  };
  assert.equal(
    (
      await request(
        '/' + id,
        { ...approval, parameterKeys: [...keys, candidates.find((c) => c.item === 'ZX-04').key] },
        'PATCH',
      )
    )[0],
    400,
  );
  assert.equal((await request('/' + id, approval, 'PATCH'))[0], 200);
  assert.equal((await request('/' + id, approval, 'PATCH'))[0], 409);
  const answer = ask('How wide is 0128?'),
    s = answer.sources[0];
  assert.equal(answer.automatic, true);
  assert.deepEqual(
    [s.item, s.field, s.value, s.sheet, s.ref, s.conditions, s.upstream.page],
    ['0128', '叶片宽度', '152 mm', '规格', 'B2', '标准款', 2],
  );
  assert.equal(s.upstream.documentId, attached.documentId);
  assert.equal(
    (
      await fetch(base + '/' + id + '/document/' + s.upstream.documentId + '#page=2', {
        headers: { Range: 'bytes=0-3' },
      })
    ).status,
    206,
  );
  assert.equal(ask('How thick is 0128?').sources[0].upstream.page, 3);
  assert.equal(ask('How wide is SL-0128?').sources[0].item, '0128');
  assert.equal(ask('How wide is 128?').sources[0].value, '12 mm');
  assert.equal(ask('How wide is 0128-H?').sources[0].value, '158 mm');
  assert.equal(ask('How wide is 0128-HE?').sources.length, 0);
  for (const q of [
    'What is the width of ZX-02?',
    'ZX-03 宽度？',
    'What material is 0128?',
    'How wide are 0128 and 128?',
  ]) {
    assert.equal(ask(q).automatic, false, q);
    assert.deepEqual(ask(q).draftSources, [], q);
  }
  assert.equal(ask('ZX-02 叶片宽度？').sources[0].value, '40 mm');
  assert.equal(ask('What is the side-mounted width of ZX-03?').sources[0].value, '22 mm');
  assert.equal(ask('ZX-03 顶装宽度？').sources[0].value, '20 mm');
  assert.equal(
    ask('How wide is 0128?', { website: 'https://shuangshengshutter.com' }).sources[0].productId,
    id,
  );
  const basis = {
    question: 'How wide is 0128?',
    answer,
    sources: answer.draftSources,
    mail: { subject: '0128' },
    box,
    history: [],
  };
  const model = {
    name: 'fixture',
    generate: async (messages) => {
      const input = JSON.parse(messages[1].content);
      assert.equal(input.evidence[0].conditions, '标准款');
      return messages[0].content.includes('Verify a proposed')
        ? '{"supported":true}'
        : JSON.stringify({
            coverage: 'answered',
            language: 'en',
            body: 'The standard 0128 is 152 mm wide.',
            sourceIndexes: [0],
          });
    },
  };
  const draft = await composeMailDraft(
    { isMaintaining: () => false, mailboxes: { list: () => [box] } },
    basis,
    model,
  );
  assert.equal(draft.sources[0].ref, 'B2');
  assert.equal(await verifyGrounding(model, basis, draft), true);
  assert.equal(
    await verifyGrounding(model, basis, { ...draft, body: 'Model 0128 is 152 mm wide.' }),
    false,
  );
  assert.equal(
    await verifyGrounding(model, basis, { ...draft, body: 'The standard 0128 is 152 cm wide.' }),
    false,
  );
  const blocked = ask('How wide is ZX-02?');
  const clarify = await composeMailDraft({}, { ...basis, answer: blocked }, model);
  assert.equal(clarify.needsManager, true);
  assert.match(clarify.body, /confirm/iu);
  detail = await get();
  const savedVersion = detail.currentVersion;
  const bad = await request(
    '/' + id + '/versions?name=broken.xlsx&version=' + savedVersion,
    Buffer.from('PK\x03\x04broken'),
  );
  assert.ok(bad[0] >= 400);
  assert.equal((await get()).currentVersion, savedVersion);
  assert.equal(ask('How wide is 0128?').sources[0].value, '152 mm');
  const replaced = await request(
    '/' + id + '/versions?name=updated.xlsx&version=' + savedVersion,
    fixture('mail-specimen.xlsx'),
  );
  assert.equal(replaced[0], 201);
  assert.equal(ask('How wide is 0128?').sources.length, 0);
  const old = await (await fetch(base + '/' + id + '?revision=' + savedVersion)).json();
  assert.equal(old.confirmedParameters.find((p) => p.ref === 'B2').upstream.page, 2);
  detail = await get();
  assert.equal(
    (await request('/' + id, { version: detail.currentVersion, status: 'archived' }, 'PATCH'))[0],
    200,
  );
  assert.deepEqual(ask('How wide is 0128?').sources, []);
});
test('Office 原生表按幻灯片顺序定位，Word、Markdown、TXT 逐段引用原句', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const lib = new MaterialLibrary(k, [box]);
  const env = { MATERIAL_DEEPSEEK_API_KEY: 'fixture' };
  for (const name of ['material-slats.docx', 'model-parameters.pptx', 'notes.md', 'notes.txt']) {
    const binary = /\.(docx|pptx)$/u.test(name);
    const file = binary ? fixture(name) : Buffer.from('Specifications\nMX42 width is 73 mm.');
    const response = await lib.upload({
      name,
      bytes: file,
      mode,
      env,
      site,
      key: randomUUID(),
      fetchImpl: async (url, init) => {
        assert.ok(url.endsWith('/chat/completions'));
        const content = JSON.parse(init.body).messages[1].content[0].text.split('\n每条结果')[0];
        const blocks = JSON.parse(content);
        const b = blocks.find((b) => b.text.includes('MX42') || b.text.includes('Plantation'));
        const parameters = b
          ? [
              {
                block: b.id,
                item: name.endsWith('docx') ? 'Plantation shutter slats' : 'MX42',
                field: 'Width',
                value: name.endsWith('docx') ? '89 mm' : '73 mm',
                quote: b.text,
                uncertain: false,
                conditions: '',
              },
            ]
          : [];
        return Response.json({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ parameters, warnings: [] }) },
            },
          ],
        });
      },
    });
    assert.equal(response.warning, '');
    const c = lib.detail(response.id).documents[0].extraction.parameters[0];
    assert.equal(c.issue, '');
    if (name.endsWith('pptx'))
      assert.deepEqual(
        [c.item, c.value, c.ref],
        ['0128', '152 mm', '幻灯片 2 · 表 1 第 2 行 · 第 2 列'],
      );
    else assert.match(c.ref, /第 2 段/);
  }
});
test('截图先读版面，视觉候选保留可回读区域；重解析不改变已采用事实', async (t) => {
  const k = new ProductKnowledge();
  t.after(() => k.close());
  const lib = new MaterialLibrary(k, [box]);
  const bytes = fixture('material-spec.webp');
  let value = '73 mm';
  const calls = [];
  const input = {
    name: 'spec.webp',
    bytes,
    site,
    key: randomUUID(),
    mode,
    env: { MATERIAL_DEEPSEEK_API_KEY: 'fixture' },
    fetchImpl: async (url, init) => {
      calls.push(url);
      if (url.endsWith('/ocr'))
        return Response.json({ pages: [{ text: 'MX42 Width ' + value, finish_reason: 'stop' }] });
      const content = JSON.parse(init.body).messages[1].content;
      assert.ok(content.some((x) => x.type === 'image_url'));
      assert.match(content[0].text, /MX42/);
      return Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                parameters: [
                  {
                    block: 0,
                    item: 'MX42',
                    field: 'Width',
                    value,
                    conditions: '',
                    quote: 'MX42 Width ' + value,
                    uncertain: false,
                    box: [0, 0, 500, 500],
                  },
                ],
                warnings: [],
              }),
            },
          },
        ],
      });
    },
  };
  const r = await lib.upload(input);
  assert.equal(r.warning, '');
  assert.equal(calls.length, 2);
  let detail = lib.detail(r.id);
  const c = detail.documents[0].extraction.parameters[0];
  assert.equal(c.issue, '');
  const original = k.documents.get(r.id, r.documentId);
  const region = await sharp(await regionImage(original, 1, c.box, c.ref)).metadata();
  const whole = await sharp(bytes).metadata();
  assert.equal(region.width, Math.ceil(whole.width / 2));
  lib.edit(r.id, {
    version: detail.currentVersion,
    status: 'approved',
    approvedBy: 'QA',
    parameterKeys: [c.key],
  });
  value = '74 mm';
  await k.documents.extract(r.id, r.documentId, { ...input, material: true, reparse: true });
  detail = lib.detail(r.id);
  assert.equal(detail.confirmedParameters[0].value, '73 mm');
  assert.equal(detail.documents[0].extraction.parameters[0].value, '74 mm');
  assert.equal(
    answerMailQuestion(k, { ...box, knowledgeProductIds: [r.id] }, 'How wide is MX42?').sources[0]
      .value,
    '73 mm',
  );
});
