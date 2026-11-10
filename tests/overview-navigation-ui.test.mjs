import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { loadModule } from './helpers/modules.mjs';

const { CustomerBusiness } = loadModule(
  new URL('../src/pages/CustomerBusiness.tsx', import.meta.url),
);
const { ProductKnowledgePage } = loadModule(
  new URL('../src/pages/ProductKnowledge.tsx', import.meta.url),
);
const { ExecutionRecords } = loadModule(
  new URL('../src/pages/ExecutionRecords.tsx', import.meta.url),
);
const renderAt = (Component, path) =>
  renderToStaticMarkup(
    React.createElement(MemoryRouter, { initialEntries: [path] }, React.createElement(Component)),
  );

test('任务页只读且状态筛选可直达，不展示采购需求、沟通录入或完成按钮', () => {
  const html = renderAt(CustomerBusiness, '/business?tab=tasks&state=skipped');
  assert.match(html, /<option value="skipped" selected="">跳过<\/option>/);
  assert.match(html, /所属发送计划/);
  assert.doesNotMatch(html, /新增任务|录入沟通|新增需求|标记完成/);
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
});
