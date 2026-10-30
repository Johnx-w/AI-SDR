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
  timing: { repeat: 'daily', startDate: '2026-10-30', times: ['09:00'] },
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
