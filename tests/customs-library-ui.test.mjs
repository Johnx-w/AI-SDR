import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { summarizeLead } from '../server/lead-library.mjs';

const buyer = {
  id: 'buyer-1',
  name: 'Acme Screens Inc',
  product_family: 'fabrics',
  match: { status: 'verified', reason: '官网法人名称和地址与进口买方一致' },
  metrics: {
    record_count: 1,
    bill_of_lading_count: 1,
    unnumbered_record_count: 0,
    active_months: ['2026-10'],
    last_event_date: '2026-10-01',
  },
  records: [
    {
      id: 'shipment-1',
      provider: 'fixture',
      date: '2026-10-01',
      description: 'roller blind fabric',
      bill_of_lading_number: 'BL-100',
      source_url: 'https://records.example.org/shipment-1',
    },
  ],
};
const lead = {
  id: 'lead-1',
  name: 'Acme Screens',
  domain: 'acme.example.org',
  market: 'United States',
  type: 'distributor',
  product: 'roller blind fabric',
  match: '',
  score: 70,
  grade: 'B',
  status: '待开发',
  region: '',
  city: '',
  contact: '',
  email: '',
  phone: '',
  website: 'https://acme.example.org/',
  source: '',
  evidence: '',
  facts: [],
  contactEvidence: [],
  fields: {},
  customsEvidence: [buyer],
};

// Render the real library and its real TSX children with deterministic loaded
// data; replace only browser routing, initial state and the workspace context.
function renderLibrary(tab = '客户画像', customers = [lead], options = {}) {
  const cache = new Map();
  const snapshot = {
    leads: customers.map(summarizeLead),
    syncedAt: '2026-10-25T01:00:00.000Z',
    total: customers.length,
    source: 'feishu',
    scope: 'fixture',
    sync: { refreshing: false, stale: false, error: '', revision: 1 },
    ...options.snapshot,
  };
  const entry = new URL('../src/pages/LeadLibrary.tsx', import.meta.url);
  function load(path) {
    const key = path.href;
    if (cache.has(key)) return cache.get(key).exports;
    const module = { exports: {} };
    cache.set(key, module);
    const normalRequire = createRequire(path);
    const require = (specifier) => {
      if (key === entry.href) {
        if (specifier === 'react')
          return {
            ...React,
            useEffect: () => {},
            useState: (initial) => [initial === '客户画像' ? tab : initial, () => {}],
          };
        if (specifier === 'react-router-dom')
          return {
            useSearchParams: () => [new URLSearchParams({ lead: 'lead-1' }), () => {}],
          };
        if (specifier === '../app/WorkspaceProvider')
          return { useWorkspace: () => ({ notify() {} }) };
        if (specifier === '../services/workspace') return { exportCsv() {} };
        if (specifier === '../services/leadLibrary')
          return {
            leadLibrary: {
              cachedList: () => snapshot,
              cachedDetail: (id) =>
                options.pending ? null : customers.find((item) => item.id === id),
            },
          };
      }
      if (specifier.endsWith('.css')) return {};
      if (specifier.startsWith('.')) {
        for (const extension of ['', '.tsx', '.ts']) {
          const child = new URL(specifier + extension, path);
          if (existsSync(child) && /\.tsx?$/.test(child.pathname)) return load(child);
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
  return renderToStaticMarkup(React.createElement(load(entry).LeadLibrary));
}

test('客户库列表和档案直接提供海关记录入口，不必到评分历史中寻找', () => {
  const html = renderLibrary();
  assert.match(html, />海关记录<\/button>/);
  assert.match(html, /海关记录 1 条/);
});

test('后台同步保留精简列表，档案尚未加载时显示独立加载状态', () => {
  const html = renderLibrary('客户画像', [lead], {
    pending: true,
    snapshot: {
      sync: { refreshing: true, stale: true, error: '', revision: 1 },
    },
  });
  assert.match(html, /Acme Screens/);
  assert.match(html, /reference-lead-table/);
  assert.match(html, /海关记录 1 条/);
  assert.match(html, /正在后台同步/);
  assert.match(html, /正在读取客户档案/);
  assert.doesNotMatch(html, /BL-100/);
});

test('同步失败时保留客户列表，并展示最近同步时间与错误', () => {
  const html = renderLibrary('客户画像', [lead], {
    snapshot: {
      sync: { refreshing: false, stale: true, error: '飞书暂时不可用', revision: 1 },
    },
  });
  assert.match(html, /reference-lead-table/);
  assert.match(html, /最近同步/);
  assert.match(html, /保留已有客户：飞书暂时不可用/);
});

test('同步耗时与变更计数集中在默认折叠的同步详情中', () => {
  const html = renderLibrary('客户画像', [lead], {
    snapshot: {
      sync: {
        refreshing: false,
        stale: false,
        error: '',
        revision: 1,
        mode: 'idle',
        intervalMs: 300000,
        metrics: {
          attempts: 3,
          successes: 2,
          failures: 1,
          last: {
            status: 'success',
            durationMs: 1234,
            upstreamMs: 1200,
            writeMs: 4,
            inserted: 1,
            updated: 2,
            deleted: 3,
            unchanged: 10,
          },
        },
      },
    },
  });
  const disclosure = html.match(/<details class="library-sync-details">([\s\S]*?)<\/details>/)?.[0];
  assert.ok(disclosure);
  assert.doesNotMatch(disclosure, /<details[^>]*\sopen(?:=|[\s>])/);
  const text = disclosure.replace(/<[^>]*>/g, '');
  assert.match(text, /同步详情/);
  assert.match(text, /空闲时每 300 秒同步/);
  assert.match(text, /已尝试 3 次 · 成功 2 次 · 失败 1 次/);
  assert.match(text, /最近一次成功，耗时 1\.23 秒/);
  assert.match(text, /新增 1 位 · 更新 2 位 · 移除 3 位 · 未变化 10 位/);
});

test('海关记录标签展示真实买方身份、提单、货物描述和来源', () => {
  const html = renderLibrary('海关记录');
  assert.match(html, /买方身份关联已核实/);
  assert.match(html, /BL-100/);
  assert.match(html, /roller blind fabric/);
  assert.match(html, /href="https:\/\/records\.example\.org\/shipment-1"/);
});

test('没有海关记录时明确展示未关联状态，不能当作零进口', () => {
  const html = renderLibrary('海关记录', [{ ...lead, customsEvidence: [] }]);
  assert.match(html, /尚无关联到该官网的海关记录/);
  assert.doesNotMatch(html, /零进口|没有进口|海关记录 0 条/);
});

test('仅名称匹配时明确标记待核实，不能展示为已确认企业进口', () => {
  const html = renderLibrary('海关记录', [
    {
      ...lead,
      customsEvidence: [{ ...buyer, match: { status: 'name_only', reason: '仅买方名称一致' } }],
    },
  ]);
  assert.match(html, /海关记录 1 条 · 身份待核实/);
  assert.match(html, /仅名称一致 · 待核实/);
  assert.doesNotMatch(html, /买方身份关联已核实/);
});

test('同一服务商的同条记录跨产品出现时，列表计数不重复', () => {
  const html = renderLibrary('客户画像', [
    {
      ...lead,
      customsEvidence: [buyer, { ...buyer, product_family: 'components' }],
    },
  ]);
  assert.match(html, /海关记录 1 条/);
  assert.doesNotMatch(html, /海关记录 2 条/);
});

test('官网偏好证据使用可理解的中文名称', () => {
  const html = renderLibrary('官网证据', [
    {
      ...lead,
      facts: [
        { field: 'preference_evidence', value: 'motorized', quote: 'We offer motorized blinds.' },
      ],
    },
  ]);
  assert.match(html, /补充要求相关证据/);
  assert.doesNotMatch(html, /preference_evidence/);
});

test('海关记录直接列出产品及带原始单位的进口数量，不合计箱数与卷数', () => {
  const html = renderLibrary('海关记录', [
    {
      ...lead,
      customsEvidence: [
        {
          ...buyer,
          records: [
            { ...buyer.records[0], quantity: { value: 1455, unit: 'CTN' } },
            {
              ...buyer.records[0],
              id: 'shipment-2',
              bill_of_lading_number: 'BL-101',
              quantity: { value: 61, unit: 'ROL' },
            },
          ],
        },
      ],
    },
  ]);
  assert.match(html, /<th\b[^>]*>产品<\/th>/);
  assert.match(html, /<th\b[^>]*>进口数量<\/th>/);
  assert.match(html, /卷帘面料/);
  assert.match(html, /1,455 箱（CTN）/);
  assert.match(html, /61 卷（ROL）/);
  assert.doesNotMatch(html, /1,516|1516|1,455 件/);
});

test('数量与单位缺失保留未知，未知单位原样显示，重量不能替代进口数量', () => {
  const renderQuantity = (quantity) =>
    renderLibrary('海关记录', [
      {
        ...lead,
        customsEvidence: [
          {
            ...buyer,
            records: [{ ...buyer.records[0], quantity, weight: { value: 3500, unit: 'KG' } }],
          },
        ],
      },
    ]);
  const missingQuantity = renderQuantity(null);
  assert.match(missingQuantity, /<td\b[^>]*>未提供<\/td>/);
  assert.doesNotMatch(missingQuantity, /<td\b[^>]*>[^<]*(?:3,500|3500|0\s*箱)/);
  assert.match(renderQuantity({ value: 5, unit: null }), /5（单位未提供）/);
  assert.match(renderQuantity({ value: 12, unit: 'FOO' }), /12 FOO/);
});

test('同提单不同日期的来源记录逐条显示，数量不合计且详情默认折叠', () => {
  const record = {
    ...buyer.records[0],
    quantity: { value: 1455, unit: 'CTN' },
  };
  const html = renderLibrary('海关记录', [
    {
      ...lead,
      customsEvidence: [
        {
          ...buyer,
          records: [record, { ...record, id: 'shipment-2', date: '2026-09-25' }],
        },
      ],
    },
  ]);
  assert.match(html, /1,455 箱（CTN）/);
  assert.match(html, /记录日期/);
  assert.match(html, /2 条记录 · 1 个提单号/);
  assert.match(html, /同提单 · 数量不累加/);
  const table = html.match(/<table class="customs-product-table">([\s\S]*?)<\/table>/)?.[1];
  assert.ok(table, '实际海关表格存在');
  const rows = table.match(/<tbody>([\s\S]*?)<\/tbody>/)[1].match(/<tr>[\s\S]*?<\/tr>/g);
  assert.equal(rows.length, 2, '两条来源记录分别占一行');
  assert.match(rows[0], /2026-10-01/);
  assert.match(rows[1], /2026-09-25/);
  for (const row of rows) assert.match(row, /1,455 箱（CTN）/);
  assert.doesNotMatch(html, /2,910|2910/);
  assert.match(html, /BL-100/);
  assert.match(html, /shipment-1/);
  assert.match(html, /shipment-2/);
  const disclosures = [...html.matchAll(/<details\b[^>]*>/g)].map(([tag]) => tag);
  assert.ok(disclosures.length > 0, '原始资料有可展开的详情');
  assert.ok(
    disclosures.every((tag) => !/\sopen(?:=|[\s>])/.test(tag)),
    '详情默认关闭',
  );
});
