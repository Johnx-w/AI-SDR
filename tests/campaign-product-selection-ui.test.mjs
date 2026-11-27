import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createModuleLoader } from './helpers/modules.mjs';

const elements = (node) =>
  Array.isArray(node)
    ? node.flatMap(elements)
    : React.isValidElement(node)
      ? [node, ...elements(node.props.children)]
      : [];
const text = (node) =>
  Array.isArray(node)
    ? node.map(text).join('')
    : React.isValidElement(node)
      ? text(node.props.children)
      : typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : '';

test('计划只展示邮箱负责的产品，不再填写旧介绍文案', async (t) => {
  const page = new URL('../src/pages/OutreachCommunication.tsx', import.meta.url);
  const fact = {
    id: 'supply',
    kind: 'product',
    text: 'We supply shutters.',
    conditions: '',
    validUntil: null,
  };
  const products = [
    {
      id: 'facts-product',
      name: 'Shutters',
      status: 'approved',
      version: 3,
      category: 'ventilation',
      outreachFacts: [fact],
    },
    {
      id: 'curtains-product',
      name: 'Curtains',
      englishName: 'Curtains',
      status: 'approved',
      version: 2,
      category: 'indoor',
    },
    { id: 'other-brand', name: 'Other brand', status: 'approved', version: 1, category: 'indoor' },
  ];
  const states = {
    page: [
      {
        mailboxes: [
          {
            id: 'mailbox-one',
            email: 'sales@seller.example.org',
            productIds: ['facts-product', 'curtains-product'],
          },
        ],
        products,
        campaigns: [],
        counts: { total: 0, active: 0 },
        deliveries: [],
        readiness: {},
      },
    ],
    editor: [],
  };
  let context = 'page',
    stateIndex;
  const load = createModuleLoader((specifier, path) => {
    if (path.href !== page.href) return;
    if (specifier === 'react')
      return {
        ...React,
        useEffect() {},
        useCallback: (fn) => fn,
        useRef: (value) => ({ current: value }),
        useState(initial) {
          const values = states[context],
            index = stateIndex++;
          if (!(index in values))
            values[index] = typeof initial === 'function' ? initial() : initial;
          return [
            values[index],
            (next) => {
              values[index] = typeof next === 'function' ? next(values[index]) : next;
            },
          ];
        },
      };
    if (specifier === 'react-router-dom')
      return { useSearchParams: () => [new URLSearchParams({ tab: 'campaigns' }), () => {}] };
  });
  const { OutreachCommunication } = load(page);
  const renderPage = () => {
    context = 'page';
    stateIndex = 0;
    return OutreachCommunication();
  };
  elements(renderPage())
    .find((node) => node.type === 'button' && text(node).trim() === '新建计划')
    .props.onClick();
  const editor = elements(renderPage()).find(
    (node) => typeof node.type === 'function' && node.type.name === 'CampaignEditor',
  );
  assert.ok(editor);
  let saved;
  const render = (campaign = null) => {
    context = 'editor';
    stateIndex = 0;
    return editor.type({
      ...editor.props,
      campaign,
      onSave: async (value) => {
        saved = value;
      },
      onClose() {},
    });
  };
  assert.match(text(render(null)), /自动发送/);
  assert.equal(elements(render(null)).filter((node) => node.type === 'textarea').length, 0);
  states.editor = [];
  assert.deepEqual(
    elements(render())
      .filter(
        (node) =>
          node.type === 'button' &&
          /^(透气窗|百叶窗|室内窗饰|户外遮阳|其他|未分类)（/.test(text(node)),
      )
      .map(text),
    ['透气窗（1）', '室内窗饰（1）'],
  );
  const picker = elements(render()).find((node) =>
    node.props.emptyText?.startsWith('所选邮箱与品类范围内'),
  );
  assert.deepEqual(
    picker.props.products.map((product) => product.id),
    ['facts-product', 'curtains-product'],
  );
  const values = {
    name: 'New outreach',
    targetCount: '5',
    intervalSeconds: '30',
    markets: '',
    includeExisting: 'on',
    continuous: 'on',
  };
  t.mock.method(globalThis, 'FormData', function () {
    this.get = (key) => values[key];
  });
  elements(render())
    .find((node) => node.type === 'form')
    .props.onSubmit({ preventDefault() {}, currentTarget: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(saved, undefined);
  assert.match(
    elements(render()).find((node) => node.type?.name === 'InlineError').props.value,
    /至少选择一个供货产品/,
  );
  picker.props.onChange(['facts-product', 'curtains-product']);
  elements(render())
    .find((node) => node.type === 'form')
    .props.onSubmit({ preventDefault() {}, currentTarget: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved.filters.products, ['facts-product', 'curtains-product']);
  assert.equal(saved.outreachClaims, undefined);
  assert.deepEqual(saved.mailboxIds, ['mailbox-one']);
  const mailboxCheckbox = elements(render()).find(
    (node) => node.type === 'input' && node.props.checked === true && !node.props.name,
  );
  mailboxCheckbox.props.onChange({ target: { checked: false } });
  assert.match(text(render()), /Shutters：超出所选邮箱负责范围/);
  assert.match(text(render()), /Curtains：超出所选邮箱负责范围/);
  mailboxCheckbox.props.onChange({ target: { checked: true } });
  const groupButton = elements(render()).find(
    (node) => node.type === 'button' && text(node).startsWith('室内窗饰'),
  );
  groupButton.props.onClick();
  const grouped = elements(render()).find((node) =>
    node.props.emptyText?.startsWith('所选邮箱与品类范围内'),
  );
  assert.deepEqual(grouped.props.selected, ['facts-product', 'curtains-product']);
  assert.deepEqual(
    grouped.props.products.map((p) => p.id),
    ['curtains-product'],
  );

  states.editor = [];
  assert.equal(elements(render(saved)).filter((node) => node.type === 'textarea').length, 0);
});
