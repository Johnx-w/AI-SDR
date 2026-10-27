import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { createModuleLoader } from './helpers/modules.mjs';

function notificationEffect(open) {
  const effects = [];
  const refs = [];
  const changes = [];
  let stateIndex = 0;
  const entry = new URL('../src/app/App.tsx', import.meta.url);
  const load = createModuleLoader((specifier, path) => {
    if (path.href !== entry.href) return;
    if (specifier === 'react')
      return {
        ...React,
        useState(initial) {
          const index = stateIndex++;
          return [index === 2 ? open : initial, (value) => changes.push({ index, value })];
        },
        useEffect: (effect, deps) => effects.push({ effect, deps }),
        useRef(initial) {
          const ref = { current: initial };
          refs.push(ref);
          return ref;
        },
      };
    if (specifier === 'react-router-dom')
      return {
        useLocation: () => ({ pathname: '/leads' }),
        useNavigate: () => () => {},
      };
    if (specifier === './WorkspaceProvider') return { useWorkspace: () => ({ notify() {} }) };
    if (specifier.startsWith('../pages/')) return {};
  });
  load(entry).App();
  return { effect: effects[1].effect, refs, changes };
}

test('通知仅在点击外部或按 Escape 时收起，关闭和卸载后清理监听', () => {
  const listeners = new Map();
  const originalDocument = globalThis.document;
  const originalNode = globalThis.Node;
  class TestNode {
    contains(target) {
      return target === this || target.parent === this;
    }
  }
  globalThis.Node = TestNode;
  globalThis.document = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name, handler) => {
      assert.equal(listeners.get(name), handler);
      listeners.delete(name);
    },
  };
  try {
    const { effect, refs, changes } = notificationEffect(true);
    let focused = false;
    refs[1].current = Object.assign(new TestNode(), {
      focus: () => {
        focused = true;
      },
    });
    refs[2].current = new TestNode();
    const cleanup = effect();
    const pointer = listeners.get('pointerdown');
    pointer({ target: refs[1].current });
    pointer({ target: Object.assign(new TestNode(), { parent: refs[2].current }) });
    assert.deepEqual(changes, [], '铃铛和通知内容不触发外部关闭');
    pointer({ target: new TestNode() });
    assert.deepEqual(changes, [{ index: 2, value: false }]);
    listeners.get('keydown')({ key: 'Enter' });
    assert.equal(changes.length, 1);
    listeners.get('keydown')({ key: 'Escape' });
    assert.deepEqual(changes[1], { index: 2, value: false });
    assert.equal(focused, true);
    cleanup();
    assert.equal(listeners.size, 0);
    assert.equal(notificationEffect(false).effect(), undefined);
    assert.equal(listeners.size, 0);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalNode === undefined) delete globalThis.Node;
    else globalThis.Node = originalNode;
  }
});
