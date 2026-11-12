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

function setup(
  status = 'ready',
  {
    cancelError,
    deliveryStatus = 'accepted',
    acceptedCount = 1,
    acquisitionSource,
    grades = [],
    extraCampaigns = [],
    mailboxes = [],
    mailboxDetails = {},
    tab = 'campaigns',
    detailResponse,
    deliveryResponse,
    extraDeliveries = [],
  } = {},
) {
  let campaign = {
    id: 'campaign-one',
    name: 'Australia first outreach',
    mode: 'production',
    status,
    revision: 7,
    approvedRevision: 7,
    targetCount: acquisitionSource ? null : 150,
    acquisitionSource,
    customerIds: acquisitionSource ? ['first', 'second'] : undefined,
    mailboxIds: ['mailbox-one'],
    includeExisting: true,
    continuous: true,
    intervalSeconds: 30,
    createdAt: '2026-10-26T07:38:00Z',
    cancelledAt: status === 'cancelled' ? '2026-10-27T03:00:00Z' : undefined,
    filters: { markets: ['Australia'], grades, products: [] },
    stats: { queued: 0, accepted: acceptedCount, failed: 0, unknown: 0, blocked: 0 },
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
      bodyHtml: '<p>Original submitted message</p>',
      status: deliveryStatus,
      createdAt: '2026-10-26T08:00:00Z',
      sentAt: '2026-10-26T08:00:00Z',
      messageId: '<original-message@example.org>',
    },
    ...extraDeliveries,
  ];
  const state = () => ({
    mailboxes,
    campaigns: [campaign, ...extraCampaigns],
    deliveries,
    products: [],
    readiness: { generatorConfigured: true },
  });
  let searchParams = new URLSearchParams({ tab });
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
      return {
        Link: ({ to, children, ...props }) =>
          React.createElement('a', { ...props, href: to }, children),
        useSearchParams: () => [
          searchParams,
          (next) => {
            searchParams = next(searchParams);
          },
        ],
      };
    if (specifier === '../outreachApi')
      return {
        outreachApi: async (path, init = {}) => {
          requests.push({ path, init });
          if (path === '/state') return structuredClone(state());
          if (path.startsWith('/mailboxes/')) {
            const mailbox = mailboxDetails[path.slice('/mailboxes/'.length)];
            if (mailbox instanceof Error) throw mailbox;
            return structuredClone(mailbox);
          }
          if (path.startsWith('/deliveries?'))
            return {
              items: structuredClone(deliveries),
              total: 1,
              page: 1,
              pageSize: 20,
              totalPages: 1,
            };
          if (path === '/campaigns/campaign-one' || path === '/campaigns/campaign-one?summary=1') {
            const result = structuredClone({ campaign, deliveries });
            if (path.endsWith('?summary=1'))
              result.deliveries = result.deliveries.map(({ bodyHtml, ...item }) => item);
            return detailResponse ? detailResponse(result) : result;
          }
          if (path.startsWith('/deliveries/')) {
            const result = structuredClone(
              deliveries.find((item) => path === `/deliveries/${item.id}`),
            );
            return deliveryResponse ? deliveryResponse(result) : result;
          }
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
  const intervals = new Map();
  let nextInterval = 0;
  const timerWindow = {
    setInterval(callback, delay) {
      intervals.set(++nextInterval, { callback, delay });
      return nextInterval;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
  };
  const render = () => {
    stateIndex = refIndex = effectIndex = callbackIndex = 0;
    const tree = OutreachCommunication();
    const previousWindow = globalThis.window;
    globalThis.window = timerWindow;
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
    tick(delay = 5000) {
      const previousDocument = globalThis.document;
      globalThis.document = { hidden: false };
      try {
        for (const timer of [...intervals.values()]) if (timer.delay === delay) timer.callback();
      } finally {
        if (previousDocument === undefined) delete globalThis.document;
        else globalThis.document = previousDocument;
      }
    },
    closeDetail() {
      const dialog = elements().find(
        (node) => node.props.title === campaign.name || node.props.title === '计划详情',
      );
      assert.ok(dialog);
      dialog.props.onClose();
      render();
    },
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
    change(label, value) {
      const field = elements().find((node) => node.props['aria-label'] === label);
      assert.ok(field, `missing field ${label}`);
      field.props.onChange({ target: { value } });
    },
  };
}

test('详情响应超过多个轮询周期仍显示结果，完成及取消的计划不再自动请求', async () => {
  for (const status of ['active', 'completed', 'cancelled']) {
    const pending = [];
    const h = setup(status, {
      detailResponse: (result) => new Promise((resolve) => pending.push(() => resolve(result))),
    });
    await h.ready();
    if (status !== 'active') h.click('历史计划');
    h.click('执行详情');
    h.render();
    assert.match(h.html(), /正在读取计划/);
    for (let i = 0; i < 8; i++) h.tick();
    assert.equal(pending.length, 1, 'a slow request must not be superseded by polling');
    pending[0]();
    await flush();
    assert.doesNotMatch(h.html(), /正在读取计划/);
    assert.match(h.html(), /Original submitted subject/);
    h.tick();
    assert.equal(pending.length, status === 'active' ? 2 : 1);
    assert.deepEqual(h.writes(), []);
  }
});

test('关闭再打开计划取消旧请求，迟到的结果不能覆盖新详情', async () => {
  const pending = [];
  const h = setup('active', {
    detailResponse: (result) => new Promise((resolve) => pending.push({ result, resolve })),
  });
  await h.ready();
  h.click('执行详情');
  h.render();
  const first = h.requests.find(({ path }) => path.startsWith('/campaigns/'));
  h.closeDetail();
  assert.equal(first.init.signal?.aborted, true);
  h.click('执行详情');
  h.render();
  pending[1].resolve(pending[1].result);
  await flush();
  pending[0].result.campaign.name = 'Stale campaign response';
  pending[0].resolve(pending[0].result);
  await flush();
  assert.doesNotMatch(h.html(), /Stale campaign response|正在读取计划/);
});

test('详情加载失败结束等待并允许重试', async () => {
  let fail = true;
  const h = setup('completed', {
    detailResponse: (result) => {
      if (fail) throw new Error('读取计划失败');
      return result;
    },
  });
  await h.ready();
  h.click('历史计划');
  h.click('执行详情');
  h.render();
  await flush();
  assert.match(h.html(), /读取计划失败/);
  assert.doesNotMatch(h.html(), /正在读取计划/);
  fail = false;
  h.click('重试读取计划');
  await flush();
  assert.match(h.html(), /Original submitted subject/);
});

test('计划只读取所选邮件正文，轮询相同摘要不重读，切换时忽略旧正文', async () => {
  const pending = [];
  const h = setup('active', {
    extraDeliveries: [
      {
        id: 'delivery-two',
        companyName: 'Second buyer',
        subject: 'Second subject',
        bodyText: 'Second body',
        bodyHtml: '<p>Second body</p>',
        status: 'accepted',
      },
    ],
    deliveryResponse: (result) => new Promise((resolve) => pending.push({ result, resolve })),
  });
  await h.ready();
  h.click('执行详情');
  h.render();
  await flush();
  h.render();
  assert.equal(pending.length, 1);
  assert.ok(h.requests.some(({ path }) => path === '/campaigns/campaign-one?summary=1'));
  const first = h.requests.find(({ path }) => path === '/deliveries/delivery-one');
  h.tick();
  await flush();
  h.render();
  assert.equal(
    pending.length,
    1,
    'unchanged summaries must not restart the selected body download',
  );
  const second = h
    .elements()
    .find((node) => node.type === 'button' && textContent(node).startsWith('Second buyer'));
  second.props.onClick();
  h.render();
  assert.equal(first.init.signal.aborted, true);
  assert.equal(pending.length, 2);
  pending[1].resolve(pending[1].result);
  await flush();
  pending[0].resolve(pending[0].result);
  await flush();
  const preview = h.elements().find((node) => node.props.delivery);
  assert.equal(preview.props.delivery.id, 'delivery-two');
  assert.equal(preview.props.delivery.bodyHtml, '<p>Second body</p>');
  h.closeDetail();
  assert.deepEqual(h.writes(), []);
});

test('单封正文读取失败可重试，不重新下载整个计划', async () => {
  let fail = true;
  const h = setup('completed', {
    deliveryResponse: (result) => {
      if (fail) throw new Error('正文网络错误');
      return result;
    },
  });
  await h.ready();
  h.click('历史计划');
  h.click('执行详情');
  h.render();
  await flush();
  h.render();
  await flush();
  assert.match(h.html(), /正文网络错误/);
  assert.doesNotMatch(h.html(), /正在读取邮件正文/);
  fail = false;
  h.click('重试读取正文');
  h.render();
  await flush();
  const preview = h.elements().find((node) => node.props.delivery);
  assert.equal(preview.props.delivery.bodyHtml, '<p>Original submitted message</p>');
  assert.equal(h.requests.filter(({ path }) => path.startsWith('/campaigns/')).length, 1);
  assert.deepEqual(h.writes(), []);
});

test('自动计划草稿直接提供启动入口，不展示样稿准备或审批步骤', async () => {
  const h = setup('draft', {});
  await h.ready();
  h.click('执行详情');
  h.render();
  await flush();
  assert.ok(h.button('启动自动发送'));
  assert.equal(!!h.button('启动自动发送').props.disabled, false);
  assert.equal(h.button('准备样稿'), undefined);
  assert.equal(h.button('批准此版本与样稿'), undefined);
  assert.deepEqual(h.writes(), []);
});

test('尚无可发送邮件的就绪计划仍提示待补齐条件', async () => {
  const h = setup('ready', { acceptedCount: 0 });
  await h.ready();
  assert.match(textContent(h.render()), /待补齐条件/);
});

test('运行中的获客自动首发保留在当前计划，按收录客户展示并由获客入口管理', async () => {
  const h = setup('active', {
    acquisitionSource: { jobId: 'source-job', roundId: 'source-job' },
  });
  await h.ready();
  assert.match(h.html(), /获客后自动首发/);
  assert.match(h.html(), /1 \/ 2/);
  assert.match(h.html(), /已发送 \/ 本轮收录客户/);
  assert.match(h.html(), /automation\?tab=runs&amp;job=source-job/);
  for (const label of ['暂停计划', '取消计划', '编辑']) assert.equal(h.button(label), undefined);
  h.click('历史计划');
  assert.equal(h.button('执行详情'), undefined);
  h.click('当前计划');
  h.click('执行详情');
  h.render();
  await flush();
  assert.match(h.html(), /本轮收录 2 家/);
  for (const label of ['暂停', '取消计划', '启动自动发送', '恢复计划'])
    assert.equal(h.button(label), undefined);
  assert.deepEqual(h.writes(), []);
});

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
  h.click('历史计划');
  assert.ok(h.button('执行详情'));
  assert.match(h.html(), /已取消/);
  h.click('执行详情');
  h.render();
  await flush();
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
    h.click('历史计划');
    assert.equal(h.button('取消计划'), undefined);
    assert.equal(h.button('编辑'), undefined);
    h.click('执行详情');
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

test('计划表格默认只列当前正式计划，搜索筛选先于分页且历史与试发独立可查', async () => {
  const extraCampaigns = Array.from({ length: 24 }, (_, i) => ({
    id: `plan-${i}`,
    name: `Europe ${i}`,
    mode: 'production',
    status: i === 23 ? 'paused' : 'active',
    targetCount: 50,
    stats: { accepted: 3 },
    deliveryGroups: { attention: i === 23 ? 2 : 0 },
    createdAt: '2026-11-05T00:00:00Z',
  }));
  extraCampaigns.push(
    {
      id: 'old',
      name: 'Historical plan',
      mode: 'production',
      status: 'completed',
      targetCount: 50,
      stats: { accepted: 39 },
    },
    {
      id: 'test',
      name: 'Company test',
      mode: 'internal_test',
      status: 'completed',
      targetCount: 3,
      stats: { accepted: 3 },
    },
  );
  const h = setup('active', { extraCampaigns });
  await h.ready();
  const rows = () =>
    h
      .elements()
      .filter((node) => node.type === 'tbody')
      .flatMap((node) => allElements(node).filter((item) => item.type === 'tr'));
  assert.equal(rows().length, 20);
  assert.doesNotMatch(h.html(), /Historical plan|Company test/);
  h.click('下一页');
  assert.equal(rows().length, 5);
  h.change('搜索计划名称', 'eUrOpE 23');
  assert.equal(rows().length, 1);
  assert.match(h.html(), /第 1 \/ 1 页/);
  h.change('搜索计划名称', '');
  h.change('按计划状态筛选', 'attention');
  assert.equal(rows().length, 1);
  assert.match(h.html(), /Europe 23/);
  h.change('按计划状态筛选', 'active');
  h.change('每页计划条数', '10');
  assert.equal(rows().length, 10);
  h.click('历史计划');
  assert.equal(rows().length, 1);
  assert.match(h.html(), /Historical plan/);
  assert.match(h.html(), /39 \/ 50/);
  assert.match(h.html(), /width:78%/);
  assert.doesNotMatch(h.html(), /Company test/);
  h.click('公司试发');
  assert.equal(rows().length, 1);
  assert.match(h.html(), /Company test/);
  assert.deepEqual(h.writes(), []);
});

test('发送记录提供五类筛选，未知结果详情保留先核对且不重发的说明', async () => {
  const h = setup('active', { tab: 'deliveries', deliveryStatus: 'unknown' });
  await h.ready();
  h.render();
  await flush();
  const filter = h.elements().find((node) => node.props['aria-label'] === '按发送状态筛选');
  assert.deepEqual(
    allElements(filter)
      .filter((node) => node.type === 'option')
      .map(textContent),
    ['全部（不含已取消、已跳过）', '待发送', '已发送', '需处理', '已跳过', '已取消'],
  );
  h.change('按发送状态筛选', 'attention');
  h.render();
  await flush();
  assert.ok(h.requests.some(({ path }) => path.includes('group=attention')));
  assert.match(h.html(), /需处理/);
  h.elements()
    .find((node) => node.props['aria-label'] === '查看 Buyer company 的邮件')
    .props.onClick();
  assert.match(h.html(), /结果待核实；请先核对原邮箱，系统不会自动重发/);
  assert.deepEqual(h.writes(), []);
});

test('已跳过详情只显示客户、计划、原因与时间，不显示空邮件或人工处理按钮', async () => {
  const h = setup('active', { tab: 'deliveries', deliveryStatus: 'skipped' });
  await h.ready();
  h.change('按发送状态筛选', 'skipped');
  h.render();
  await flush();
  assert.ok(h.requests.some(({ path }) => path.includes('group=skipped')));
  h.elements()
    .find((node) => node.props['aria-label'] === '查看 Buyer company 的跳过记录')
    .props.onClick();
  const html = h.html();
  assert.match(html, /所属计划：Australia first outreach/);
  assert.match(html, /跳过原因：无可用商务邮箱/);
  assert.match(html, /本次首发已结束/);
  assert.doesNotMatch(
    html,
    /邮件内容尚未生成|尚未生成主题|标记不再联系|Original submitted message/,
  );
  assert.deepEqual(h.writes(), []);
});

test('邮箱卡片按需读取Logo，普通重渲染不重取，手动刷新及保存Logo后更新', async () => {
  const mailbox = {
    id: 'one',
    email: 'sales@example.org',
    displayName: 'Alice',
    signature: 'Best regards, Alice',
    productIds: [],
  };
  const detail = {
    ...mailbox,
    signatureDesign: {
      closing: 'Best regards,',
      companyName: 'Logo brand',
      logoWidth: 160,
      logo: { contentType: 'image/png', contentBase64: 'bG9nbw==' },
    },
  };
  const h = setup('ready', {
    tab: 'mailboxes',
    mailboxes: [mailbox],
    mailboxDetails: { one: detail },
  });
  await h.ready();
  h.render();
  await flush();
  assert.match(h.html(), /data:image\/png;base64,bG9nbw==/);
  assert.equal(h.requests.filter(({ path }) => path === '/mailboxes/one').length, 1);
  h.render();
  assert.equal(h.requests.filter(({ path }) => path === '/mailboxes/one').length, 1);
  detail.signatureDesign.logo.contentBase64 = 'bmV3';
  h.click('刷新');
  await flush();
  h.render();
  await flush();
  assert.match(h.html(), /data:image\/png;base64,bmV3/);
  h.elements()
    .find((node) => node.type === 'button' && textContent(node) === '配置')
    .props.onClick();
  await flush();
  detail.signatureDesign.logo.contentBase64 = 'c2F2ZWQ=';
  const editor = h.elements().find((node) => node.type?.name === 'MailboxEditor');
  await editor.props.onSave({ signatureDesign: detail.signatureDesign });
  h.render();
  await flush();
  assert.match(h.html(), /data:image\/png;base64,c2F2ZWQ=/);
});

test('一个邮箱签名读取失败不隐藏其他邮箱Logo，离开邮箱页不再加载图片', async () => {
  const good = { id: 'good', signature: 'Team', productIds: [] };
  const bad = { id: 'bad', signature: 'Other', productIds: [] };
  const h = setup('ready', {
    mailboxes: [good, bad],
    mailboxDetails: {
      good: {
        ...good,
        signatureDesign: {
          companyName: 'Company',
          logoWidth: 160,
          logo: { contentType: 'image/png', contentBase64: 'b2s=' },
        },
      },
      bad: new Error('读取失败'),
    },
  });
  await h.ready();
  assert.equal(h.requests.filter(({ path }) => path.startsWith('/mailboxes/')).length, 0);
  h.elements()
    .find((node) => node.props.id === 'outreach-tab-mailboxes')
    .props.onClick();
  h.render();
  await flush();
  assert.match(h.html(), /data:image\/png;base64,b2s=/);
  assert.match(h.html(), /完整签名读取失败/);
  h.elements()
    .find((node) => node.props.id === 'outreach-tab-campaigns')
    .props.onClick();
  h.render();
  const count = h.requests.length;
  h.render();
  assert.equal(h.requests.length, count);
});
