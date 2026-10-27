import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule } from './helpers/modules.mjs';

const { WebsiteEvidencePanel } = loadModule(
  new URL('../src/components/WebsiteEvidencePanel.tsx', import.meta.url),
);
const render = (facts, identityEvidence = []) =>
  renderToStaticMarkup(React.createElement(WebsiteEvidencePanel, { facts, identityEvidence }));
const initialView = (html) =>
  html.replace(/<details\b([^>]*)>([\s\S]*?)<\/details>/g, (all, attributes, content) =>
    /\bopen(?:=|\s|$)/.test(attributes)
      ? all
      : content.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0] || '',
  );
const items = (html) =>
  [
    ...html.matchAll(
      /<details\b[^>]*class="[^"]*\bwebsite-evidence-item\b[^"]*"[^>]*>[\s\S]*?<\/details>/g,
    ),
  ].map(([item]) => item);

test('同一企业名称的重复事实只显示一项摘要，所有不同原文和出处仍可展开核对', () => {
  const original = {
    field: 'company_name',
    value: 'Acme Screens',
    quote: 'Acme Screens is a window furnishing business.',
    source_url: 'https://buyer.example.org/',
  };
  const identity = {
    ...original,
    quote: 'Acme Screens, serving local businesses.',
    source_url: 'https://buyer.example.org/about',
  };
  const html = render([original, { ...original }], [identity]);
  const visible = initialView(html);
  assert.equal(items(html).length, 1);
  assert.equal((visible.match(/Acme Screens/g) || []).length, 1);
  assert.match(html, /Acme Screens is a window furnishing business\./);
  assert.match(html, /Acme Screens, serving local businesses\./);
  assert.match(html, /href="https:\/\/buyer\.example\.org\/"/);
  assert.match(html, /href="https:\/\/buyer\.example\.org\/about"/);
  assert.doesNotMatch(visible, /window furnishing business|serving local businesses|https:\/\//);
});

test('客户类型别名合并为一项中文事实，完整记录不会重复渲染相同引文', () => {
  const original = {
    field: 'customer_type',
    value: 'retailer',
    quote: 'We are a specialist window furnishing retailer.',
    source_url: 'https://buyer.example.org/about',
  };
  const html = render([original, { ...original, field: 'customer_types' }]);
  assert.equal(items(html).length, 1);
  assert.match(initialView(html), /零售/);
  assert.doesNotMatch(initialView(html), /retailer|customer_type/);
  assert.equal((html.match(/We are a specialist window furnishing retailer\./g) || []).length, 1);
});

test('默认只读简短中文摘要，原始值、引文和来源均保存在关闭的详情内', () => {
  const html = render([
    {
      field: 'entity_type',
      value: 'business',
      quote: 'We are a private company.',
      source_url: 'https://buyer.example.org/legal',
    },
    {
      field: 'production_model',
      value: 'own_factory',
      quote: 'We operate our own factory.',
      source_url: 'https://buyer.example.org/factory',
    },
    {
      field: 'actual_country',
      value: 'Australia',
      quote: 'Sydney, Australia.',
      source_url: 'https://buyer.example.org/contact',
    },
  ]);
  const visible = initialView(html);
  assert.match(visible, /企业/);
  assert.match(visible, /工厂/);
  assert.match(visible, /澳大利亚/);
  assert.doesNotMatch(
    visible,
    /own_factory|business|Australia|https:\/\/|We operate our own factory/,
  );
  assert.match(html, /We operate our own factory\./);
  assert.match(html, /href="https:\/\/buyer\.example\.org\/factory"/);
  assert.ok(items(html).length > 0);
  for (const item of items(html))
    assert.doesNotMatch(item.match(/^<details\b[^>]*>/)[0], /\sopen(?:=|[\s>])/);
});

test('互相冲突的生产模式不合并或覆盖，共用引文的不同事实也分开保留', () => {
  const shared = {
    quote: 'Source text requires further review.',
    source_url: 'https://buyer.example.org/about',
  };
  const html = render([
    { ...shared, field: 'production_model', value: 'own_factory' },
    { ...shared, field: 'production_model', value: 'no_own_factory' },
    { ...shared, field: 'customer_type', value: 'retailer' },
    { ...shared, field: 'audience', value: 'BC' },
  ]);
  assert.equal(items(html).length, 4);
  assert.match(initialView(html), /自有工厂/);
  assert.match(initialView(html), /无|没有|未设|未自建/);
  assert.match(initialView(html), /零售/);
  assert.match(initialView(html), /企业|个人|住宅/);
});

test('未知英文描述使用中性中文摘要，完整内容仍可展开且不被当作采购意向', () => {
  const narrative =
    'The satellite showroom now uses an unusual appointment process and does not disclose purchasing plans.';
  const html = render([
    {
      field: 'unrecognized_research_field',
      value: narrative,
      quote: 'Literal source paragraph.',
      source_url: 'https://buyer.example.org/process',
    },
  ]);
  const visible = initialView(html);
  assert.match(visible, /[\u3400-\u9fff]/);
  assert.doesNotMatch(
    visible,
    /satellite showroom|unrecognized_research_field|已确认采购|明确采购需求/,
  );
  assert.match(html, /The satellite showroom now uses an unusual appointment process/);
  assert.match(html, /Literal source paragraph\./);
});

test('安全来源可打开，危险地址仅作文字保留，缺少来源不会伪造官网出处', () => {
  const html = render([
    {
      field: 'company_name',
      value: 'Acme One',
      quote: 'Public company name.',
      source_url: 'https://buyer.example.org/about',
    },
    {
      field: 'company_name',
      value: 'Acme Two',
      quote: 'Unsafe source still preserved.',
      source_url: 'javascript:alert(1)',
    },
    { field: 'company_name', value: 'Acme Three', quote: 'No source was saved.' },
  ]);
  assert.match(html, /href="https:\/\/buyer\.example\.org\/about"/);
  assert.match(html, /javascript:alert\(1\)/);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /来源.*未记录|未保存.*来源|来源.*未保存/);
  assert.equal((html.match(/href=/g) || []).length, 1);
  assert.doesNotMatch(initialView(html), /https:\/\/|javascript:alert/);
});

test('没有证据时展示空状态，不生成无来源事实', () => {
  const html = render([]);
  assert.match(html, /尚无官网证据/);
  assert.equal(items(html).length, 0);
  assert.doesNotMatch(html, /href=|已确认|无自有工厂/);
});

test('同类产品集中成简短摘要，全部不同产品和各自出处仍保留在折叠内容中', () => {
  const names = [
    'Roller Blinds',
    'Outdoor Awnings',
    'Plantation Shutters',
    'Security Screen Doors',
  ];
  const facts = names.map((value, index) => ({
    field: 'products',
    value,
    quote: 'Original product evidence ' + index,
    source_url: 'https://buyer.example.org/product-' + index,
  }));
  const html = render(facts);
  assert.equal(items(html).length, 1);
  assert.match(initialView(html), /经营产品/);
  assert.match(initialView(html), /卷帘/);
  assert.match(initialView(html), /等 4 项/);
  assert.doesNotMatch(initialView(html), /Original product evidence|https:\/\//);
  for (let index = 0; index < facts.length; index++) {
    assert.match(html, new RegExp('Original product evidence ' + index));
    assert.match(html, new RegExp('href="https://buyer\\.example\\.org/product-' + index + '"'));
  }
});
