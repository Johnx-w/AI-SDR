import test from 'node:test';
import assert from 'node:assert/strict';
import { LeadPerformance } from '../server/lead-performance.mjs';

test('接口指标区分未采样、累计平均值、错误数与有界窗口P95', () => {
  const metrics = new LeadPerformance({ sampleLimit: 20 });
  assert.deepEqual(metrics.snapshot().detail, {
    count: 0,
    errors: 0,
    lastMs: null,
    averageMs: null,
    p95Ms: null,
    maxMs: null,
    lastBytes: null,
    sampleCount: 0,
  });
  metrics.record('list', { durationMs: 1000, bytes: 2000, error: true });
  for (let durationMs = 1; durationMs <= 20; durationMs++)
    metrics.record('list', { durationMs, bytes: 500 });
  const list = metrics.snapshot().list;
  assert.equal(list.count, 21);
  assert.equal(list.errors, 1);
  assert.equal(list.lastMs, 20);
  assert.equal(list.averageMs, 57.62);
  assert.equal(list.p95Ms, 19);
  assert.equal(list.maxMs, 1000);
  assert.equal(list.lastBytes, 500);
  assert.equal(list.sampleCount, 20);
  assert.equal(metrics.snapshot().detail.count, 0);
  list.count = -1;
  assert.equal(metrics.snapshot().list.count, 21);
});

test('指标只接受固定操作与有效数值，不收集客户标识或错误正文', () => {
  const metrics = new LeadPerformance();
  assert.throws(() => metrics.record('customer-secret', { durationMs: 1 }));
  for (const durationMs of [-1, NaN, Infinity])
    assert.throws(() => metrics.record('list', { durationMs }));
  metrics.record('refresh', { durationMs: 1.2345, error: true, message: 'private secret' });
  assert.equal(metrics.snapshot().refresh.lastMs, 1.23);
  assert.doesNotMatch(JSON.stringify(metrics.snapshot()), /private|secret|message/);
});
