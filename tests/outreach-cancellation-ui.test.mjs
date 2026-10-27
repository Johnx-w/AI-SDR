import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createModuleLoader } from './helpers/modules.mjs';

const entry = new URL('../src/pages/OutreachCommunication.tsx', import.meta.url);
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

function setup(status = 'ready', { cancelError } = {}) {
  let campaign = {
    id: 'campaign-one',
    name: 'Australia first outreach',
    mode: 'production',
    status,
    revision: 7,
    approvedRevision: 7,
    targetCount: 150,
    mailboxIds: ['mailbox-one'],
    includeExisting: true,
    continuous: true,
    intervalSeconds: 30,
    createdAt: '2026-10-26T07:38:00Z',
    cancelledAt: status === 'cancelled' ? '2026-10-27T03:00:00Z' : undefined,
    filters: { markets: ['Australia'], grades: [], products: [] },
    stats: { queued: 0, accepted: 1, failed: 0, unknown: 0, blocked: 0 },
  };
  const deliveries = [
    {
      id: 'delivery-one',
      campaignId: campaign.id,
      mode: 'production',
      companyName: 'Buyer company',
      to: 'buyer@example.org',
      mailboxId: 'mailbox-one',
      from: 'sales@example.org',
      subject: 'Original submitted subject',
      bodyText: 'Original submitted message',
      status: 'accepted',
      createdAt: '2026-10-26T08:00:00Z',
      sentAt: '2026-10-26T08:00:00Z',
      messageId: '<original-message@example.org>',
    },
  ];
  const state = () => ({
    mailboxes: [],
    campaigns: [campaign],
    deliveries,
    products: [],
    readiness: { generatorConfigured: true },
    review: { internalTestPassed: false, productionApproved: true },
  });
  const requests = [],
    states = [],
    refs = [],
    effects = [],
    callbacks = [],
    pendingEffects = [];
  let stateIndex, refIndex, effectIndex, callbackIndex;
  const changed = (before, next) => !before || next.some((value, index) => value !== before[index]);
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
      return (refs[refIndex++] ||= { current: initial });
    },
    useCallback(callback, dependencies) {
      const index = callbackIndex++;
      if (changed(callbacks[index]?.dependencies, dependencies))
        callbacks[index] = { callback, dependencies };
      return callbacks[index].callback;
    },
    useEffect(effect, dependencies) {
      const index = effectIndex++;
      if (!changed(effects[index]?.dependencies, dependencies)) return;
      const previous = effects[index];
      effects[index] = { dependencies };
      pendingEffects.push(() => {
        previous?.cleanup?.();
        effects[index].cleanup = effect();
      });
    },
  };
  const load = createModuleLoader((specifier, path) => {
    if (path.href !== entry.href) return;
    if (specifier === 'react') return hooks;
    if (specifier === 'react-router-dom')
      return { useSearchParams: () => [new URLSearchParams({ tab: 'campaigns' }), () => {}] };
    if (specifier === '../outreachApi')
      return {
        outreachApi: async (path, init = {}) => {
          requests.push({ path, init });
          if (path === '/state') return structuredClone(state());
          if (path === '/campaigns/campaign-one') return structuredClone({ campaign, deliveries });
          if (path === '/campaigns/campaign-one/cancel') {
            if (cancelError) throw new Error(cancelError);
            campaign = { ...campaign, status: 'cancelled', revision: campaign.revision + 1 };
            return structuredClone({ campaign, deliveries });
          }
          throw new Error('Unexpected request: ' + path);
        },
      };
  });
  const { OutreachCommunication } = load(entry);
  const render = () => {
    stateIndex = refIndex = effectIndex = callbackIndex = 0;
    const tree = OutreachCommunication();
    // Effects load the real page data; polling callbacks are unnecessary for
    // these explicit user actions and never run in the test environment.
    const previousWindow = globalThis.window;
    globalThis.window = { setInterval: () => 0, clearInterval() {} };
    try {
      while (pendingEffects.length) pendingEffects.shift()();
    } finally {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    }
    return tree;
  };
  const elements = () => allElements(render());
  const button = (label, root = render()) =>
    allElements(root).find((node) => node.type === 'button' && textContent(node) === label);
  return {
    requests,
    render,
    elements,
    button,
    html: () => renderToStaticMarkup(render()),
    async ready() {
      render();
      await flush();
    },
    click(label, root) {
      const target = button(label, root);
      assert.ok(target, `missing button ${label}`);
      assert.equal(!!target.props.disabled, false, `disabled button ${label}`);
      target.props.onClick();
    },
    modal() {
      return elements().find((node) => node.props.title === '取消触达计划');
    },
    writes: () => requests.filter(({ init }) => init.method === 'POST'),
  };
}

test('unfinished outreach plans offer cancellation after an explicit confirmation, with an option to keep the plan', async () => {
  for (const status of ['draft', 'preparing', 'ready', 'active', 'paused']) {
    const h = setup(status);
    await h.ready();
    h.click('取消计划');
    assert.deepEqual(h.writes(), [], 'opening the confirmation must not cancel the plan');
    const dialog = h.modal();
    assert.ok(dialog, `missing confirmation for ${status}`);
    const explanation = textContent(dialog);
    assert.match(explanation, /Australia first outreach/);
    assert.match(explanation, /未发送任务会取消，已发送记录与计划详情会保留/);
    assert.match(explanation, /已提交到邮件服务商的邮件无法撤回/);
    assert.match(explanation, /正在提交的邮件仍会记录实际发送结果/);
    h.click('保留计划', dialog);
    assert.equal(h.modal(), undefined);
    assert.deepEqual(h.writes(), []);
  }
});

test('confirming cancellation submits the reviewed campaign revision and keeps its history accessible', async () => {
  const h = setup();
  await h.ready();
  h.click('取消计划');
  h.click('确认取消计划', h.modal());
  await flush();
  assert.equal(h.writes().length, 1);
  assert.equal(h.writes()[0].path, '/campaigns/campaign-one/cancel');
  assert.deepEqual(JSON.parse(h.writes()[0].init.body), { revision: 7, confirmed: true });
  assert.equal(h.modal(), undefined);
  assert.equal(h.button('取消计划'), undefined);
  assert.equal(h.button('编辑'), undefined);
  assert.ok(h.button('样稿与详情'));
  assert.match(h.html(), /已取消/);
  h.click('样稿与详情');
  h.render();
  await flush();
  const html = h.html();
  assert.match(html, /Original submitted subject/);
  assert.match(html, /Original submitted message/);
  assert.match(html, /original-message@example.org/);
  assert.match(html, /此计划已取消/);
  for (const label of ['准备样稿', '批准此版本与样稿', '启动自动发送', '恢复计划'])
    assert.equal(h.button(label), undefined);
});

test('completed and cancelled plans retain details without controls that could resume or change the plan', async () => {
  for (const status of ['completed', 'cancelled']) {
    const h = setup(status);
    await h.ready();
    assert.equal(h.button('取消计划'), undefined);
    assert.equal(h.button('编辑'), undefined);
    h.click('样稿与详情');
    h.render();
    await flush();
    assert.match(h.html(), /Original submitted subject/);
    for (const label of ['取消计划', '准备样稿', '批准此版本与样稿', '启动自动发送', '恢复计划'])
      assert.equal(h.button(label), undefined);
    assert.deepEqual(h.writes(), []);
  }
});

test('a rejected cancellation remains visible and does not report that the plan was cancelled', async () => {
  const h = setup('ready', { cancelError: '计划已更新，请刷新后重试' });
  await h.ready();
  h.click('取消计划');
  h.click('确认取消计划', h.modal());
  await flush();
  assert.ok(h.modal());
  assert.match(h.html(), /计划已更新，请刷新后重试/);
  assert.doesNotMatch(h.html(), /计划已取消，后续发送已停止/);
  assert.ok(h.button('保留计划', h.modal()));
});
