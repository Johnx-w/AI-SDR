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

test('第三方平台过滤结果可展开查看域名、搜索词和原因，旧任务不伪造明细', () => {
  const metric = {
    id: 'search-mydeal',
    query: 'roller blinds supplier Australia',
    country: 'Australia',
    status: 'completed',
    discovered: 3,
    filtered: 3,
    filterReasons: { 第三方平台或目录: 2, 监管或统计资料: 1 },
    filteredSources: [
      { domain: 'mydeal.com.au', reason: '第三方平台或目录' },
      { domain: 'seller.example.org', reason: '第三方平台或目录' },
      { domain: 'statistics.example.gov', reason: '监管或统计资料' },
    ],
    duplicates: 0,
    queued: 0,
    researched: 0,
    inserted: 0,
    updated: 0,
    rejected: 0,
    review: 0,
    failed: 0,
    ratings: {},
  };
  const renderMetrics = (searchStats) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(BatchProgress, {
          job: { ...job, searchStats },
          control: () => {},
          busy: false,
        }),
      ),
    );
  const html = renderMetrics([metric]);
  assert.match(html, /第三方平台已过滤 2 条/);
  assert.match(html, /mydeal\.com\.au/);
  assert.match(html, /seller\.example\.org/);
  assert.match(html, /roller blinds supplier Australia/);
  assert.match(html, /第三方平台或目录/);
  assert.doesNotMatch(html, /statistics\.example\.gov/);

  const old = renderMetrics([
    {
      ...metric,
      id: 'old-search',
      query: 'legacy query',
      filtered: 1,
      filterReasons: { 第三方平台或目录: 1 },
      filteredSources: undefined,
    },
  ]);
  assert.doesNotMatch(old, /第三方平台已过滤/);
});

test('执行详情归组同来源表单，并区分任务暂停与独立补录', () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(BatchProgress, {
        job: {
          ...job,
          status: 'paused',
          rows: [
            {
              domain: 'buyer.example',
              result: 'inserted',
              handoff: {
                ready: true,
                reasons: [],
                contact_verified: true,
                contacts: [
                  {
                    kind: 'form',
                    value: 'sales',
                    source_url: 'https://buyer.example/contact',
                    quote: 'Sales enquiry',
                  },
                  {
                    kind: 'form',
                    value: 'trade',
                    source_url: 'https://buyer.example/contact',
                    quote: 'Trade enquiry',
                  },
                  {
                    kind: 'form',
                    value: 'quote',
                    source_url: 'https://buyer.example/request-quote',
                    quote: 'Request a quote',
                  },
                  {
                    kind: 'form',
                    value: 'unsafe',
                    source_url: 'javascript:alert(1)',
                    quote: 'Unsafe form',
                  },
                ],
              },
            },
            {
              domain: 'directory.example',
              source_url: 'https://directory.example/listing',
              result: 'review',
            },
          ],
        },
        control: () => {},
        busy: false,
      }),
    ),
  );

  assert.match(html, /已暂停 · 执行结果待确认/);
  assert.match(html, /确认执行结果并继续/);
  assert.equal((html.match(/<summary>业务联系表单<\/summary>/g) || []).length, 1);
  assert.match(html, /来源页（未保存表单编号）/);
  assert.equal((html.match(/https:\/\/buyer\.example\/contact/g) || []).length, 1);
  assert.match(html, /https:\/\/buyer\.example\/request-quote/);
  assert.doesNotMatch(html, /javascript:|Unsafe form/);
  assert.match(html, /企业独立官网/);
  assert.match(html, /第三方平台或目录页请替换为企业独立官网/);
  assert.match(html, /本操作独立补录，不改变原任务统计/);
  assert.match(html, /核实并尝试入库/);
});

test('Dandoush 五个历史来源只显示一个折叠入口，编号按同站归组', () => {
  const paths = [
    '/indoor/blinds/zebra-blinds-2/',
    '/',
    '/contact/',
    '/about-our-custom-made-window-coverings/',
    '/terms-conditions/',
  ];
  const sources = paths.map((path) => 'https://ccblinds.com.au' + path);
  const renderContacts = (contacts) =>
    renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(BatchProgress, {
          job: {
            ...job,
            rows: [
              {
                name: 'Dandoush Pty Ltd',
                result: 'inserted',
                handoff: { ready: true, reasons: [], contacts },
              },
            ],
          },
          control: () => {},
          busy: false,
        }),
      ),
    );
  const contacts = sources.map((source_url) => ({
    kind: 'form',
    value: source_url,
    source_url,
    quote: 'Saved form evidence',
  }));
  const historical = renderContacts(contacts);
  assert.equal((historical.match(/<summary>业务联系表单<\/summary>/g) || []).length, 1);
  assert.match(historical, /来源页（未保存表单编号）/);
  for (const source of sources) assert.ok(historical.includes(`href="${source}"`));
  const identified = renderContacts([
    ...contacts.map((contact) => ({ ...contact, form_id: 'wpforms:5450' })),
    { ...contacts[2], form_id: 'elementor:add9249' },
    { ...contacts[0], source_url: 'https://other.example/contact/', form_id: 'wpforms:5450' },
  ]);
  assert.equal((identified.match(/<summary>业务联系表单<\/summary>/g) || []).length, 1);
  assert.equal((identified.match(/表单编号 wpforms:5450/g) || []).length, 2);
  assert.equal((identified.match(/表单编号 elementor:add9249/g) || []).length, 1);
  assert.doesNotMatch(identified, /<details class="handoff-forms" open/);
});

test('来源人工暂停显示原因、未勾选首发、旧计划入口与继续删除操作', () => {
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(BatchProgress, {
        job: {
          ...job,
          status: 'paused',
          manualPaused: true,
          input: { auto_first_touch: false },
          sourcePause: { outreachPlanId: 'old-plan', reason: '关联触达已删除' },
        },
        control: () => {},
        busy: false,
      }),
    ),
  );
  assert.match(html, /关联触达已删除/);
  assert.match(html, /campaignId=old-plan/);
  assert.match(html, /继续获客/);
  assert.match(html, /删除来源任务/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*disabled/);
  assert.doesNotMatch(html, /<input[^>]*checked/);
});
