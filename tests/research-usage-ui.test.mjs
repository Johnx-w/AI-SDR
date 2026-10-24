import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ts from 'typescript';

// Compile the real TSX with installed dependencies; no browser, network, Vite
// server or alternate rendering implementation is needed for these checks.
const path = new URL('../src/components/BatchProgress.tsx', import.meta.url);
const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
    esModuleInterop: true,
  },
}).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(createRequire(path), module, module.exports);
const { BatchProgress } = module.exports;
const job = {
  id: 'usage-ui-fixture',
  input: { acquisition_channel: 'web' },
  status: 'partial',
  target: 5,
  inserted: 0,
  updated: 0,
  skipped: 0,
  rejected: 0,
  failed: 0,
  pending: 0,
  searches: 0,
  researched: 0,
  createdAt: '2026-10-24T00:00:00Z',
  message: 'Fixture',
  rows: [],
};
const render = (researchUsage) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(BatchProgress, {
        job: { ...job, ...(researchUsage ? { researchUsage } : {}) },
        control: () => {},
        busy: false,
      }),
    ),
  );

test('旧任务没有 usage 时隐藏模型指标，不伪造零请求或缓存命中', () => {
  const html = render();
  assert.doesNotMatch(html, /模型请求|结果复用|Token 输入|Token 输出/);
});

test('新任务明确报告零调用时显示真实 0；没有 Token 时不显示输入输出', () => {
  const html = render({ model_calls: 0, cache_hits: 0, input_chars: 0 });
  assert.match(html, /模型请求 0 次/);
  assert.match(html, /结果复用 0 次/);
  assert.doesNotMatch(html, /Token 输入|Token 输出|输入 0|输出 0/);
});

test('真实 usage 显示模型尝试和缓存命中，解释只放在指标 title 中', () => {
  const html = render({ model_calls: 2, cache_hits: 3, input_chars: 100 });
  assert.match(html, /模型请求 2 次/);
  assert.match(html, /结果复用 3 次/);
  assert.match(html, /title="模型请求按尝试统计；Token 仅累计供应商返回值。"/);
  assert.doesNotMatch(html, />模型请求按尝试/);
  assert.doesNotMatch(html, /成功计费|预估金额/);
});

test('只展示供应商已返回的 Token，缺失一侧明确未返回而不是 0', () => {
  const html = render({ model_calls: 1, cache_hits: 0, input_chars: 100, input_tokens: 30 });
  assert.match(html, /Token 输入 30 \/ 输出 未返回/);
  assert.doesNotMatch(html, /输出 0/);
  const reportedZero = render({
    model_calls: 1,
    cache_hits: 0,
    input_chars: 100,
    input_tokens: 0,
    output_tokens: 4,
  });
  assert.match(reportedZero, /Token 输入 0 \/ 输出 4/);
});
