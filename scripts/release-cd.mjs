import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForCI } from './release-ci.mjs';

export function cdRevision(event) {
  const run = event.workflow_run;
  assert(
    run &&
      run.head_branch === 'main' &&
      run.event === 'push' &&
      run.conclusion === 'success' &&
      run.head_repository?.full_name === 'Johnx-w/AI-SDR' &&
      /^[a-f0-9]{40}$/.test(run.head_sha),
    'CD只接受本仓库main的成功push CI',
  );
  return run.head_sha;
}

async function main() {
  const revision = cdRevision(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  assert.equal(git('rev-parse', 'HEAD'), revision, '构建源码与通过CI的提交不一致');
  const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' }));
  await waitForCI(revision, api);
  if (api('repos/Johnx-w/AI-SDR/git/ref/heads/main').object.sha !== revision) {
    console.log('跳过已过时的main提交：' + revision);
    return;
  }
  const temporary = mkdtempSync(join(tmpdir(), 'shadeflow-cd-'));
  try {
    const archive = join(temporary, 'release.tar');
    execFileSync('git', ['archive', '--format=tar', '--output', archive, revision]);
    execFileSync('tar', ['-rf', archive, 'dist']);
    const bytes = readFileSync(archive);
    const digest = createHash('sha256').update(bytes).digest('hex');
    execFileSync(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=15',
        'ai-sdr-cd',
        `deploy ${revision} ${digest}`,
      ],
      { input: bytes, stdio: ['pipe', 'inherit', 'inherit'], timeout: 25 * 60_000 },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
