import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createModuleLoader } from './helpers/modules.mjs';

const entry = new URL('../src/pages/ScheduledAcquisition.tsx', import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const plan = (status) => ({
  id: 'plan-1',
  name: '定时计划',
  status,
  timing: {
    repeat: 'weekly',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    startDate: '2026-10-30',
    times: ['09:00'],
  },
  input: { country: 'United States', target_count: 10, product_scope: 'all' },
  nextRunAt: null,
  lastRunAt: null,
  runs: 0,
  lastJob: { id: 'job-1', status: 'running', inserted: 0 },
});
const elements = (node) =>
  Array.isArray(node)
    ? node.flatMap(elements)
    : React.isValidElement(node)
      ? [node, ...elements(node.props.children)]
      : [];
const words = (node) =>
  Array.isArray(node)
    ? node.map(words).join('')
    : React.isValidElement(node)
      ? words(node.props.children)
      : typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : '';
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('已关闭计划独立筛选并复用恢复操作', async () => {
  const closedPlan = {
    ...plan('closed'),
    id: 'closed-plan',
    name: '已关闭每日计划',
  };
  const ended = { ...plan('completed'), id: 'ended', name: '已结束单次计划', lastJob: null };
  const states = [[plan('enabled'), closedPlan, ended], false];
  const actions = [];
  let index = 0;
  const load = createModuleLoader((specifier, path) => {
    if (path.href !== entry.href) return;
    if (specifier === 'react')
      return {
        ...React,
        useState(initial) {
          const current = index++;
          if (!(current in states)) states[current] = initial;
          return [
            states[current],
            (next) => {
              states[current] = typeof next === 'function' ? next(states[current]) : next;
            },
          ];
        },
        useRef: (current) => ({ current }),
        useEffect() {},
      };
    if (specifier === '../services/acquisition')
      return {
        acquisitionApi: {
          async controlSchedule(id, action) {
            actions.push({ id, action });
            return { ...closedPlan, status: 'enabled' };
          },
        },
      };
  });
  const { ScheduledAcquisition } = load(entry);
  const render = () => {
    index = 0;
    return ScheduledAcquisition();
  };
  const cards = (tree) => elements(tree).filter((element) => element.type === 'section');
  assert.equal(cards(render()).length, 1, '进行中列表不混入已关闭计划，即使旧轮次仍在运行');
  const history = elements(render()).find(
    (element) => element.type === 'button' && words(element) === '已关闭计划',
  );
  history.props.onClick();
  const closed = render();
  assert.equal(words(history), '已关闭计划');
  assert.equal(cards(closed).length, 2, '历史入口保留关闭计划及已结束单次计划');
  assert.ok(words(closed).includes('每天'));
  const restore = elements(closed).find(
    (element) => element.type === 'button' && words(element).includes('恢复计划'),
  );
  assert.ok(restore);
  restore.props.onClick();
  await flush();
  assert.deepEqual(actions, [{ id: closedPlan.id, action: 'resume' }]);
  assert.equal(cards(render()).length, 1, '恢复成功的计划移出关闭列表');
  elements(render())
    .find((element) => element.type === 'button' && words(element) === '进行中的计划')
    .props.onClick();
  assert.equal(cards(render()).length, 2, '恢复成功的计划回到进行中列表');
});

test('旧轮询不能覆盖已暂停的定时计划，慢读取期间轮询不重叠', async () => {
  const states = [];
  const refs = [];
  const effects = [];
  const reads = [];
  let stateIndex, refIndex, effectIndex, timer;
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
    useEffect(effect) {
      const index = effectIndex++;
      if (!(index in effects)) effects[index] = effect;
    },
  };
  const load = createModuleLoader((specifier, path) => {
    if (path.href !== entry.href) return;
    if (specifier === 'react') return hooks;
    if (specifier === '../services/acquisition')
      return {
        acquisitionApi: {
          schedules: () => {
            const read = deferred();
            reads.push(read);
            return read.promise;
          },
          controlSchedule: async () => plan('paused'),
          controlJob: async () => {},
        },
      };
  });
  const { ScheduledAcquisition } = load(entry);
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (callback) => {
    timer = callback;
    return 1;
  };
  globalThis.clearInterval = () => {};
  let cleanup;
  try {
    const render = () => {
      stateIndex = refIndex = effectIndex = 0;
      return ScheduledAcquisition();
    };
    render();
    cleanup = effects[0]();
    timer();
    assert.equal(reads.length, 1, '初次读取未结束时不再启动轮询');
    reads[0].resolve({ schedules: [plan('enabled')] });
    await flush();
    const edit = elements(render()).find(
      (element) => element.props.to === '/automation?edit=plan-1',
    );
    assert.ok(edit, '进行中的计划提供编辑入口');

    timer();
    timer();
    assert.equal(reads.length, 2, '上一轮读取未结束时轮询保持单飞');
    const pause = elements(render()).find(
      (element) => element.type === 'button' && words(element).includes('暂停计划'),
    );
    assert.ok(pause);
    pause.props.onClick();
    await flush();
    assert.ok(words(render()).includes('已暂停'));

    reads[1].resolve({ schedules: [plan('enabled')] });
    await flush();
    assert.ok(words(render()).includes('已暂停'), '暂停前的 GET 不能恢复旧状态');
    assert.ok(!words(render()).includes('暂停计划'));

    timer();
    assert.equal(reads.length, 3);

    const expand = elements(render()).find(
      (element) => element.type === 'button' && words(element).includes('查看本轮任务'),
    );
    expand.props.onClick();
    const progress = elements(render()).find((element) => element.type.name === 'BatchProgress');
    progress.props.control('stop');
    await flush();
    assert.equal(reads.length, 4, '任务控制后立即重读，不等待操作前的旧 GET');

    reads[2].resolve({ schedules: [plan('enabled')] });
    await flush();
    assert.ok(words(render()).includes('已暂停'), '任务控制前的 GET 不能恢复旧状态');
    reads[3].resolve({ schedules: [plan('paused')] });
    await flush();
  } finally {
    cleanup?.();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
