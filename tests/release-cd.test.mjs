import test from 'node:test';
import assert from 'node:assert/strict';
import { withMaintenance } from '../scripts/release-server.mjs';
import { deploymentCommand } from '../scripts/cd-gateway.mjs';
import { cdRevision } from '../scripts/release-cd.mjs';

test('CD仅接受本仓库main成功push的完整提交，部署密钥不接受任意SSH命令', () => {
  const revision = 'a'.repeat(40),
    digest = 'b'.repeat(64);
  const run = {
    head_sha: revision,
    head_branch: 'main',
    event: 'push',
    conclusion: 'success',
    head_repository: { full_name: 'Johnx-w/AI-SDR' },
  };
  assert.equal(cdRevision({ workflow_run: run }), revision);
  for (const change of [
    { head_branch: 'feature' },
    { event: 'pull_request' },
    { conclusion: 'failure' },
    { head_sha: 'main' },
    { head_repository: { full_name: 'fork/AI-SDR' } },
  ])
    assert.throws(() => cdRevision({ workflow_run: { ...run, ...change } }));
  assert.deepEqual(deploymentCommand(`deploy ${revision} ${digest}`), { revision, digest });
  for (const command of [
    'sh',
    `deploy ${revision} ${digest};id`,
    `deploy main ${digest}`,
    `deploy ${revision} ${digest}\nwhoami`,
  ])
    assert.throws(() => deploymentCommand(command));
});

const state = (count) => ({
  version: 1,
  enabled: true,
  quiet: count === 0,
  pending: { requests: count },
});
test('维护等待已有任务结束后发布，成功解除维护', async () => {
  const events = [],
    statuses = [state(1), state(0)];
  await withMaintenance({
    enter: () => events.push('enter'),
    leave: () => events.push('leave'),
    status: async () => statuses.shift(),
    wait: async () => events.push('wait'),
    deploy: () => events.push('deploy'),
    verifyCurrent: () => assert.fail('不应回退'),
  });
  assert.deepEqual(events, ['enter', 'wait', 'deploy', 'leave']);
});

test('10分钟超时不停止服务或改计划，解除维护并将本次发布标失败', async () => {
  let clock = 0,
    left = false;
  await assert.rejects(
    withMaintenance({
      enter: () => {},
      leave: () => {
        left = true;
      },
      status: async () => state(1),
      now: () => clock,
      wait: async () => {
        clock += 600_000;
      },
      deploy: () => assert.fail('超时不能部署'),
      verifyCurrent: async () => {},
    }),
    /超过10分钟/,
  );
  assert.equal(left, true);
});

for (const recovered of [true, false])
  test(`发布失败后的维护状态：原版本${recovered ? '健康则解除' : '不健康则保留'}`, async () => {
    let left = false;
    await assert.rejects(
      withMaintenance({
        enter: () => {},
        leave: () => {
          left = true;
        },
        status: async () => state(0),
        deploy: () => {
          throw Error('deploy failed');
        },
        verifyCurrent: () => {
          if (!recovered) throw Error('recovery failed');
        },
      }),
      /deploy failed/,
    );
    assert.equal(left, recovered);
  });

test('无维护能力、缺失在途状态和伪空闲响应都拒绝停机', async () => {
  for (const response of [
    {},
    { ...state(1), quiet: true },
    { ...state(0), pending: { requests: -1 } },
  ]) {
    let left = false;
    await assert.rejects(
      withMaintenance({
        enter: () => {},
        leave: () => {
          left = true;
        },
        status: async () => response,
        deploy: () => assert.fail('无有效状态不能部署'),
        verifyCurrent: async () => {},
      }),
    );
    assert.equal(left, true);
  }
});
