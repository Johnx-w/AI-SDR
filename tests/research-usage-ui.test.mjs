import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { loadModule } from './helpers/modules.mjs';

const { BatchProgress } = loadModule(
  new URL('../src/components/BatchProgress.tsx', import.meta.url),
);
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

test('历史单次任务显示永久取消入口，取消后只保留状态和详情链接', () => {
  const html = (autoFirstTouchCancelled) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(BatchProgress, {
          job: {
            ...job,
            status: 'completed',
            input: { ...job.input, auto_first_touch: true },
            autoFirstTouchCancelled,
          },
          control: () => {},
          busy: false,
        }),
      ),
    );
  assert.match(html(false), /取消自动首发/);
  assert.match(html(true), /已取消/);
  assert.match(html(true), /查看首发进度与缺项/);
  assert.doesNotMatch(html(true), /取消自动首发|恢复自动首发|暂停自动首发/);
});

test('新任务明确报告零调用时显示真实 0；没有 Token 时不显示输入输出', () => {
  const html = render({ model_calls: 0, cache_hits: 0, input_chars: 0 });
  assert.match(html, /模型请求 0 次/);
  assert.match(html, /结果复用 0 次/);
  assert.doesNotMatch(html, /Token 输入|Token 输出|输入 0|输出 0/);
});

test('真实 usage 显示模型尝试和缓存命中，不推断计费金额', () => {
  const html = render({ model_calls: 2, cache_hits: 3, input_chars: 100 });
  assert.match(html, /模型请求 2 次/);
  assert.match(html, /结果复用 3 次/);
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

test('批次结果只展示 A/B/C，不展示旧评级或评分数字', () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(BatchProgress, {
        job: {
          ...job,
          rows: [
            {
              domain: 'a.example',
              result: 'inserted',
              assessment: { grade: 'A', score: 70, status: 'A' },
            },
            {
              domain: 'b.example',
              result: 'inserted',
              assessment: { grade: 'B', score: 65, status: '可开发' },
            },
          ],
          searchStats: [
            {
              id: 'search-1',
              query: 'blinds',
              country: 'US',
              status: 'completed',
              discovered: 2,
              duplicates: 0,
              researched: 2,
              queued: 2,
              review: 0,
              rejected: 0,
              failed: 0,
              inserted: 2,
              ratings: { A: 1, B: 1, C: 0, unrated: 0 },
            },
          ],
        },
        control: () => {},
        busy: false,
      }),
    ),
  );
  assert.match(html, /A 1 · B 1 · C 0/);
  assert.doesNotMatch(html, /旧记录|旧版/);
  assert.doesNotMatch(html, /已支持70分|已支持65分|\/100/);
});
