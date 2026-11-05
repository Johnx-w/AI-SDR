import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { release } from '../scripts/release.mjs';
import { waitForCI } from '../scripts/release-ci.mjs';

const revision = 'a'.repeat(40);
const ciRun = {
  id: 42,
  run_attempt: 2,
  path: '.github/workflows/ci.yml',
  event: 'push',
  head_sha: revision,
  head_repository: { full_name: 'Johnx-w/AI-SDR' },
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://github.com/Johnx-w/AI-SDR/actions/runs/42',
};
const ciJobs = {
  jobs: ['checks', 'release'].map((name) => ({ name, status: 'completed', conclusion: 'success' })),
};

function commands(t, conclusion = 'success') {
  const previous = process.env.npm_execpath;
  process.env.npm_execpath = 'fixture-npm-cli';
  t.after(() => {
    if (previous === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = previous;
  });
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (command === 'git') {
      if (args[0] === 'status') return '';
      if (args[0] === 'branch') return 'codex/test-release';
      if (args[0] === 'rev-parse') return revision;
      if (args[0] === 'ls-tree') return 'server/index.mjs';
    }
    if (command === 'tar' && args.includes('-xf')) {
      const source = args[args.indexOf('-C') + 1];
      mkdirSync(join(source, 'scripts'));
      writeFileSync(join(source, 'scripts', 'release-server.mjs'), '// archived server script');
      writeFileSync(args[args.indexOf('-xf') + 1], 'fixture archive');
    }
    if (command === 'gh') {
      const endpoint = args.at(-1);
      if (endpoint.includes('/actions/workflows/ci.yml/runs?'))
        return JSON.stringify({ workflow_runs: [{ ...ciRun, conclusion }] });
      if (endpoint.endsWith('/actions/runs/42/attempts/2/jobs?per_page=100'))
        return JSON.stringify(ciJobs);
      throw new Error('Unexpected GitHub request: ' + endpoint);
    }
    return '';
  };
  return { run, calls };
}

test('CI失败时发布必须停止，不上传发布包或调用云端部署', async (t) => {
  const h = commands(t, 'failure');
  await assert.rejects(release([], h.run), /CI.*未通过/);
  assert.equal(
    h.calls.some((call) => call.command === 'scp'),
    false,
  );
  assert.equal(
    h.calls.some((call) => call.command === 'ssh' && call.args.at(-1).includes(' - deploy ')),
    false,
  );
});

test('部署的提交必须与两个成功CI作业对应的提交一致，先检查再上传', async (t) => {
  const h = commands(t);
  await release([], h.run);
  const push = h.calls.findIndex((call) => call.command === 'git' && call.args[0] === 'push');
  const ci = h.calls.findIndex(
    (call) => call.command === 'gh' && call.args.at(-1).includes('/attempts/2/jobs'),
  );
  const upload = h.calls.findIndex((call) => call.command === 'scp');
  assert.ok(push >= 0 && ci > push && upload > ci);
  assert.equal(h.calls[push].args[2], `${revision}:refs/heads/codex/test-release`);
  const request = h.calls.find(
    (call) => call.command === 'gh' && call.args.at(-1).includes('/workflows/'),
  );
  assert.ok(request.args.at(-1).includes(`head_sha=${revision}`));
  const deploy = h.calls.find(
    (call) => call.command === 'ssh' && call.args.at(-1).includes(' - deploy '),
  );
  assert.ok(deploy.args.at(-1).includes(`deploy ${revision} `));
  assert.equal(deploy.options.input, '// archived server script');
});

test('等待CI期间本地HEAD变化时，停止上传和部署', async (t) => {
  const h = commands(t);
  let headReads = 0;
  await assert.rejects(
    release([], (command, args, options) => {
      const result = h.run(command, args, options);
      if (command === 'git' && args[0] === 'rev-parse' && ++headReads === 3) return 'b'.repeat(40);
      return result;
    }),
    /新提交/,
  );
  assert.equal(
    h.calls.some((call) => call.command === 'scp'),
    false,
  );
});

for (const failure of ['查询失败', '无效JSON']) {
  test(`${failure}时不能上传或部署`, async (t) => {
    const h = commands(t);
    await assert.rejects(
      release([], (command, args, options) => {
        if (command === 'gh') {
          if (failure === '查询失败') throw new Error('GitHub unavailable');
          return 'not json';
        }
        return h.run(command, args, options);
      }),
    );
    assert.equal(
      h.calls.some((call) => call.command === 'scp'),
      false,
    );
  });
}

test('只能放行同一提交最新一次push运行的两个必需作业', async () => {
  const requests = [];
  const result = await waitForCI(revision, (endpoint) => {
    requests.push(endpoint);
    return endpoint.includes('/workflows/') ? { workflow_runs: [ciRun] } : ciJobs;
  });
  assert.equal(result.html_url, ciRun.html_url);
  assert.ok(requests[0].includes(`event=push&head_sha=${revision}&per_page=1`));
  assert.ok(requests[1].includes('/runs/42/attempts/2/jobs?per_page=100'));
});

for (const [name, change] of [
  ['其他提交', { head_sha: 'b'.repeat(40) }],
  ['其他仓库', { head_repository: { full_name: 'someone/AI-SDR' } }],
  ['其他工作流', { path: '.github/workflows/other.yml' }],
  ['PR运行', { event: 'pull_request' }],
  ['失败', { conclusion: 'failure' }],
  ['取消', { conclusion: 'cancelled' }],
  ['跳过', { conclusion: 'skipped' }],
]) {
  test(`不能用${name}的运行放行，也不能退回更旧的成功运行`, async () => {
    await assert.rejects(
      waitForCI(revision, () => ({
        workflow_runs: [
          { ...ciRun, ...change },
          { ...ciRun, id: 41 },
        ],
      })),
    );
  });
}

for (const [name, jobs] of [
  ['缺少Linux发布测试', ciJobs.jobs.slice(0, 1)],
  ['Linux发布测试跳过', [ciJobs.jobs[0], { ...ciJobs.jobs[1], conclusion: 'skipped' }]],
  ['Windows检查失败', [{ ...ciJobs.jobs[0], conclusion: 'failure' }, ciJobs.jobs[1]]],
  ['必需作业未完成', [{ ...ciJobs.jobs[0], status: 'in_progress' }, ciJobs.jobs[1]]],
]) {
  test(`整体成功但${name}时仍拒绝发布`, async () => {
    await assert.rejects(
      waitForCI(revision, (endpoint) =>
        endpoint.includes('/workflows/') ? { workflow_runs: [ciRun] } : { jobs },
      ),
    );
  });
}

test('CI尚未创建或仍在执行时等待，成功后才放行', async () => {
  let polls = 0;
  let time = 0;
  const responses = [[], [{ ...ciRun, status: 'in_progress', conclusion: null }], [ciRun]];
  await waitForCI(
    revision,
    (endpoint) =>
      endpoint.includes('/workflows/') ? { workflow_runs: responses[polls++] } : ciJobs,
    {
      now: () => time,
      wait: async (duration) => {
        time += duration;
      },
    },
  );
  assert.equal(polls, 3);
  assert.equal(time, 20_000);
});

for (const runs of [[], [{ ...ciRun, status: 'queued', conclusion: null }]]) {
  test(`CI${runs.length ? '一直排队' : '一直未创建'}，20分钟超时后拒绝发布`, async () => {
    let time = 0;
    await assert.rejects(
      waitForCI(revision, () => ({ workflow_runs: runs }), {
        now: () => time,
        wait: async (duration) => {
          time += duration;
        },
      }),
      /超时/,
    );
    assert.equal(time, 20 * 60_000);
  });
}

test('GitHub查询报错直接失败，不继续轮询', async () => {
  await assert.rejects(
    waitForCI(
      revision,
      () => {
        throw new Error('GitHub unavailable');
      },
      {
        wait: async () => assert.fail('查询报错后不应等待重试'),
      },
    ),
    /GitHub unavailable/,
  );
});
