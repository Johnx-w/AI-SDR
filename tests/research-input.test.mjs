import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedResearchPages } from '../server/research-input.mjs';

const page = (id, text) => ({ source_url: `https://company.example/${id}`, text });
const hasBrokenPair = (text) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text);

test('默认只送前五个有效页面，总正文不超过八万字符，不按产品关键词替代判定', () => {
  const input = Array.from({ length: 8 }, (_, i) =>
    page(i, `${i}-unrelated business `.repeat(2000)),
  );
  const before = structuredClone(input);
  const result = boundedResearchPages(input);
  assert.deepEqual(
    result.pages.map((item) => item.source_url),
    input.slice(0, 5).map((item) => item.source_url),
  );
  assert.equal(result.stats.sourcePages, 8);
  assert.equal(result.stats.selectedPages, 5);
  assert.equal(result.stats.omittedPages, 3);
  assert.equal(result.stats.truncatedPages, 5);
  assert.equal(result.stats.inputChars, 80000);
  assert.ok(result.pages.every((item) => item.text.length === 16000));
  assert.deepEqual(input, before);
});

test('单页超预算保留开头与页尾事实，而非仅前缀', () => {
  const result = boundedResearchPages([
    page('catalog', 'HEAD-EVIDENCE' + 'M'.repeat(30000) + 'TAIL-EVIDENCE'),
  ]);
  assert.equal(result.pages[0].text.length, 16000);
  assert.ok(result.pages[0].text.startsWith('HEAD-EVIDENCE'));
  assert.ok(result.pages[0].text.endsWith('TAIL-EVIDENCE'));
  assert.equal(result.stats.truncatedPages, 1);
});

test('首次有效 URL 按顺序去重，空文本不占用 URL，不合并其他域名或不同查询', () => {
  const result = boundedResearchPages([
    page('empty', '   '),
    { source_url: 'not a URL', text: 'bad' },
    { source_url: 'javascript:alert(1)', text: 'bad' },
    page('one#first', 'first'),
    page('one#second', 'duplicate'),
    page('empty', 'later valid'),
    { source_url: 'https://another.example/one', text: 'different domain' },
    page('one?variant=1', 'different query'),
  ]);
  assert.deepEqual(
    result.pages.map((item) => item.text),
    ['first', 'later valid', 'different domain', 'different query'],
  );
  assert.equal(result.pages[0].source_url, 'https://company.example/one#first');
  assert.equal(result.stats.omittedPages, 4);
});

test('总量预算截断最后保留页面，不把被省略原文混入返回证据', () => {
  const result = boundedResearchPages(
    [
      page('first', 'A'.repeat(12)),
      page('second', 'HEAD' + 'B'.repeat(100) + 'TAIL'),
      page('third', 'SHOULD-NOT-BE-AUDITED'),
    ],
    { maxPageChars: 20, maxTotalChars: 30 },
  );
  assert.equal(result.pages.length, 2);
  assert.equal(result.stats.inputChars, 30);
  assert.equal(result.stats.truncatedPages, 1);
  assert.equal(result.stats.omittedPages, 1);
  assert.ok(result.pages[1].text.endsWith('TAIL'));
  assert.ok(!JSON.stringify(result.pages).includes('SHOULD-NOT-BE-AUDITED'));
});

test('每页与总量截断都不拆开 Unicode 代理对，小预算也不超限', () => {
  for (const budget of [1, 2, 3, 4, 5, 7, 19, 37, 15999]) {
    const result = boundedResearchPages([page('unicode', '😀'.repeat(20000))], {
      maxPageChars: budget,
      maxTotalChars: budget,
    });
    assert.ok(result.stats.inputChars <= budget);
    assert.equal(
      result.stats.inputChars,
      result.pages.reduce((sum, item) => sum + item.text.length, 0),
    );
    for (const item of result.pages) assert.equal(hasBrokenPair(item.text), false);
  }
});

test('跳过空及非字符串页面；不执行对象字符串化或网络访问', () => {
  const result = boundedResearchPages([
    null,
    {},
    page('empty', ''),
    page('number', 123),
    { source_url: 'https://user:password@company.example', text: 'blocked' },
  ]);
  assert.deepEqual(result.pages, []);
  assert.deepEqual(result.stats, {
    sourcePages: 5,
    selectedPages: 0,
    inputChars: 0,
    omittedPages: 5,
    truncatedPages: 0,
  });
});

test('预算可缩小但不能放宽硬闸；非法选项明确拒绝', () => {
  for (const [key, values] of Object.entries({
    maxPages: [0, -1, 6, 1.5, '5', NaN, null],
    maxPageChars: [0, 16001, Infinity],
    maxTotalChars: [0, 80001, -3],
  }))
    for (const value of values)
      assert.throws(() => boundedResearchPages([], { [key]: value }), RangeError);
  for (const options of [null, [], 'invalid', 2])
    assert.throws(() => boundedResearchPages([], options), TypeError);
  assert.throws(() => boundedResearchPages(null), TypeError);
  assert.equal(
    boundedResearchPages([page(1, 'first'), page(2, 'second')], { maxPages: 1 }).pages.length,
    1,
  );
});
