import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { createModuleLoader, loadModule } from './helpers/modules.mjs';

const { customerDevelopmentApi, CustomerDevelopmentError } = loadModule(
  new URL('../src/services/customerDevelopment.ts', import.meta.url),
);
const { MailConversationTimeline } = loadModule(
  new URL('../src/components/MailConversations.tsx', import.meta.url),
);
const fixture = (paused = true) => ({
  customerId: 'customer-1',
  sourceStatus: '未记录',
  doNotContact: false,
  fixedEmail: '',
  reviewToken: 'review-1',
  development: {
    version: 1,
    paused,
    reason: '客户要求稍后联系',
    notes: '下月再联系',
    reviewDate: '',
    pausedAt: '2026-10-27T02:00:00Z',
    updatedAt: '2026-10-27T02:00:00Z',
    resumeNotes: '',
    audit: [
      {
        action: 'pause',
        at: '2026-10-27T02:00:00Z',
        actor: '人工操作',
        reason: '客户要求稍后联系',
        notes: '下月再联系',
        reviewDate: '',
      },
    ],
  },
  messages: [
    {
      id: 'mail-1',
      direction: 'inbound',
      subject: 'Please contact us next month',
      occurredAt: '2026-10-27T01:00:00Z',
      deliveryStatus: 'received',
      body: 'We need more time before discussing the new collection.',
    },
  ],
  tasks: [{ id: 'task-1', title: '核对下一步', status: 'paused' }],
});
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join('')
    : React.isValidElement(node)
      ? text(node.props.children)
      : typeof node === 'string'
        ? node
        : '';
const elements = (node) =>
  Array.isArray(node)
    ? node.flatMap(elements)
    : React.isValidElement(node)
      ? [node, ...elements(node.props.children)]
      : [];
const settle = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

function control(t, snapshot = fixture(), api = {}) {
  const events = [];
  const priorWindow = globalThis.window;
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  t.after(() => {
    if (priorWindow === undefined) delete globalThis.window;
    else globalThis.window = priorWindow;
  });
  const states = [snapshot, false];
  const refs = [];
  let stateIndex, refIndex;
  const calls = [];
  const entry = new URL('../src/components/CustomerDevelopment.tsx', import.meta.url);
  const load = createModuleLoader((specifier, path) => {
    if (path.href !== entry.href) return;
    if (specifier === 'react')
      return {
        ...React,
        useCallback: (value) => value,
        useEffect() {},
        useState(initial) {
          const index = stateIndex++;
          if (!(index in states)) states[index] = initial;
          return [
            states[index],
            (value) => {
              states[index] = typeof value === 'function' ? value(states[index]) : value;
            },
          ];
        },
        useRef(initial) {
          const index = refIndex++;
          return (refs[index] ||= { current: initial });
        },
      };
    if (specifier === '../services/customerDevelopment')
      return {
        CustomerDevelopmentError,
        customerDevelopmentApi: {
          get: async () => snapshot,
          act: async (id, value) => {
            calls.push({ id, value });
            return {
              ...snapshot,
              development: {
                ...snapshot.development,
                paused: value.action !== 'resume',
                version: 2,
              },
            };
          },
          ...api,
        },
      };
  });
  const { CustomerDevelopmentControl } = load(entry);
  const render = () => {
    stateIndex = refIndex = 0;
    return CustomerDevelopmentControl({ customerId: 'customer-1' });
  };
  return {
    calls,
    events,
    html: () => renderToStaticMarkup(React.createElement(MemoryRouter, null, render())),
    button: (label) =>
      elements(render()).find((node) => node.type === 'button' && text(node).trim() === label),
    change(label, value) {
      const field = elements(render()).find(
        (node) => node.type === 'label' && text(node).startsWith(label),
      );
      const input = elements(field).find((node) =>
        ['select', 'textarea', 'input'].includes(node.type),
      );
      input.props.onChange({ target: { value, checked: value } });
    },
    submit: () =>
      elements(render())
        .find((node) => node.type === 'form')
        .props.onSubmit({ preventDefault() {} }),
  };
}

test('暂缓状态展示原因、人工历史和独立联系限制，回复仍可继续', (t) => {
  const data = fixture();
  data.sourceStatus = '暂缓开发';
  const html = control(t, data).html();
  assert.match(html, /客户要求稍后联系/);
  assert.match(html, /继续暂缓，未设置复查日期/);
  assert.match(html, /人工仍可回复；人工回复不会解除暂缓/);
  assert.match(html, /原有联系限制仍然有效/);
  assert.match(html, /暂缓开发 · 人工操作/);
  assert.doesNotMatch(html, /操作人姓名|登录账号/);
});

test('只有已明确关联客户的邮件会话提供开发控制，未关联会话引导客户库核对', () => {
  const render = (customerId) =>
    renderToStaticMarkup(
      React.createElement(
        MemoryRouter,
        null,
        React.createElement(MailConversationTimeline, {
          conversation: {
            account: 'sales@ours.example',
            participant: 'buyer@customer.example',
            subject: 'New blinds',
            customerId,
          },
          messages: [],
        }),
      ),
    );
  assert.match(render('customer-1'), /aria-label="邮件开发管理"/);
  const unlinked = render(null);
  assert.match(unlinked, /尚未明确关联客户/);
  assert.match(unlinked, /href="\/leads\?dataset=real"/);
  assert.doesNotMatch(unlinked, /aria-label="邮件开发管理"/);
});

test('恢复要求安排和重新核对，提交精确的版本与沟通快照', async (t) => {
  const ui = control(t);
  ui.button('恢复开发').props.onClick();
  await settle();
  assert.match(ui.html(), /Please contact us next month/);
  assert.match(ui.html(), /已收到/);
  assert.equal(ui.button('确认恢复开发').props.disabled, true);
  ui.change('下一步发送安排', '核对新来信与草稿，明天按原计划时段安排。');
  ui.change('已核对最新沟通及原草稿', true);
  assert.equal(ui.button('确认恢复开发').props.disabled, false);
  ui.submit();
  await settle();
  assert.deepEqual(ui.calls[0], {
    id: 'customer-1',
    value: {
      action: 'resume',
      expectedVersion: 1,
      resumeNotes: '核对新来信与草稿，明天按原计划时段安排。',
      reviewed: true,
      reviewToken: 'review-1',
    },
  });
  assert.equal(ui.events[0].type, 'customer-development-changed');
  assert.equal(ui.events[0].detail.customerId, 'customer-1');
});

test('恢复遇到沟通更新冲突会重新读取并取消勾选，保留安排文字', async (t) => {
  let reads = 0;
  const ui = control(t, fixture(), {
    get: async () => ({ ...fixture(), reviewToken: ++reads > 1 ? 'review-2' : 'review-1' }),
    act: async () => {
      throw new CustomerDevelopmentError('沟通已更新，请重新核对', 409);
    },
  });
  ui.button('恢复开发').props.onClick();
  await settle();
  ui.change('下一步发送安排', '下周再联系');
  ui.change('已核对最新沟通及原草稿', true);
  ui.submit();
  await settle();
  assert.match(ui.html(), /沟通已更新，请重新核对/);
  assert.match(ui.html(), /下周再联系/);
  assert.equal(ui.button('确认恢复开发').props.disabled, true);
  assert.equal(reads, 2);
});

test('暂缓表单必选原因，其他原因需说明，取消日期仍提交继续暂缓', async (t) => {
  const ui = control(t, fixture(false));
  ui.button('暂缓开发').props.onClick();
  ui.change('暂缓原因', '其他');
  assert.match(ui.html(), /原因说明<textarea required=""/);
  ui.change('原因说明', '销售团队正在核对重复联系');
  ui.submit();
  await settle();
  assert.equal(ui.calls[0].value.action, 'pause');
  assert.equal(ui.calls[0].value.notes, '销售团队正在核对重复联系');
  const reviewing = control(t);
  reviewing.button('修改复查日期').props.onClick();
  reviewing.button('继续暂缓，不设日期').props.onClick();
  reviewing.submit();
  await settle();
  assert.deepEqual(reviewing.calls[0].value, {
    action: 'review',
    expectedVersion: 1,
    reviewDate: '',
  });
});

test('开发控制请求编码客户编号、保存动作，并保留冲突状态', async (t) => {
  const priorFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return Response.json(fixture());
  };
  t.after(() => {
    globalThis.fetch = priorFetch;
  });
  await customerDevelopmentApi.get('customer/a b');
  await customerDevelopmentApi.act('customer-1', {
    action: 'pause',
    expectedVersion: 0,
    reason: '我方暂缓',
    reviewDate: '',
  });
  assert.match(requests[0].url, /customer%2Fa%20b\/development$/);
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(JSON.parse(requests[1].options.body).reason, '我方暂缓');
  globalThis.fetch = async () => Response.json({ error: '资料已更新' }, { status: 409 });
  await assert.rejects(
    customerDevelopmentApi.get('customer-1'),
    (error) => error.status === 409 && error.message === '资料已更新',
  );
});
