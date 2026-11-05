import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { loadModule } from './helpers/modules.mjs';
import { businessWorkspace } from './fixtures/business-conversations.mjs';
import { updateBusinessNavigation } from '../src/domain/business-navigation.mjs';

const { buildConversationRows, BusinessConversations, BusinessMessageBody } = loadModule(
  new URL('../src/components/BusinessConversations.tsx', import.meta.url),
);
const { splitMailQuote } = loadModule(new URL('../src/services/mailHtml.ts', import.meta.url));

test('conversation rows group independent threads, sort real message times and preserve stored order', () => {
  const before = structuredClone(businessWorkspace);
  const rows = buildConversationRows(businessWorkspace, '', 'all');
  assert.deepEqual(
    rows.map((row) => row.conversation.id),
    ['samples', 'harbor', 'empty'],
  );
  assert.deepEqual(
    rows[0].messages.map((message) => message.id),
    ['first', 'sent', 'latest'],
  );
  assert.match(rows[0].preview, /Thank you/);
  assert.equal(rows[2].customer, rows[0].customer);
  assert.deepEqual(businessWorkspace, before);
});

test('message search filters conversations and supplies a matching excerpt without dropping surrounding history', () => {
  const rows = buildConversationRows(businessWorkspace, '  BLACKOUT  ', 'all');
  assert.deepEqual(
    rows.map((row) => row.conversation.id),
    ['samples'],
  );
  assert.deepEqual(
    rows[0].matches.map((message) => message.id),
    ['first'],
  );
  assert.match(rows[0].preview, /blackout/);
  assert.equal(rows[0].messages.length, 3);
  assert.deepEqual(buildConversationRows(businessWorkspace, 'blackout', 'outbound'), []);
  assert.equal(buildConversationRows(businessWorkspace, '张敏', 'all').length, 3);
  assert.deepEqual(
    buildConversationRows(businessWorkspace, 'Outdoor awning', 'all').map(
      (row) => row.conversation.id,
    ),
    ['empty'],
  );
  assert.equal(buildConversationRows(businessWorkspace, '', 'outbound').length, 1);
});

test('conversation browser renders only the selected timeline, match navigation and an explicit edit action', () => {
  const rows = buildConversationRows(businessWorkspace, 'samples', 'all');
  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(BusinessConversations, {
        rows,
        selected: rows[0],
        query: 'samples',
        direction: 'all',
        focusedId: 'first',
        saving: false,
        channelLabel: () => '邮件',
        onSelect() {},
        onEdit() {},
        renderMessage: (message, body) => React.createElement('div', null, message.subject, body),
      }),
    ),
  );
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /编辑会话/);
  assert.match(html, /上一条匹配消息/);
  assert.match(html, /id="business-record-first"/);
  assert.doesNotMatch(html, /id="business-record-harbor-first"/);
  assert.ok(html.indexOf('business-record-first') < html.indexOf('business-record-latest'));
});

test('long bodies and known quoted tails remain available without changing the original text', () => {
  const value = 'Current reply\n\nOn Tue, Emma wrote:\n> Previous message';
  const split = splitMailQuote(value);
  assert.equal(split.body + split.quote, value);
  assert.match(split.quote, /Previous message/);
  assert.equal(splitMailQuote('> A question\nMy inline answer').quote, '');
  const message = businessWorkspace.messages.find((item) => item.id === 'sent');
  const render = (reveal) =>
    renderToStaticMarkup(React.createElement(BusinessMessageBody, { message, reveal }));
  assert.match(render(false), /<details class="business-long-message">/);
  assert.match(render(true), /<details class="business-long-message" open="">/);
  const quoted = renderToStaticMarkup(
    React.createElement(BusinessMessageBody, {
      message: { ...message, body: value },
      reveal: false,
    }),
  );
  assert.match(quoted, /展开历史引用/);
});

test('search and customer changes clear stale conversation targets while direction preserves the selected conversation', () => {
  const initial = new URLSearchParams('tab=messages&conversation=samples&message=first');
  for (const key of ['q', 'customerId', 'productId', 'tab']) {
    const changed = updateBusinessNavigation(initial, key, key === 'tab' ? 'tasks' : 'new');
    assert.equal(changed.has('conversation'), false);
    assert.equal(changed.has('message'), false);
  }
  assert.equal(
    updateBusinessNavigation(initial, 'state', 'inbound').get('conversation'),
    'samples',
  );
});
