import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const component = new URL('../src/components/OverviewReminders.tsx', import.meta.url);
const compiled = ts.transpileModule(readFileSync(component, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)(
  createRequire(component),
  module,
  module.exports,
);
const { OverviewReminders } = module.exports;
const ready = { state: 'ready', updatedAt: '2026-10-25T02:00:00Z', error: '' };
const fixture = () => ({
  asOf: '2026-10-25T02:00:00Z',
  sources: { business: { ...ready }, products: { ...ready } },
  work: { overdue: 0, today: 0, paused: 0 },
  links: {
    overdue: '/business?tab=tasks&bucket=overdue',
    today: '/business?tab=tasks&bucket=today',
    paused: '/business?tab=tasks&bucket=paused',
  },
  products: { draft: 0, to: '/materials?status=draft' },
});
const render = (data, props = {}) =>
  renderToStaticMarkup(
    React.createElement(OverviewReminders, {
      data,
      loading: false,
      error: '',
      onOpen() {},
      ...props,
    }),
  );

test('提醒仅在两个来源均成功读取且计数为零时报告无待办', () => {
  assert.match(render(fixture()), /当前没有到期或待核对事项/);
  for (const source of ['business', 'products']) {
    const data = fixture();
    data.sources[source].state = 'stale';
    const html = render(data);
    assert.doesNotMatch(html, /当前没有到期或待核对事项/);
    assert.match(html, /保留上次数据，当前状态需核对/);
    assert.match(html, source === 'products' ? /产品资料/ : /需求与跟进/);
  }
});

test('未知来源、请求失败与加载中不冒充空待办，有事项时展示真实数量', () => {
  const data = fixture();
  data.sources.products.state = 'unavailable';
  data.products.draft = null;
  assert.match(render(data), /部分提醒暂时无法统计/);
  assert.doesNotMatch(render(data), /当前没有到期或待核对事项/);
  assert.doesNotMatch(render(fixture(), { error: '读取失败' }), /当前没有到期或待核对事项/);
  assert.doesNotMatch(render(null, { loading: true }), /当前没有到期或待核对事项/);
  const actionable = fixture();
  actionable.work.overdue = 2;
  assert.match(render(actionable), /逾期跟进/);
  assert.match(render(actionable), /2 项/);
  assert.doesNotMatch(render(actionable), /当前没有到期或待核对事项/);
});
