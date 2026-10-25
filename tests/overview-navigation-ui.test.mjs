import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ts from 'typescript';

const cache = new Map();
function loadComponent(path) {
  if (cache.has(path.href)) return cache.get(path.href).exports;
  const module = { exports: {} };
  cache.set(path.href, module);
  const normalRequire = createRequire(path);
  const require = (specifier) => {
    if (specifier.endsWith('.css')) return {};
    if (specifier.startsWith('.')) {
      for (const extension of ['', '.tsx', '.ts']) {
        const child = new URL(specifier + extension, path);
        if (existsSync(child) && /\.tsx?$/.test(child.pathname)) return loadComponent(child);
      }
    }
    return normalRequire(specifier);
  };
  const compiled = ts.transpileModule(readFileSync(path, 'utf8'), {
    fileName: fileURLToPath(path),
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports);
  return module.exports;
}
const { CustomerBusiness } = loadComponent(
  new URL('../src/pages/CustomerBusiness.tsx', import.meta.url),
);
const { ProductKnowledgePage } = loadComponent(
  new URL('../src/pages/ProductKnowledge.tsx', import.meta.url),
);
const { ExecutionRecords } = loadComponent(
  new URL('../src/pages/ExecutionRecords.tsx', import.meta.url),
);
const renderAt = (Component, path) =>
  renderToStaticMarkup(
    React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Component)),
  );

test('business deep links immediately render the linked task bucket and frozen cutoff', () => {
  const html = renderAt(
    CustomerBusiness,
    '/business?tab=tasks&bucket=due&asOf=2026-10-25T02%3A00%3A00.000Z',
  );
  assert.match(html, /<option value="due" selected="">当前到期跟进<\/option>/);
  assert.match(html, /当前筛选：到期跟进/);
  assert.match(html, /北京时间/);
  assert.match(html, /清除筛选/);
});

test('active demand and paused task links retain their status selection on initial render', () => {
  assert.match(
    renderAt(CustomerBusiness, '/business?tab=demands&state=active'),
    /<option value="active" selected="">进行中需求<\/option>/,
  );
  assert.match(
    renderAt(CustomerBusiness, '/business?tab=tasks&state=paused'),
    /<option value="paused" selected="">已暂停<\/option>/,
  );
});

test('product draft drilldown selects the real draft filter and invalid values use in-service documents', () => {
  assert.match(
    renderAt(ProductKnowledgePage, '/materials?status=draft'),
    /<option value="draft" selected="">待审核<\/option>/,
  );
  assert.match(
    renderAt(ProductKnowledgePage, '/materials?status=unknown'),
    /<option value="active" selected="">在用资料<\/option>/,
  );
});

test('new-company drilldown opens the capture view and preserves access to execution records', () => {
  const html = renderAt(ExecutionRecords, '/automation?tab=runs&view=captures&period=7d');
  assert.match(html, /实际新增企业明细/);
  assert.match(html, /返回执行记录/);
  assert.match(html, /href="\/automation\?tab=runs"/);
  assert.doesNotMatch(html, /查看实际执行进度、企业结果与搜索词产出/);
});
