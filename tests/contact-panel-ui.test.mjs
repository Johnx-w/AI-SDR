import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadModule } from './helpers/modules.mjs';

const { ContactPanel } = loadModule(new URL('../src/components/ContactPanel.tsx', import.meta.url));
const lead = {
  id: 'rec-contact-presentation',
  name: 'Buyer Screens',
  contact: '采购部联系人',
  email: 'Sales@buyer.example.org\nsales@buyer.example.org\nsupport@buyer.example.org',
  phone: '+1 (972) 696-0181\n+1 9726960181\n0019726960181\n+1 9726960181 ext. 4',
  website: 'https://buyer.example.org/research-page',
  address: '12 Buyer Road',
  serviceAreas: 'Sydney Region',
  contactEvidence: [
    {
      kind: 'email',
      value: 'sales@buyer.example.org',
      quote: 'Email our company sales office.',
      source_url: 'https://evidence.example.org/contact',
    },
    {
      kind: 'email',
      value: 'sales@buyer.example.org',
      quote: 'Our sales mailbox is listed on the team page.',
      source_url: 'https://evidence.example.org/team',
    },
    {
      kind: 'email',
      value: 'sales@buyer.example.org',
      quote: 'Email our company sales office.',
      source_url: 'https://evidence.example.org/contact',
    },
    {
      kind: 'phone',
      value: '+1 9726960181',
      normalized: '+19726960181',
      quote: 'Telephone for the main office.',
      source_url: 'https://evidence.example.org/office',
    },
  ],
  social: [
    {
      platform: 'Facebook',
      url: 'https://www.facebook.com/Buyer',
      quote: 'The official Facebook page.',
      source_url: 'https://evidence.example.org/social',
    },
    {
      platform: 'Facebook',
      url: 'https://www.facebook.com/Buyer/',
      quote: 'The official Facebook page.',
      source_url: 'https://evidence.example.org/social',
    },
  ],
  locationEvidence: [
    {
      street: '12 Buyer Road',
      city: 'Sydney',
      region: 'NSW',
      quote: 'Visit our showroom at 12 Buyer Road.',
      source_url: 'https://evidence.example.org/showroom',
    },
    {
      street: '12 Buyer Road',
      city: 'Sydney',
      region: 'NSW',
      quote: 'Visit our showroom at 12 Buyer Road.',
      source_url: 'https://evidence.example.org/showroom',
    },
  ],
};
const render = (overrides = {}, editable = true) =>
  renderToStaticMarkup(
    React.createElement(ContactPanel, {
      lead: { ...lead, ...overrides },
      ...(editable ? { onSaved() {} } : {}),
    }),
  );
const initialView = (html) =>
  html.replace(/<details\b([^>]*)>([\s\S]*?)<\/details>/g, (all, attributes, content) =>
    /\bopen(?:=|\s|$)/.test(attributes)
      ? all
      : content.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)?.[0] || '',
  );
const hrefCount = (html, prefix) => (html.match(new RegExp('href="' + prefix, 'g')) || []).length;

test('展示联系与修改入口，重复联系方式合并，分机不同仍各自保留', () => {
  const html = initialView(render());
  assert.match(html, /修改联系方式/);
  assert.equal(hrefCount(html, 'mailto:'), 2);
  assert.equal(hrefCount(html, 'tel:'), 2);
  assert.match(html, /;ext=4/);
  assert.equal((html.match(/href="https:\/\/www\.facebook\.com\/Buyer\/?"/g) || []).length, 1);
});

test('来源证据默认收起，同一联系入口保留不同引文与出处且不重复完全相同的证据', () => {
  const html = render();
  const visible = initialView(html);
  assert.match(visible, /来源证据/);
  assert.doesNotMatch(
    visible,
    /Email our company|Our sales mailbox|Telephone for the main office|The official Facebook page|Visit our showroom|evidence\.example\.org/,
  );
  for (const quote of [
    'Email our company sales office.',
    'Our sales mailbox is listed on the team page.',
    'Telephone for the main office.',
    'The official Facebook page.',
    'Visit our showroom at 12 Buyer Road.',
  ])
    assert.ok(html.includes(quote), '完整原文仍保留：' + quote);
  assert.equal((html.match(/Email our company sales office\./g) || []).length, 1);
  assert.match(html, /href="https:\/\/evidence\.example\.org\/team"/);
  for (const [tag] of html.matchAll(/<details\b[^>]*>/g))
    assert.doesNotMatch(tag, /\sopen(?:=|[\s>])/);
});

test('已清空的邮箱电话保持空值，历史采集记录只在折叠证据中保留', () => {
  const html = render({ email: '', phone: '', social: [], locationEvidence: [] });
  const visible = initialView(html);
  assert.match(visible, /未记录邮箱/);
  assert.match(visible, /未记录电话/);
  assert.doesNotMatch(visible, /sales@buyer\.example\.org|9726960181/);
  assert.equal(hrefCount(html, 'mailto:'), 0);
  assert.equal(hrefCount(html, 'tel:'), 0);
  assert.match(html, /sales@buyer\.example\.org/);
  assert.match(html, /Telephone for the main office/);
});

test('无效邮箱电话和不安全来源作为文字保留，不生成危险链接或伪造网站出处', () => {
  const html = render({
    email: 'sales@buyer.example.org?bcc=other@example.org',
    phone: '+1 9726960181?foo=bar',
    social: [],
    locationEvidence: [],
    contactEvidence: [
      {
        kind: 'email',
        value: 'old@buyer.example.org',
        quote: 'Original source still retained.',
        source_url: 'javascript:alert(1)',
      },
      {
        kind: 'email',
        value: 'none@buyer.example.org',
        quote: 'Source link was not recorded.',
        source_url: '',
      },
    ],
  });
  assert.equal(hrefCount(html, 'mailto:'), 0);
  assert.equal(hrefCount(html, 'tel:'), 0);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.match(html, /javascript:alert\(1\)/);
  assert.match(html, /来源.*未记录|来源.*未保存/);
  assert.doesNotMatch(html, /href="https:\/\/buyer\.example\.org\/research-page"/);
});

test('只读或资料为空时仍展示邮箱电话空态，不生成修改权限或历史联系方式', () => {
  const html = render(
    {
      email: '',
      phone: '',
      contact: '',
      address: '',
      serviceAreas: '',
      social: [],
      locationEvidence: [],
      contactEvidence: [],
    },
    false,
  );
  assert.match(html, /未记录邮箱/);
  assert.match(html, /未记录电话/);
  assert.doesNotMatch(html, /修改联系方式|mailto:|tel:|已核实|已验证/);
});
