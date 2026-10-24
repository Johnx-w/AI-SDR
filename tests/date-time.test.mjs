import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { formatBeijingTime, formatBeijingText } from '../src/domain/date-time.mjs';

test('UTC、带时区时间和毫秒时间戳统一显示北京时间，省略秒及毫秒', () => {
  const expected = '2026年10月24日 18:42（北京时间）';
  for (const value of [
    '2026-10-24T10:42:50.234Z',
    '2026-10-24T18:42:50.234+08:00',
    Date.parse('2026-10-24T10:42:50.234Z'),
  ])
    assert.equal(formatBeijingTime(value), expected);
  assert.equal(formatBeijingTime('2026-10-24T18:42:50'), expected);
  assert.equal(formatBeijingTime(String(Date.parse('2026-10-24T10:42:50.234Z'))), expected);
});

test('跨日和午夜按北京时间处理，不出现24点或本机时区偏移', () => {
  assert.equal(formatBeijingTime('2026-10-24T16:00:00Z'), '2026年10月25日 00:00（北京时间）');
  const script = `import { formatBeijingTime } from ${JSON.stringify(new URL('../src/domain/date-time.mjs', import.meta.url).href)}; process.stdout.write(formatBeijingTime('2026-10-24T10:42:50.234Z'));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, TZ: 'America/Los_Angeles' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '2026年10月24日 18:42（北京时间）');
});

test('空值和无效时间使用给定文案，零毫秒仍为有效时间', () => {
  for (const value of [undefined, null, '', ' ', 'invalid', Number.NaN])
    assert.equal(formatBeijingTime(value, '未记录'), '未记录');
  assert.equal(formatBeijingTime(0), '1970年01月01日 08:00（北京时间）');
});

test('研究说明内的ISO时间转成人类可读时间，原始链接和日期保持可核对', () => {
  const original =
    '沿用 2026-10-22T06:05:36.566Z 的资料；评估于 2026-10-24T18:42:50+08:00。来源：https://buyer.example/2026-10-22T06:05:36.566Z 日期2026-10-22';
  const formatted = formatBeijingText(original);
  assert.match(formatted, /沿用 2026年10月22日 14:05（北京时间） 的资料/);
  assert.match(formatted, /评估于 2026年10月24日 18:42（北京时间）/);
  assert.ok(formatted.includes('https://buyer.example/2026-10-22T06:05:36.566Z'));
  assert.ok(formatted.includes('日期2026-10-22'));
  assert.ok(original.includes('2026-10-22T06:05:36.566Z'));
});
