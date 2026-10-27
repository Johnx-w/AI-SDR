import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createModuleLoader } from './helpers/modules.mjs';

const componentPath = new URL('../src/components/SupplementPanel.tsx', import.meta.url);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const allElements = (node) => {
  if (Array.isArray(node)) return node.flatMap(allElements);
  return React.isValidElement(node) ? [node, ...allElements(node.props.children)] : [];
};
const textContent = (node) => {
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (React.isValidElement(node)) return textContent(node.props.children);
  return typeof node === 'string' || typeof node === 'number' ? String(node) : '';
};
const assessment = {
  id: 'ev_base',
  product: 'Roller shades',
  direction: 'finished',
  opportunities: [
    { product: 'Roller shades', direction: 'finished' },
    { product: 'Roller fabric', direction: 'materials' },
  ],
};

function setup({
  context = { category: 'assessment', dimension: 'R' },
  value = assessment,
  workspace,
  save,
  pending,
} = {}) {
  const states = [],
    refs = [],
    effects = [];
  let stateIndex, refIndex, effectIndex;
  const pendingEffects = [];
  const calls = [],
    saved = [];
  const hooks = {
    ...React,
    useState(initial) {
      const index = stateIndex++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [
        states[index],
        (next) => {
          states[index] = typeof next === 'function' ? next(states[index]) : next;
        },
      ];
    },
    useRef(initial) {
      const index = refIndex++;
      return (refs[index] ||= { current: initial });
    },
    useEffect(effect, dependencies) {
      const index = effectIndex++;
      const previous = effects[index];
      if (
        !previous ||
        dependencies.some((value, position) => value !== previous.dependencies[position])
      ) {
        previous?.cleanup?.();
        effects[index] = { dependencies };
        pendingEffects.push(() => {
          effects[index].cleanup = effect();
        });
      }
    },
  };
  const load = createModuleLoader((specifier, path) => {
    if (path.href !== componentPath.href) return;
    if (specifier === 'react') return hooks;
    if (specifier === '../services/customerBusiness')
      return { customerBusinessApi: { workspace: workspace || (async () => ({ messages: [] })) } };
    if (specifier === '../services/leadSupplements')
      return {
        pendingLeadSupplement: pending || (async () => ({ pending: null })),
        saveLeadSupplement: async (...args) => {
          calls.push(args);
          return save ? save(...args) : { lead: { id: args[0] } };
        },
      };
  });
  const { SupplementPanel } = load(componentPath);
  const props = {
    leadId: 'rec-buyer',
    assessment: value,
    context,
    onSaved: (lead) => saved.push(lead),
    onCancel() {},
  };
  const render = () => {
    stateIndex = refIndex = effectIndex = 0;
    const tree = SupplementPanel(props);
    while (pendingEffects.length) pendingEffects.shift()();
    return tree;
  };
  const elements = () => allElements(render());
  const field = (label) => {
    const element = elements().find(
      (item) => item.type === 'label' && textContent(item).startsWith(label),
    );
    assert.ok(element, `missing field ${label}`);
    const control = allElements(element).find((item) =>
      ['input', 'select', 'textarea'].includes(item.type),
    );
    assert.ok(control, `missing control ${label}`);
    return control;
  };
  return {
    render,
    field,
    elements,
    calls,
    saved,
    async ready() {
      render();
      await flush();
    },
    change(label, value) {
      field(label).props.onChange({ target: { value } });
    },
    async submit() {
      elements()
        .find((item) => item.type === 'form')
        .props.onSubmit({ preventDefault() {} });
      await flush();
    },
    click(label) {
      const button = elements().find(
        (item) => item.type === 'button' && textContent(item).includes(label),
      );
      assert.ok(button, `missing button ${label}`);
      button.props.onClick();
    },
  };
}

function fill(harness) {
  harness.change('确认内容', '已电话核实该品类的实际经营角色');
  harness.change('具体信息', '专业供货与售后服务');
  harness.change('确认依据', '客户采购经理确认：本公司专业经营卷帘产品。');
  harness.change('确认人', '张经理');
}

test('assessment form retains exact product/direction scope and collects evidence rather than scores', async () => {
  const harness = setup({
    context: {
      category: 'assessment',
      dimension: 'R',
      product: 'Roller fabric',
      direction: 'materials',
      pendingItem: '经营角色尚待核实',
    },
  });
  await harness.ready();
  fill(harness);
  const html = renderToStaticMarkup(harness.render());
  assert.match(html, /材料配件 · Roller fabric/);
  assert.match(html, /selected="">材料配件 · Roller fabric/);
  assert.match(html, /该品类专业供货/);
  assert.doesNotMatch(html, /主营产品|定制特征|type="number"|type="datetime-local"/);
  assert.equal(harness.field('确认依据').props.required, true);
  assert.equal(harness.field('确认人').props.required, true);
  assert.equal(harness.field('来源链接').props.required, undefined);
  await harness.submit();
  assert.deepEqual(harness.calls[0][1], {
    expectedAssessmentId: 'ev_base',
    category: 'assessment',
    dimension: 'R',
    product: 'Roller fabric',
    direction: 'materials',
    facts: [{ kind: 'specialist_supply', value: '专业供货与售后服务' }],
    content: '已电话核实该品类的实际经营角色',
    evidence: '客户采购经理确认：本公司专业经营卷帘产品。',
    confirmedBy: '张经理',
    pendingItem: '经营角色尚待核实',
  });
  assert.equal(harness.saved.length, 1);
});

test('changing dimension or category drops the original pending item instead of resolving another gap', async () => {
  const harness = setup({
    context: { category: 'assessment', dimension: 'R', pendingItem: '经营角色待确认' },
  });
  await harness.ready();
  fill(harness);
  harness.change('评分维度', 'V');
  harness.change('具体信息', '可按尺寸定制');
  await harness.submit();
  assert.equal(harness.calls[0][1].pendingItem, undefined);
  assert.equal(harness.calls[0][1].dimension, 'V');
  harness.change('补充项目', 'legal_name');
  harness.change('已确认的经营法人全称', 'Buyer Limited');
  await harness.submit();
  assert.equal(harness.calls[1][1].pendingItem, undefined);
  assert.equal(harness.calls[1][1].facts, undefined);
  assert.equal(harness.calls[1][1].dimension, undefined);
});

test('failed saves preserve content and reuse a key for the exact payload, including edit then revert', async () => {
  const harness = setup({
    save: async () => {
      throw new Error('网络中断，保留内容重试');
    },
  });
  await harness.ready();
  fill(harness);
  await harness.submit();
  assert.equal(harness.field('确认内容').props.value, '已电话核实该品类的实际经营角色');
  assert.match(renderToStaticMarkup(harness.render()), /网络中断，保留内容重试/);
  await harness.submit();
  assert.equal(harness.calls[0][2], harness.calls[1][2]);
  harness.change('确认内容', '补充另一条确认内容');
  await harness.submit();
  assert.notEqual(harness.calls[0][2], harness.calls[2][2]);
  harness.change('确认内容', '已电话核实该品类的实际经营角色');
  await harness.submit();
  assert.equal(harness.calls[0][2], harness.calls[3][2]);
});

test('unknown product assessment is visibly blocked while legacy current product still provides scope', () => {
  const unknown = setup({ value: { id: 'ev_unscoped' } });
  assert.match(
    renderToStaticMarkup(unknown.render()),
    /当前没有可补充的产品评估，请先完成企业研究/,
  );
  assert.equal(
    unknown.elements().find((item) => item.type === 'button' && item.props.type === 'submit').props
      .disabled,
    true,
  );
  const legacy = setup({
    value: { id: 'ev_legacy', product: 'Roller shades', direction: 'finished' },
  });
  assert.equal(legacy.field('对应产品与供货方向').props.disabled, false);
});

test('purchase source accepts only actual customer communication and requires a verbatim quote', async () => {
  const actual = {
    id: 'msg-real',
    customerId: 'rec-buyer',
    actualConfirmed: true,
    direction: 'inbound',
    deliveryStatus: 'received',
    channel: 'email',
    classification: 'normal',
    subject: '需求确认',
    body: 'We need 200 roller shades.',
    occurredAt: '2026-10-25T00:30:00Z',
  };
  const harness = setup({
    context: { category: 'purchase_need', pendingItem: '具体采购需求待确认' },
    workspace: async () => ({
      messages: [
        actual,
        {
          ...actual,
          id: 'msg-out',
          direction: 'outbound',
          deliveryStatus: 'sent',
          subject: '已发送开发信',
        },
        { ...actual, id: 'msg-auto', classification: 'auto_reply', subject: '自动回复' },
        { ...actual, id: 'msg-complaint', classification: 'complaint', subject: '投诉' },
        { ...actual, id: 'msg-other', customerId: 'rec-other', subject: '其他企业' },
      ],
    }),
  });
  harness.render();
  await flush();
  const html = renderToStaticMarkup(harness.render());
  assert.match(html, /需求确认 · 2026年10月25日 08:30（北京时间）/);
  assert.doesNotMatch(html, /已发送开发信|自动回复|其他企业|投诉/);
  harness.change('实际来信或通话记录', 'msg-real');
  harness.change('确认内容', '客户需要 200 套卷帘');
  harness.change('确认人', '张经理');
  harness.change('依据原文', '需要两百套');
  await harness.submit();
  assert.equal(harness.calls.length, 0);
  assert.match(renderToStaticMarkup(harness.render()), /从原文中逐字摘录依据/);
  harness.change('依据原文', 'We need 200 roller shades.');
  await harness.submit();
  assert.equal(harness.calls[0][1].sourceMessageId, 'msg-real');
  assert.equal(harness.calls[0][1].evidence, actual.body);
});

test('purchase form without messages keeps the draft and provides registration and refresh paths', async () => {
  let reads = 0;
  const harness = setup({
    context: { category: 'purchase_need' },
    workspace: async () => {
      reads++;
      return { messages: [] };
    },
  });
  harness.render();
  await flush();
  harness.change('确认内容', '已记录的采购线索');
  const link = harness.elements().find((item) => item.type === 'a');
  assert.equal(link.props.href, '/business?customerId=rec-buyer&tab=messages');
  assert.equal(link.props.target, '_blank');
  harness.click('刷新记录');
  harness.render();
  await flush();
  assert.equal(reads, 2);
  assert.equal(harness.field('确认内容').props.value, '已记录的采购线索');
  assert.equal(
    harness.elements().find((item) => item.type === 'button' && item.props.type === 'submit').props
      .disabled,
    true,
  );
});

test('reopening an uncertain save restores audit fields and retries the original payload and key', async () => {
  const input = {
    expectedAssessmentId: 'ev_original',
    category: 'assessment',
    dimension: 'V',
    product: 'Original Zip screen',
    direction: 'finished',
    content: '客户确认可定制',
    evidence: 'Custom made screens confirmed by telephone.',
    sourceUrl: '',
    confirmedBy: '李经理',
    pendingItem: '定制特征待确认',
    facts: [{ kind: 'custom_made', value: '可按实际尺寸定制' }],
  };
  const harness = setup({
    context: { category: 'legal_name', pendingItem: '经营法人名称待核实' },
    pending: async () => ({ pending: { input, key: 'original-save-key' } }),
  });
  assert.equal(harness.elements().find((item) => item.type === 'fieldset').props.disabled, true);
  await flush();
  const html = renderToStaticMarkup(harness.render());
  assert.match(html, /已恢复内容，请先按原内容重试核对/);
  assert.match(html, /Original Zip screen/);
  assert.match(html, /selected="">成品 · Original Zip screen/);
  assert.match(html, /定制特征待确认/);
  assert.doesNotMatch(html, /待确认：经营法人名称待核实/);
  assert.equal(harness.field('确认内容').props.value, input.content);
  assert.equal(harness.field('确认人').props.value, input.confirmedBy);
  assert.equal(harness.elements().find((item) => item.type === 'fieldset').props.disabled, true);
  assert.equal(
    harness.elements().find((item) => item.type === 'button' && item.props.type === 'submit').props
      .disabled,
    false,
  );
  await harness.submit();
  assert.deepEqual(harness.calls[0][1], input);
  assert.equal(harness.calls[0][2], 'original-save-key');
});

test('restored assessment keeps its original scope when the current product is changed or unavailable', async () => {
  const input = {
    expectedAssessmentId: 'ev_original',
    category: 'assessment',
    dimension: 'R',
    product: 'Original Roller fabric',
    direction: 'materials',
    content: '原产品的经营角色已核实',
    evidence: 'Confirmed specialist fabric supplier.',
    confirmedBy: '李经理',
    facts: [{ kind: 'specialist_supply', value: '专业面料供货' }],
  };
  for (const value of [null, { id: 'ev_new_without_scope' }, assessment]) {
    const harness = setup({
      value,
      context: { category: 'profile' },
      pending: async () => ({ pending: { input, key: 'original-scope-key' } }),
      save: async () => {
        throw new Error('对应产品已变化，请刷新档案后重试');
      },
    });
    await harness.ready();
    const html = renderToStaticMarkup(harness.render());
    assert.match(html, /selected="">材料配件 · Original Roller fabric/);
    assert.equal(harness.field('评分维度').props.value, 'R');
    await harness.submit();
    assert.equal(harness.calls.length, 1);
    assert.deepEqual(harness.calls[0][1], input);
    assert.equal(harness.calls[0][2], 'original-scope-key');
    assert.match(
      renderToStaticMarkup(harness.render()),
      /role="alert">对应产品已变化，请刷新档案后重试/,
    );
  }
});

test('pending-status read failure shows an actionable error and prevents creating a competing save', async () => {
  let reads = 0;
  const harness = setup({
    pending: async () => {
      if (++reads === 1) throw new Error('上次保存状态读取失败');
      return { pending: null };
    },
  });
  await harness.ready();
  assert.match(renderToStaticMarkup(harness.render()), /role="alert">上次保存状态读取失败/);
  assert.equal(harness.elements().find((item) => item.type === 'fieldset').props.disabled, true);
  await harness.submit();
  assert.equal(harness.calls.length, 0);
  harness.click('重试读取保存状态');
  await harness.ready();
  assert.equal(reads, 2);
  assert.equal(harness.elements().find((item) => item.type === 'fieldset').props.disabled, false);
});
