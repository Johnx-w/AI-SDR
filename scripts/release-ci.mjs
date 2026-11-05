import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const repository = 'Johnx-w/AI-SDR';

export async function waitForCI(revision, request, { now = Date.now, wait = setTimeout } = {}) {
  assert(/^[a-f0-9]{40}$/.test(revision), 'CI检查需要完整提交号');
  const deadline = now() + 20 * 60_000;
  while (now() < deadline) {
    const result = await request(
      `repos/${repository}/actions/workflows/ci.yml/runs?event=push&head_sha=${revision}&per_page=1`,
    );
    assert(Array.isArray(result.workflow_runs), 'CI运行查询结果无效');
    const run = result.workflow_runs[0];
    if (run) {
      assert(
        run.head_sha === revision &&
          run.head_repository?.full_name === repository &&
          run.path === '.github/workflows/ci.yml' &&
          run.event === 'push',
        'CI运行与目标提交、仓库或工作流不匹配',
      );
      if (run.status === 'completed') {
        assert.equal(run.conclusion, 'success', `CI未通过：${run.conclusion} ${run.html_url}`);
        assert(
          Number.isSafeInteger(run.id) && Number.isSafeInteger(run.run_attempt),
          'CI运行编号无效',
        );
        const { jobs } = await request(
          `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
        );
        assert(Array.isArray(jobs), 'CI作业查询结果无效');
        for (const name of ['checks', 'release']) {
          const matches = jobs.filter((job) => job.name === name);
          assert(
            matches.length === 1 &&
              matches[0].status === 'completed' &&
              matches[0].conclusion === 'success',
            `CI必需作业 ${name} 未通过：${run.html_url}`,
          );
        }
        return run;
      }
    }
    await wait(10_000);
  }
  assert.fail(`等待提交 ${revision} 的CI超时（20分钟），未上传或部署`);
}
