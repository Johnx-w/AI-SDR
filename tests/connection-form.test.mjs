import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createConnectionForm,
  connectionFormFields,
  connectionFormPayload,
  updateConnectionForm,
} from '../src/domain/connection-settings.mjs';

const field = (key, value = '', extra = {}) => ({
  key,
  label: key,
  value,
  secret: /(?:API_KEY|SECRET|APP_TOKEN)$/.test(key),
  configured: Boolean(value),
  ...extra,
});
const settings = (changes = {}) => ({
  provider: 'native',
  ready: true,
  fields: [
    field('WEB_SEARCH_PROVIDER', 'tavily'),
    field('WEB_SEARCH_BASE_URL', '', { effectiveValue: 'https://api.tavily.com' }),
    field('WEB_SEARCH_API_KEY'),
    field('TAVILY_API_KEY', '', { configured: true, maskedValue: 'tavi********tail' }),
    field('RESEARCH_MODEL_PROVIDER', 'deepseek'),
    field('RESEARCH_MODEL_BASE_URL', '', { effectiveValue: 'https://api.deepseek.com' }),
    field('RESEARCH_MODEL_MODEL', '', { effectiveValue: 'deepseek-existing' }),
    field('RESEARCH_MODEL_API_KEY'),
    field('DEEPSEEK_API_KEY', '', { configured: true, maskedValue: 'deep********tail' }),
    field('DEEPSEEK_MODEL', 'deepseek-existing'),
    field('CUSTOMS_PROVIDER', 'billofladingdata'),
    field('CUSTOMS_BASE_URL', '', { effectiveValue: 'https://tradedata.billofladingdata.com' }),
    field('CUSTOMS_API_KEY', '', { configured: true, maskedValue: '********' }),
    field('FEISHU_APP_ID', 'saved-app-id'),
  ].map((item) => ({ ...item, ...changes[item.key] })),
});
const view = (snapshot, state, key) =>
  connectionFormFields(snapshot, state).find((item) => item.key === key);
const change = (snapshot, state, key, value) =>
  updateConnectionForm(snapshot, state, { type: 'change', key, value });

test('统一字段隐藏旧专用配置，通用密钥展示当前供应商的脱敏旧值', () => {
  const snapshot = settings();
  const state = createConnectionForm();
  const fields = connectionFormFields(snapshot, state);
  assert.equal(
    fields.some((item) => /^(TAVILY_|DEEPSEEK_)/.test(item.key)),
    false,
  );
  assert.equal(view(snapshot, state, 'WEB_SEARCH_API_KEY').maskedValue, 'tavi********tail');
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_API_KEY').maskedValue, 'deep********tail');
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_API_KEY').configured, true);
  assert.equal(view(snapshot, state, 'CUSTOMS_API_KEY').maskedValue, '********');
});

test('显式通用密钥优先于供应商旧值，且未编辑密钥不进入表单或请求', () => {
  const snapshot = settings({
    RESEARCH_MODEL_API_KEY: { configured: true, maskedValue: 'gene********tail' },
  });
  const state = createConnectionForm();
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_API_KEY').maskedValue, 'gene********tail');
  assert.deepEqual(state.values, {});
  assert.deepEqual(connectionFormPayload(snapshot, state), { values: {}, clear: [] });
});

test('有效 URL 和模型直接作为输入显示，不把默认或旧值自动持久化', () => {
  const snapshot = settings();
  let state = createConnectionForm();
  assert.equal(view(snapshot, state, 'WEB_SEARCH_BASE_URL').value, 'https://api.tavily.com');
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_MODEL').value, 'deepseek-existing');
  assert.equal(
    view(snapshot, state, 'CUSTOMS_BASE_URL').value,
    'https://tradedata.billofladingdata.com',
  );
  state = change(snapshot, state, 'WEB_SEARCH_BASE_URL', 'https://api.tavily.com');
  state = change(snapshot, state, 'RESEARCH_MODEL_MODEL', 'deepseek-existing');
  assert.deepEqual(connectionFormPayload(snapshot, state), { values: {}, clear: [] });
});

test('只提交实际修改的字段；改回原有效值撤销 dirty，快照不变', () => {
  const snapshot = settings();
  const before = structuredClone(snapshot);
  let state = change(
    snapshot,
    createConnectionForm(),
    'WEB_SEARCH_BASE_URL',
    'https://custom.example',
  );
  assert.deepEqual(connectionFormPayload(snapshot, state).values, {
    WEB_SEARCH_BASE_URL: 'https://custom.example',
  });
  state = change(snapshot, state, 'WEB_SEARCH_BASE_URL', 'https://api.tavily.com');
  assert.deepEqual(connectionFormPayload(snapshot, state).values, {});
  assert.deepEqual(snapshot, before);
});

test('修改密钥空白不覆盖，取消丢弃新值并恢复旧掩码', () => {
  const snapshot = settings();
  let state = updateConnectionForm(snapshot, createConnectionForm(), {
    type: 'edit_secret',
    key: 'RESEARCH_MODEL_API_KEY',
  });
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_API_KEY').value, '');
  assert.deepEqual(connectionFormPayload(snapshot, state).values, {});
  state = change(snapshot, state, 'RESEARCH_MODEL_API_KEY', 'fixture-new-secret');
  assert.deepEqual(connectionFormPayload(snapshot, state).values, {
    RESEARCH_MODEL_API_KEY: 'fixture-new-secret',
  });
  state = updateConnectionForm(snapshot, state, {
    type: 'cancel_secret',
    key: 'RESEARCH_MODEL_API_KEY',
  });
  assert.deepEqual(connectionFormPayload(snapshot, state).values, {});
  assert.deepEqual(state.editingSecrets, []);
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_API_KEY').maskedValue, 'deep********tail');
});

test('当前供应商密钥显式清除同时移除通用与旧 fallback，取消清除不修改任何值', () => {
  const snapshot = settings();
  let state = updateConnectionForm(snapshot, createConnectionForm(), {
    type: 'clear',
    key: 'RESEARCH_MODEL_API_KEY',
    checked: true,
  });
  assert.deepEqual(connectionFormPayload(snapshot, state).clear.sort(), [
    'DEEPSEEK_API_KEY',
    'RESEARCH_MODEL_API_KEY',
  ]);
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_API_KEY').cleared, true);
  state = updateConnectionForm(snapshot, state, {
    type: 'clear',
    key: 'RESEARCH_MODEL_API_KEY',
    checked: false,
  });
  assert.deepEqual(connectionFormPayload(snapshot, state), { values: {}, clear: [] });
});

test('清除通用网页密钥和模型名称也清除当前供应商的旧 fallback', () => {
  const snapshot = settings();
  let state = updateConnectionForm(snapshot, createConnectionForm(), {
    type: 'clear',
    key: 'WEB_SEARCH_API_KEY',
    checked: true,
  });
  state = updateConnectionForm(snapshot, state, {
    type: 'clear',
    key: 'RESEARCH_MODEL_MODEL',
    checked: true,
  });
  assert.deepEqual(connectionFormPayload(snapshot, state).clear.sort(), [
    'DEEPSEEK_MODEL',
    'RESEARCH_MODEL_MODEL',
    'TAVILY_API_KEY',
    'WEB_SEARCH_API_KEY',
  ]);
});

test('切换模型服务重置共享地址、模型、密钥，不携带旧服务配置或清除隐藏旧密钥', () => {
  const snapshot = settings({
    RESEARCH_MODEL_API_KEY: { configured: true, maskedValue: 'gene********tail' },
    RESEARCH_MODEL_BASE_URL: {
      configured: true,
      value: 'https://old.example',
      effectiveValue: 'https://old.example',
    },
  });
  const state = change(
    snapshot,
    createConnectionForm(),
    'RESEARCH_MODEL_PROVIDER',
    'openai_compatible',
  );
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_API_KEY').configured, false);
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_API_KEY').maskedValue, '');
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_BASE_URL').value, '');
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_MODEL').value, '');
  const payload = connectionFormPayload(snapshot, state);
  assert.deepEqual(payload.values, { RESEARCH_MODEL_PROVIDER: 'openai_compatible' });
  assert.deepEqual(payload.clear.sort(), [
    'RESEARCH_MODEL_API_KEY',
    'RESEARCH_MODEL_BASE_URL',
    'RESEARCH_MODEL_MODEL',
  ]);
  assert.equal(payload.clear.includes('DEEPSEEK_API_KEY'), false);
});

test('切换服务后可填写新通用密钥和地址，清除请求不会覆盖新输入', () => {
  const snapshot = settings({
    RESEARCH_MODEL_API_KEY: { configured: true, maskedValue: 'gene********tail' },
  });
  let state = change(
    snapshot,
    createConnectionForm(),
    'RESEARCH_MODEL_PROVIDER',
    'openai_compatible',
  );
  state = change(snapshot, state, 'RESEARCH_MODEL_API_KEY', 'fixture-next-provider-secret');
  state = change(snapshot, state, 'RESEARCH_MODEL_BASE_URL', 'https://next.example/v1');
  state = change(snapshot, state, 'RESEARCH_MODEL_MODEL', '@cf/model-name');
  const payload = connectionFormPayload(snapshot, state);
  assert.equal(payload.values.RESEARCH_MODEL_API_KEY, 'fixture-next-provider-secret');
  assert.equal(payload.values.RESEARCH_MODEL_MODEL, '@cf/model-name');
  assert.deepEqual(payload.clear, []);
});

test('保存前切回原服务恢复旧配置且丢弃未保存的其他服务修改', () => {
  const snapshot = settings();
  let state = change(
    snapshot,
    createConnectionForm(),
    'RESEARCH_MODEL_PROVIDER',
    'openai_compatible',
  );
  state = change(snapshot, state, 'RESEARCH_MODEL_BASE_URL', 'https://draft.example');
  state = change(snapshot, state, 'RESEARCH_MODEL_API_KEY', 'fixture-other-vendor');
  state = change(snapshot, state, 'RESEARCH_MODEL_PROVIDER', 'deepseek');
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_BASE_URL').value, 'https://api.deepseek.com');
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_API_KEY').maskedValue, 'deep********tail');
  assert.deepEqual(connectionFormPayload(snapshot, state), { values: {}, clear: [] });
});

test('其他模型供应商清除通用密钥不会清除隐藏的 DeepSeek 密钥', () => {
  const snapshot = settings({ RESEARCH_MODEL_PROVIDER: { value: 'openai_compatible' } });
  const state = updateConnectionForm(snapshot, createConnectionForm(), {
    type: 'clear',
    key: 'RESEARCH_MODEL_API_KEY',
    checked: true,
  });
  assert.deepEqual(connectionFormPayload(snapshot, state).clear, ['RESEARCH_MODEL_API_KEY']);
  assert.equal(view(snapshot, state, 'RESEARCH_MODEL_API_KEY').configured, false);
});

test('网页和海关供应商切换同样联动默认值，回切不意外提交默认地址', () => {
  const snapshot = settings();
  let state = change(snapshot, createConnectionForm(), 'WEB_SEARCH_PROVIDER', 'http');
  state = change(snapshot, state, 'CUSTOMS_PROVIDER', 'http');
  assert.equal(view(snapshot, state, 'WEB_SEARCH_BASE_URL').value, '');
  assert.equal(view(snapshot, state, 'CUSTOMS_BASE_URL').value, '');
  assert.equal(view(snapshot, state, 'WEB_SEARCH_API_KEY').configured, false);
  assert.equal(connectionFormPayload(snapshot, state).clear.includes('TAVILY_API_KEY'), false);
  state = change(snapshot, state, 'WEB_SEARCH_PROVIDER', 'tavily');
  state = change(snapshot, state, 'CUSTOMS_PROVIDER', 'billofladingdata');
  assert.deepEqual(connectionFormPayload(snapshot, state), { values: {}, clear: [] });
});
