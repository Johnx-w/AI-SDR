import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { summarizeLead } from '../server/lead-library.mjs';
import { createModuleLoader } from './helpers/modules.mjs';

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
};

// Render the real library and its real TSX children with deterministic loaded
// data; replace only browser routing, initial state and the workspace context.
function renderLibrary(tab = '客户画像', customers = [lead], options = {}) {
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
  let stateIndex = 0;
  const load = createModuleLoader((specifier, path) => {
    const key = path.href;
    if (key === entry.href) {
      if (specifier === 'react')
        return {
          ...React,
          useEffect: () => {},
          useState: (initial) => {
            const index = stateIndex++;
            return [
              index === 3 && options.detailError !== undefined
                ? options.detailError
                : index === 8 && options.market !== undefined
                  ? options.market
                  : index === 9 && options.grade !== undefined
                    ? options.grade
                    : initial === '客户画像'
                      ? tab
                      : initial,
              () => {},
            ];
          },
        };
      if (specifier === 'react-router-dom')
        return {
          useSearchParams: () => [new URLSearchParams({ lead: 'lead-1' }), () => {}],
        };
      if (specifier === '../app/WorkspaceProvider')
        return { useWorkspace: () => ({ notify() {} }) };
      if (specifier === '../services/csv') return { exportCsv() {} };
      if (specifier === '../services/leadLibrary')
        return {
          leadLibrary: {
            cachedList: () => snapshot,
            cachedDetail: (id) =>
              options.pending ? null : customers.find((item) => item.id === id),
          },
        };
    }
  });
  return renderToStaticMarkup(React.createElement(load(entry).LeadLibrary));
}

test('客户库筛选展示中文市场和 A/B/C 评级，保留完整开发状态', () => {
  const html = renderLibrary('客户画像', [
    { ...lead, market: 'Canada', grade: 'C', status: '待开发' },
    { ...lead, id: 'other', grade: 'A', status: '人工跟进中' },
  ]);
  assert.match(html, /<option value="加拿大">加拿大<\/option>/);
  assert.doesNotMatch(html, /<option[^>]*>Canada<\/option>/);
  const marketOptions = html.match(/<select aria-label="市场筛选"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.equal((marketOptions.match(/<option value="待核实">待核实<\/option>/g) || []).length, 1);
  assert.match(
    html,
    /<option value="A">A<\/option><option value="B">B<\/option><option value="C">C<\/option>/,
  );
  assert.doesNotMatch(html, /C（旧版）|独立待核实评级/);
  for (const status of [
    '待开发',
    '已联系',
    '已回复',
    '跟进中',
    '已成交',
    '停止开发',
    '停止开发',
    '人工跟进中',
  ])
    assert.ok(html.includes(`<option value="${status}">${status}</option>`));
  assert.doesNotMatch(html, /<option value="未记录">/);
  const productOptions = html.match(/<select aria-label="产品筛选"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(productOptions);
  assert.deepEqual(
    [...productOptions.matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((match) => match[1]),
    [
      '全部产品',
      'Plantation Shutters（透气窗）',
      'Venetian Blinds（百叶窗）',
      'Outdoor Shading（户外遮阳）',
      'Indoor Window Coverings（室内成品帘）',
      'Fabrics &amp; Components（面料与配件）',
    ],
  );
  assert.match(html, /清空筛选/);
});

test('待核实市场筛选包含国家空值及未知标记，排除已知国家且选项不重复', () => {
  const customers = [
    { ...lead, id: 'known', name: 'Known Country', market: 'Canada' },
    { ...lead, id: 'empty', name: 'Empty Country', market: '' },
    { ...lead, id: 'blank', name: 'Blank Country', market: '  ' },
    { ...lead, id: 'unknown', name: 'Unknown Country', market: 'unknown' },
    { ...lead, id: 'unrecorded', name: 'Unrecorded Country', market: '未记录' },
  ];
  const originalMarkets = customers.map((customer) => customer.market);
  const html = renderLibrary('客户画像', customers, { market: '待核实', pending: true });
  const table = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/)?.[1];
  assert.ok(table);
  assert.doesNotMatch(table, /Known Country/);
  for (const name of ['Empty Country', 'Blank Country', 'Unknown Country', 'Unrecorded Country'])
    assert.ok(table.includes(name), name);
  const marketOptions = html.match(/<select aria-label="市场筛选"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.equal((marketOptions.match(/<option value="待核实"/g) || []).length, 1);
  assert.match(marketOptions, /<option value="待核实" selected="">待核实<\/option>/);
  assert.doesNotMatch(marketOptions, /value="unknown"|value="未记录"/);
  assert.deepEqual(
    customers.map((customer) => customer.market),
    originalMarkets,
  );
  const knownHtml = renderLibrary('客户画像', customers, { market: '加拿大', pending: true });
  assert.match(knownHtml, /Known Country/);
  assert.doesNotMatch(knownHtml, /Empty Country|Blank Country|Unknown Country|Unrecorded Country/);
});

test('客户列表为空时全部市场下仍提供待核实选项', () => {
  const html = renderLibrary('客户画像', [], { pending: true });
  const marketOptions = html.match(/<select aria-label="市场筛选"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.equal(
    marketOptions,
    '<option value="" selected="">全部市场</option><option value="待核实">待核实</option>',
  );
});

test('客户在分页前按首次录入时间倒序，评级和研究更新不置顶', () => {
  const customers = [
    { ...lead, id: 'unknown-1', name: 'Unknown First', createdAt: null, updatedAt: 9999999999999 },
    ...Array.from({ length: 8 }, (_, index) => ({
      ...lead,
      id: `old-${index}`,
      name: `Old Customer ${index}`,
      grade: 'A',
      createdAt: 1000,
    })),
    { ...lead, id: 'unknown-2', name: 'Unknown Second' },
    { ...lead, id: 'new', name: 'Newest Customer', grade: 'C', createdAt: 2000 },
  ];
  const originalOrder = customers.map((customer) => customer.id);
  const html = renderLibrary('客户画像', customers, { pending: true });
  const table = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/)?.[1];
  assert.ok(table);
  assert.ok(table.indexOf('Newest Customer') < table.indexOf('Old Customer 0'));
  assert.ok(table.indexOf('Old Customer 0') < table.indexOf('Old Customer 1'));
  assert.doesNotMatch(table, /Old Customer 7|Unknown First|Unknown Second/);
  assert.deepEqual(
    customers.map((customer) => customer.id),
    originalOrder,
  );
  const smallTable = renderLibrary('客户画像', [customers[0], customers[10], customers[9]], {
    pending: true,
  });
  assert.ok(smallTable.indexOf('Newest Customer') < smallTable.indexOf('Unknown First'));
  assert.ok(smallTable.indexOf('Unknown First') < smallTable.indexOf('Unknown Second'));
  assert.match(html, /<span>共 11 条线索<\/span>/);
  assert.doesNotMatch(html, /A 级先显示/);
});

test('不同评级客户按入库时间排序，评级筛选仍可用', () => {
  const customers = [
    { ...lead, id: 'low', name: 'Low Lead', grade: 'C', score: 70, createdAt: 3000 },
    { ...lead, id: 'regular', name: 'Regular Lead', grade: 'B', score: 70, createdAt: 2000 },
    { ...lead, id: 'high', name: 'High Lead', grade: 'A', score: 70, createdAt: 1000 },
  ];
  const original = customers.map((item) => item.id);
  const html = renderLibrary('客户画像', customers, { pending: true });
  const table = html.match(/<table\b[^>]*>([\s\S]*?)<\/table>/)?.[1];
  assert.ok(table);
  assert.ok(table.indexOf('Low Lead') < table.indexOf('Regular Lead'));
  assert.ok(table.indexOf('Regular Lead') < table.indexOf('High Lead'));
  assert.doesNotMatch(table, /旧版|旧规则70分/);
  assert.deepEqual(
    customers.map((item) => item.id),
    original,
  );
  const highOnly = renderLibrary('客户画像', customers, { pending: true, grade: 'A' });
  assert.match(highOnly, /High Lead/);
  assert.doesNotMatch(highOnly, /Regular Lead|Low Lead/);
});

test('后台同步保留精简列表，档案尚未加载时显示独立加载状态', () => {
  const html = renderLibrary('客户画像', [lead], {
    pending: true,
    snapshot: {
      sync: { refreshing: true, stale: true, error: '', revision: 1 },
    },
  });
  assert.match(html, /Acme Screens/);
  assert.match(html, /<table\b[^>]*>[\s\S]*Acme Screens[\s\S]*?<\/table>/);
  assert.match(html, /正在后台同步/);
  assert.match(html, /正在读取客户档案/);
});

test('同步失败时保留客户列表，并展示最近同步时间与错误', () => {
  const html = renderLibrary('客户画像', [lead], {
    snapshot: {
      sync: { refreshing: false, stale: true, error: '飞书暂时不可用', revision: 1 },
    },
  });
  assert.match(html, /<table\b[^>]*>[\s\S]*Acme Screens[\s\S]*?<\/table>/);
  assert.match(html, /最近同步/);
  assert.match(html, /保留已有客户：飞书暂时不可用/);
});

test('档案更新失败时保留已加载资料，并只显示一次重试提醒', () => {
  const html = renderLibrary('客户画像', [lead], { detailError: '网络中断' });
  assert.match(html, /Acme Screens/);
  assert.equal((html.match(/档案更新未完成/g) || []).length, 1);
  assert.equal((html.match(/重新读取档案/g) || []).length, 1);
  assert.match(html, /档案更新未完成，正在显示已加载资料：网络中断/);
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
