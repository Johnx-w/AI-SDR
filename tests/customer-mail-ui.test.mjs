import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createModuleLoader, loadModule } from './helpers/modules.mjs';

const render = (element) => renderToStaticMarkup(React.createElement(MemoryRouter, null, element));
const { CustomerBusinessSummary } = loadModule(
  new URL('../src/components/CustomerBusinessSummary.tsx', import.meta.url),
);

test('时间线直接展示沟通记录并移除重复入口', () => {
  const html = render(React.createElement(CustomerBusinessSummary, { customerId: 'buyer' }));
  assert.match(html, /沟通与任务时间线/);
  assert.doesNotMatch(html, />客户邮件<|>自动跟进任务</);
});

function inbox(list, { error = '', loading = false } = {}) {
  const entry = new URL('../src/components/SalesInbox.tsx', import.meta.url);
  const states = ['', list, loading, error];
  const effects = [];
  const requests = [];
  let index = 0;
  const load = createModuleLoader((specifier, path) => {
    if (path.href !== entry.href) return;
    if (specifier === 'react')
      return {
        ...React,
        useState(initial) {
          const slot = index++;
          if (!(slot in states)) states[slot] = initial;
          return [states[slot], (next) => (states[slot] = next)];
        },
        useEffect(effect) {
          effects.push(effect);
        },
        useRef: (current) => ({ current }),
        useCallback: (callback) => callback,
      };
    if (specifier === '../services/mailConversations')
      return {
        mailConversationsApi: {
          async list(filters) {
            requests.push(filters);
            return list;
          },
        },
      };
  });
  const { SalesInbox } = load(entry);
  return {
    html: render(
      SalesInbox({
        mailboxes: [],
        customerId: 'buyer',
        inboundOnly: true,
        onMailboxChange() {},
      }),
    ),
    states,
    effects,
    requests,
  };
}

test('客户没有来信时明确提示空状态，读取失败和加载中不冒充没有来信', () => {
  const empty = { items: [], mailboxes: [], total: 0, page: 1, pageSize: 25 };
  assert.match(inbox(empty).html, /暂无该客户的来信/);
  assert.match(inbox(empty).html, /当前已同步的邮箱记录中没有该客户的来信/);
  assert.match(inbox(empty).html, /href="\/inbox\?tab=inbox"/);
  const failed = inbox(null, { error: '服务暂时不可用' }).html;
  assert.match(failed, /会话读取失败|服务暂时不可用/);
  assert.doesNotMatch(failed, /暂无该客户的来信/);
  const loading = inbox(null, { loading: true }).html;
  assert.match(loading, /正在读取邮件会话/);
  assert.doesNotMatch(loading, /暂无该客户的来信/);
});

test('点击客户邮件后的列表请求带来信筛选，并默认选中最新会话', async () => {
  const value = {
    items: [{ id: 'latest-incoming' }],
    mailboxes: [],
    total: 1,
    page: 1,
    pageSize: 25,
  };
  const view = inbox(value, { loading: true });
  const previousWindow = globalThis.window;
  const timers = [];
  globalThis.window = { setTimeout: (run) => timers.push(run), clearTimeout() {} };
  let cleanup;
  try {
    cleanup = view.effects[1]();
    timers[0]();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(view.requests, [
      {
        mailboxId: 'all',
        customerId: 'buyer',
        q: '',
        unread: false,
        inboundOnly: true,
        page: 1,
        pageSize: 25,
        hasReply: false,
        folder: undefined,
      },
    ]);
    assert.equal(view.states[4], 'latest-incoming');
  } finally {
    cleanup?.();
    globalThis.window = previousWindow;
  }
});
