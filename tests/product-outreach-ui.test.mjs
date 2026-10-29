import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createModuleLoader } from './helpers/modules.mjs';

const entry = new URL('../src/pages/ProductKnowledge.tsx', import.meta.url);
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
const fixture = (outreachFacts) => ({
  id: 'product-one',
  name: 'PVC shutters',
  englishName: 'PVC shutters',
  category: 'ventilation',
  direction: 'finished',
  status: 'approved',
  version: 2,
  aliases: [],
  brands: [],
  markets: [],
  deliveryForms: [],
  attachments: [],
  specifications: '',
  moq: '',
  leadTime: '',
  sourceUrl: 'https://seller.example.org',
  effectiveDate: '2026-10-27',
  approvedBy: 'Seller',
  notes: '',
  updatedAt: '2026-10-27T00:00:00Z',
  outreachFacts,
});

function setup(t, product) {
  const states = [[product], false];
  let stateIndex;
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    writes.push(body);
    return { ok: true, json: async () => ({ product: { ...body, id: product.id, version: 3 } }) };
  });
  const load = createModuleLoader((specifier, path) => {
    if (path.href !== entry.href) return;
    if (specifier === 'react')
      return {
        ...React,
        useEffect() {},
        useMemo: (fn) => fn(),
        useCallback: (fn) => fn,
        useState(initial) {
          const index = stateIndex++;
          if (!(index in states))
            states[index] = typeof initial === 'function' ? initial() : initial;
          return [
            states[index],
            (next) => {
              states[index] = typeof next === 'function' ? next(states[index]) : next;
            },
          ];
        },
      };
    if (specifier === 'react-router-dom')
      return { useSearchParams: () => [new URLSearchParams(), () => {}] };
  });
  const { ProductKnowledgePage } = load(entry);
  const render = () => {
    stateIndex = 0;
    return ProductKnowledgePage();
  };
  const button = (label) =>
    elements(render()).find((node) => node.type === 'button' && text(node).trim() === label);
  const field = (label) => {
    const node = elements(render()).find(
      (node) => node.type === 'label' && text(node).trim().startsWith(label),
    );
    assert.ok(node, `missing field ${label}`);
    return elements(node).find((node) => ['input', 'select', 'textarea'].includes(node.type));
  };
  return {
    writes,
    render,
    field,
    click(label) {
      const node = button(label);
      assert.ok(node, label);
      node.props.onClick();
    },
    change(label, value) {
      field(label).props.onChange({ target: { value } });
    },
    async submit() {
      elements(render())
        .find((node) => node.type === 'form')
        .props.onSubmit({ preventDefault() {} });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('旧产品可添加标准报价，完整条件必填且到期时间按北京时间保存', async (t) => {
  const h = setup(t, fixture(undefined));
  h.click('查看 / 编辑');
  h.click('添加外发资料');
  h.change('资料 1 · 类型', 'price');
  assert.equal(h.field('适用条件英文原句').props.required, true);
  assert.equal(h.field('有效期至').props.required, true);
  h.change('可外发英文原句', 'The standard price is USD 30 per set.');
  h.change('适用条件英文原句', 'For 500 sets of the standard configuration, FOB Shanghai.');
  h.change('有效期至', '2026-10-28T16:30:00');
  await h.submit();
  assert.equal(h.writes.length, 1);
  const [fact] = h.writes[0].outreachFacts;
  assert.ok(fact.id);
  assert.equal(fact.kind, 'price');
  assert.equal(fact.validUntil, '2026-10-28T08:30:00.000Z');
  assert.match(fact.conditions, /500 sets/);
  assert.equal(h.writes[0].expectedVersion, 2);
});

test('已登记的外发事实保留稳定编号，删除只影响选择的资料', async (t) => {
  const h = setup(
    t,
    fixture([
      {
        id: 'product-fact',
        kind: 'product',
        text: 'We supply PVC shutters.',
        conditions: '',
        validUntil: null,
      },
      {
        id: 'old-stock',
        kind: 'stock',
        text: '100 sets are in stock.',
        conditions: '',
        validUntil: '2026-10-28T08:30:00Z',
      },
    ]),
  );
  assert.match(text(h.render()), /We supply PVC shutters/);
  h.click('查看 / 编辑');
  assert.equal(h.field('有效期至').props.required, false);
  h.click('删除此条');
  assert.equal(h.field('有效期至').props.value, '2026-10-28T16:30:00');
  await h.submit();
  assert.deepEqual(
    h.writes[0].outreachFacts.map((fact) => fact.id),
    ['old-stock'],
  );
});

test('计划引用资料库事实无需重复声明，兼容旧介绍且只展示邮箱负责的产品', async (t) => {
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
      id: 'legacy-product',
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
            productIds: ['facts-product', 'legacy-product'],
          },
        ],
        products,
        campaigns: [],
        deliveries: [],
        review: {},
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
      return { useSearchParams: () => [new URLSearchParams(), () => {}] };
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
  const render = (campaign = { generationMode: 'professional', outreachClaims: [] }) => {
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
  assert.match(text(render(null)), /无需准备或审核样稿/);
  assert.equal(elements(render(null)).filter((node) => node.type === 'textarea').length, 0);
  states.editor = [];
  assert.match(text(render()), /来自产品资料库/);
  assert.equal(elements(render()).filter((node) => node.type === 'textarea').length, 1);
  assert.equal(elements(render()).find((node) => node.type === 'textarea').props.value, '');
  const picker = elements(render()).find((node) =>
    node.props.emptyText?.startsWith('所选邮箱与品类范围内'),
  );
  assert.deepEqual(
    picker.props.products.map((product) => product.id),
    ['facts-product', 'legacy-product'],
  );
  elements(render())
    .find((node) => node.type === 'textarea')
    .props.onChange({ target: { value: 'We supply curtains.' } });
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
  assert.deepEqual(saved.outreachClaims, [
    { productId: 'legacy-product', productVersion: 2, text: 'We supply curtains.' },
  ]);
  assert.deepEqual(saved.mailboxIds, ['mailbox-one']);
  states.editor = [];
  assert.equal(
    elements(render({ generationMode: 'professional', outreachClaims: [] })).find(
      (node) => node.type === 'textarea',
    ).props.value,
    '',
    'editing a plan must preserve an intentionally excluded product',
  );
});
