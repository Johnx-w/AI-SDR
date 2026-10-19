import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  improveCandidateSelection,
  checkExtractedCandidates,
  summarizeAcquisition,
  extractCheckCode,
  acquisitionSummaryCode,
} from '../server/n8n-acquisition.mjs';

const original = await readFile(
  new URL('./fixtures/n8n-select-original.txt', import.meta.url),
  'utf8',
);
const candidate = (host) => ({ source_url: `https://${host}/miami`, source_title: host });
function runCode(code, input, nodes, id = 'fixture-run') {
  return JSON.parse(
    JSON.stringify(
      vm.runInNewContext(`(function(){${code}\n})()`, {
        $input: { all: () => input.map((json) => ({ json })) },
        $: (name) => {
          if (!(name in nodes)) throw new Error('Unexecuted node');
          return { first: () => ({ json: nodes[name] }) };
        },
        $execution: { id },
      }),
    ),
  );
}
test('选择最多三个新域名，保留已有客户排重，不会重复运行同一个坏页面', () => {
  const code = improveCandidateSelection(original);
  assert.equal(improveCandidateSelection(code), code);
  const results = [
    'known.com',
    'blocked.com',
    'good.com',
    'good.com',
    'backup.com',
    'last.com',
  ].map((host) => ({ url: `https://${host}/miami` }));
  const [output] = runCode(code, [{ results }], {
    配置搜索目标: {},
    整理已知域名: { existing_customers_checked: true, known_domains: ['known.com'] },
  });
  assert.deepEqual(output.json.candidate_urls, [
    'https://blocked.com/miami',
    'https://good.com/miami',
    'https://backup.com/miami',
  ]);
  assert.equal(output.json.skipped_existing_count, 1);
  assert.equal(output.json.candidates.length, 3);
});
test('首个候选抓取失败时使用第二个正文，来源和正文严格对应', () => {
  const selection = { candidates: [candidate('blocked.com'), candidate('good.com')] };
  const output = runCode(
    extractCheckCode,
    [
      {
        results: [{ url: 'https://good.com/miami', raw_content: 'Real good company content' }],
        failed_results: [{ url: 'https://blocked.com/miami', error: 'Failed to fetch url' }],
      },
    ],
    { 选择一个独立企业官网: selection },
  )[0].json;
  assert.equal(output.has_text, true);
  assert.equal(output.source_url, 'https://good.com/miami');
  assert.equal(output.page_text, 'Real good company content');
  assert.equal(output.extract_failures[0].source_url, 'https://blocked.com/miami');
});
test('不把无关结果正文归到候选名下，全部失败仍返回明确原因', () => {
  const output = checkExtractedCandidates(
    { ...candidate('blocked.com'), candidates: [candidate('blocked.com')] },
    [{ results: [{ url: 'https://unrelated.com/miami', raw_content: 'Wrong company' }] }],
  );
  assert.equal(output.has_text, false);
  assert.equal(output.stage, 'extract');
  assert.match(output.reason, /blocked.com/);
  assert.equal(output.page_text, undefined);
});
test('所有候选已收录时返回无新候选，不宣称写入成功', () => {
  const selection = runCode(
    improveCandidateSelection(original),
    [{ results: [{ url: 'https://known.com' }] }],
    {
      配置搜索目标: {},
      整理已知域名: { existing_customers_checked: true, known_domains: ['known.com'] },
    },
  )[0].json;
  const summary = runCode(acquisitionSummaryCode, [{ ok: false, ...selection }], {
    最终结果: { ok: false, ...selection },
    选择一个独立企业官网: selection,
  })[0].json;
  assert.equal(summary.outcome, 'no_new_candidates');
  assert.equal(summary['新增'], 0);
  assert.equal(summary.execution_id, 'fixture-run');
  assert.match(summary.reason, /均已在飞书收录/);
});
test('抓取失败和写入失败均保留原因，成功统计实际飞书写入数量', () => {
  const failed = summarizeAcquisition(
    [{ ok: false }],
    { stage: 'extract', reason: '抓取失败' },
    {},
    '1',
  );
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.reason, '抓取失败');
  const writeFailed = summarizeAcquisition(
    [{ result: 'failed', reason: '飞书权限异常' }],
    { ok: true },
    {},
    '2',
  );
  assert.equal(writeFailed.outcome, 'failed');
  assert.equal(writeFailed['失败'], 1);
  assert.equal(writeFailed.reason, '飞书权限异常');
  const partial = summarizeAcquisition(
    [{ result: 'inserted' }, { result: 'failed' }],
    { ok: true },
    {},
    '3',
  );
  assert.equal(partial.outcome, 'partial');
  assert.equal(partial['新增'], 1);
  const success = summarizeAcquisition([{ result: 'updated' }], { ok: true }, {}, '4');
  assert.equal(success.outcome, 'completed');
  assert.equal(success['更新'], 1);
});
