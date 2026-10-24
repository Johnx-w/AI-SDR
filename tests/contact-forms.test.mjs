import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractContacts } from '../server/contact-extractor.mjs';
import { combineWebsiteEvidence } from '../server/website-metadata.mjs';

const sourceUrl = 'https://buyer.example.org/contact';
const form = (
  attrs = 'action="/send-enquiry" method="post"',
  button = 'Send enquiry',
  extra = '',
) =>
  `<form ${attrs}><label>Email<input type="email" name="contact[email]" required></label><label>Message<textarea name="message"></textarea></label>${extra}<button type="submit">${button}</button></form>`;

test('真实业务form保留官网来源、提交地址与可逐字核对的完整HTML证据', () => {
  const html = form();
  const [contact] = extractContacts({ content: html, sourceUrl });
  assert.equal(contact.kind, 'form');
  assert.equal(contact.source_url, sourceUrl);
  assert.equal(contact.value, sourceUrl);
  assert.equal(contact.action_url, 'https://buyer.example.org/send-enquiry');
  assert.equal(contact.quote, html);
  assert.equal(contact.method, 'business_contact_form');
  assert.equal(contact.status, '公开未验证');
});

test('官网明确采用HTTPS第三方表单处理服务时保留源页入口', () => {
  const [contact] = extractContacts({
    content: form('action="https://forms.example.net/inquiry" method="post"'),
    sourceUrl,
  });
  assert.equal(contact.kind, 'form');
  assert.equal(contact.value, sourceUrl);
  assert.equal(contact.action_url, 'https://forms.example.net/inquiry');
});

test('HTML默认当前页提交和input submit可以核实，但文字Contact链接本身不是表单', () => {
  const html = form('method="post"').replace(
    '<button type="submit">Send enquiry</button>',
    '<input type="submit" value="Send enquiry">',
  );
  assert.equal(extractContacts({ content: html, sourceUrl })[0].action_url, sourceUrl);
  assert.equal(
    extractContacts({ content: '<a href="/contact">Contact us</a>', sourceUrl }).length,
    0,
  );
});

test('不把订阅登录下载评论和搜索表单当作业务联系入口', () => {
  for (const html of [
    form('action="/newsletter/subscribe" method="post"', 'Subscribe'),
    form('action="/login" method="post"', 'Sign in'),
    form('action="/download/catalog" method="post"', 'Download catalog'),
    form('action="/search" method="get"', 'Search'),
    form('action="/comments" method="post"', 'Post comment'),
    form('action="/contact" method="post"', 'Send', '<input type="password" name="password">'),
    '<form action="/contact" method="post"><input type="email"><button>Send</button></form>',
    '<form action="/contact" method="post"><textarea name="message"></textarea><button>Send</button></form>',
  ])
    assert.equal(
      extractContacts({ content: html, sourceUrl }).some((row) => row.kind === 'form'),
      false,
      html,
    );
});

test('可选营销勾选不让真实询盘表单被newsletter关键词误杀', () => {
  assert.equal(
    extractContacts({
      content: form(
        undefined,
        'Send enquiry',
        '<label><input type="checkbox" name="newsletter">Subscribe to newsletter</label>',
      ),
      sourceUrl,
    })[0].kind,
    'form',
  );
});

test('拒绝危险提交地址和脚本模板中的伪form，不推测JS点击处理器', () => {
  for (const html of [
    form('action="javascript:alert(1)" method="post"'),
    form('action="http://buyer.example.org/contact" method="post"'),
    form('action="https://127.0.0.1/contact" method="post"'),
    `<script>const markup = '${form()}';</script>`,
    `<template>${form()}</template>`,
    form().replace('type="submit"', 'type="button"'),
  ])
    assert.equal(
      extractContacts({ content: html, sourceUrl }).some((row) => row.kind === 'form'),
      false,
      html,
    );
});

test('官网综合证据保留form而邮箱电话字段提取仍分别处理', () => {
  const evidence = combineWebsiteEvidence([{ url: sourceUrl, content: form() }]);
  assert.equal(evidence.contacts[0].kind, 'form');
  assert.equal(evidence.contacts[0].quote, form());
});
