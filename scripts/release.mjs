import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArchiveEntries } from './release-server.mjs';
import { waitForCI } from './release-ci.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const host = 'ai-sdr';
// Windows bsdtar otherwise decodes Git's UTF-8 filenames using the system code page.
const tarOptions = process.platform === 'win32' ? ['--options', 'hdrcharset=UTF-8'] : [];

function runCommand(command, args, { cwd = project, input, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: [input ? 'pipe' : 'ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} 执行失败，后续步骤未执行`);
  return capture ? result.stdout.trim() : '';
}

export async function release(args = process.argv.slice(2), run = runCommand) {
  const remote = (
    args,
    script = readFileSync(join(project, 'scripts', 'release-server.mjs'), 'utf8'),
  ) =>
    run('ssh', ['-o', 'BatchMode=yes', host, 'node --input-type=module - ' + args.join(' ')], {
      input: script,
    });
  const [mode = 'deploy', ...extra] = args;
  assert(
    ['deploy', 'check', 'rollback'].includes(mode) && !extra.length,
    '用法：npm run release / release:check / release:rollback',
  );
  if (mode !== 'deploy') return remote([mode]);
  const git = (...args) => run('git', args, { capture: true });
  assert.equal(
    git('status', '--porcelain'),
    '',
    '请先提交本次代码修改；发布不会自动暂存或上传未提交文件',
  );
  const branch = git('branch', '--show-current');
  assert(branch, '请先建立功能分支，不能从 detached HEAD 发布');
  const revision = git('rev-parse', 'HEAD');
  assert(/^[a-f0-9]{40}$/.test(revision));
  validateArchiveEntries(
    git('ls-tree', '-rz', '--name-only', revision).split('\0').filter(Boolean),
  );
  remote(['check']);
  const temporary = mkdtempSync(join(tmpdir(), 'shadeflow-release-'));
  try {
    const source = join(temporary, 'source');
    mkdirSync(source);
    const archive = join(temporary, 'release.tar');
    run('git', ['archive', '--format=tar', '--output', archive, revision]);
    run('tar', [...tarOptions, '-xf', archive, '-C', source]);
    const npm = process.env.npm_execpath;
    assert(npm, '请通过 npm run release 执行发布');
    console.log(`检查已提交版本 ${revision}；本地开发目录不参与构建`);
    for (const args of [['ci'], ['run', 'format:check'], ['test'], ['run', 'build']]) {
      run(process.execPath, [npm, ...args], { cwd: source });
    }
    run('tar', [...tarOptions, '-rf', archive, '-C', source, 'dist']);
    assert.equal(git('rev-parse', 'HEAD'), revision, '检查期间分支已产生新提交，请重新发布');
    run('git', ['push', 'origin', `${revision}:refs/heads/${branch}`]);
    console.log(`等待 GitHub CI 通过：${revision}`);
    const ci = await waitForCI(revision, (endpoint) =>
      JSON.parse(run('gh', ['api', '--hostname', 'github.com', endpoint], { capture: true })),
    );
    console.log(`CI 已通过：${ci.html_url}`);
    assert.equal(git('rev-parse', 'HEAD'), revision, '等待CI期间分支已产生新提交，请重新发布');
    const upload = randomUUID() + '.tar';
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    run('ssh', ['-o', 'BatchMode=yes', host, 'install -d -m 700 /srv/shadeflow/incoming']);
    run('scp', ['-o', 'BatchMode=yes', archive, `${host}:/srv/shadeflow/incoming/${upload}`]);
    remote(
      ['deploy', revision, digest, upload],
      readFileSync(join(source, 'scripts', 'release-server.mjs'), 'utf8'),
    );
    console.log(
      `发布完成：${revision}\nGitHub：${branch}\n云端数据仍位于 /srv/shadeflow/app/.data`,
    );
  } finally {
    assert(temporary.startsWith(join(tmpdir(), 'shadeflow-release-')));
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  release().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
