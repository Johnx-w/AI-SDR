import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = (name) =>
  readFileSync(new URL('../src/pages/' + name + '.tsx', import.meta.url), 'utf8');

test('海关入口使用明确业务名称，保留 customs/dual 渠道而非更改发现逻辑', () => {
  const source = page('Automation');
  assert.ok(source.includes('海关记录找买家'));
  assert.ok(source.includes("'customs'"));
  assert.ok(source.includes("'dual'"));
});

test('设置页不重复展示使用地址或已删除的教程与保存区提示', () => {
  const source = page('ApiConnections');
  assert.equal(source.includes('API Key / Usage'), false);
  assert.equal(source.includes('当前使用：'), false);
  assert.equal(source.includes('可使用 DeepSeek 或 OpenAI 兼容服务'), false);
  assert.equal(source.includes('“已填写”表示配置齐备，实际连接结果以任务记录为准。'), false);
  assert.equal(source.includes('有未结束的任务时，需先完成或核对任务再修改连接。'), false);
});

test('沟通中心两个页面状态删除指定标题文案，保留访问验证和测试范围', () => {
  const source = page('RealCommunication');
  assert.equal(source.includes('真实测试邮箱的邮件会话、人工回信与 Agent 状态'), false);
  assert.equal(source.includes('TEST ONLY · 仅公司测试邮箱'), false);
  assert.ok(source.includes('解锁沟通中心'));
  assert.ok(source.includes('getMailOperatorToken'));
  assert.ok(source.includes("status?.mode === 'test_only'"));
});
