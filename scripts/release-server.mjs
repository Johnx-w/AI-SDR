import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = '/srv/shadeflow';
const service = 'shadeflow.service';
const base = 'http://127.0.0.1:14311';
const dropIn = '/etc/systemd/system/shadeflow.service.d/release.conf';
const dropInText = '[Service]\nWorkingDirectory=/srv/shadeflow/current\n';
const exec = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });

function writeJson(path, value) {
  const temporary = path + '.' + randomUUID();
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}

function pointCurrent(directory, target) {
  const temporary = join(directory, '.current-' + randomUUID());
  symlinkSync(target, temporary, 'dir');
  renameSync(temporary, join(directory, 'current'));
}

export function assertReleasePath(directory, path) {
  assert(
    path === join(directory, 'app') ||
      (resolve(path, '..') === join(directory, 'releases') &&
        /^[a-f0-9]{40}$/.test(basename(path))),
    '拒绝操作发布目录以外的路径',
  );
  assert(
    lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
    '版本目录必须是实际目录',
  );
}

export function assertQuiet({ jobs, schedules, campaigns, deliveryStats }) {
  assert(
    Array.isArray(jobs) && Array.isArray(schedules) && Array.isArray(campaigns),
    '任务状态响应不完整',
  );
  assert(
    !jobs.some((row) => ['running', 'stopping'].includes(row.status)),
    '请等待正在执行的获客任务结束',
  );
  assert(!schedules.some((row) => row.status === 'enabled'), '请先暂停自动获客计划');
  assert(
    !campaigns.some((row) => ['active', 'preparing'].includes(row.status)),
    '请先暂停发信计划并等待准备完成',
  );
  assert(deliveryStats && deliveryStats.sending === 0, '请等待正在发送的邮件完成');
}

export function validateArchiveEntries(entries) {
  for (const name of entries) {
    const parts = name.replace(/\/$/, '').split('/');
    assert(
      name && !name.startsWith('/') && !name.includes('\\') && !parts.includes('..'),
      '发布包包含无效路径',
    );
    assert(!['.git', '.data', 'node_modules'].includes(parts[0]), '发布包不能包含数据或本地依赖');
    assert(
      !parts.some((part) => part.startsWith('.env') && part !== '.env.example'),
      '发布包不能包含环境配置',
    );
  }
}

export async function activateRelease({
  directory,
  candidate,
  stop,
  backup,
  configure,
  start,
  verify,
}) {
  const current = join(directory, 'current');
  if (existsSync(current)) assert(lstatSync(current).isSymbolicLink(), 'current 必须是版本链接');
  const previous = existsSync(current) ? realpathSync(current) : join(directory, 'app');
  assertReleasePath(directory, previous);
  assertReleasePath(directory, candidate);
  assert(previous !== candidate, '该版本已经运行，无需重复切换');
  await stop();
  try {
    const backupPath = await backup();
    await configure();
    pointCurrent(directory, candidate);
    await start();
    await verify(candidate);
    const state = {
      current: candidate,
      previous,
      backup: backupPath,
      at: new Date().toISOString(),
    };
    writeJson(join(directory, 'release-state.json'), state);
    return state;
  } catch (error) {
    try {
      await stop();
      pointCurrent(directory, previous);
      await start();
      await verify(previous);
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `发布和自动回退均失败；保留版本 ${previous}，请检查服务日志`,
      );
    }
    throw new Error(`发布失败，已恢复原版本 ${previous}；业务数据未回滚：${error.message}`, {
      cause: error,
    });
  }
}

async function getJson(path) {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(5000) });
  assert(response.ok, `${path} 返回 ${response.status}`);
  return response.json();
}

async function checkQuiet() {
  const [jobs, schedules, outreach] = await Promise.all([
    getJson('/api/v1/acquisition/jobs'),
    getJson('/api/v1/acquisition/schedules'),
    getJson('/api/v1/outreach/state'),
  ]);
  assertQuiet({ ...jobs, ...schedules, ...outreach });
}

async function verify(candidate) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      assert.equal(exec('systemctl', ['is-active', service]).trim(), 'active');
      const pid = exec('systemctl', ['show', service, '-p', 'MainPID', '--value']).trim();
      assert.equal(realpathSync(`/proc/${pid}/cwd`), candidate, '服务运行目录与发布版本不一致');
      assert.equal((await getJson('/api/health')).ok, true);
      const page = await fetch(base, { signal: AbortSignal.timeout(2000) });
      assert(page.ok && (await page.text()).includes('id="root"'), '网页构建未正常提供');
      return;
    } catch (error) {
      lastError = error;
    }
    await delay(1000);
  }
  throw lastError;
}

function snapshot() {
  const path = join(
    root,
    'backups',
    new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8),
  );
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const files = [
    '.data',
    ...['.env', '.env.local'].filter((name) => existsSync(join(root, 'app', name))),
  ];
  exec('tar', ['-czf', join(path, 'data-and-config.tar.gz'), '-C', join(root, 'app'), ...files]);
  chmodSync(join(path, 'data-and-config.tar.gz'), 0o600);
  writeFileSync(join(path, 'service.txt'), exec('systemctl', ['cat', service]), { mode: 0o600 });
  if (existsSync(join(root, 'release-state.json')))
    copyFileSync(join(root, 'release-state.json'), join(path, 'release-state.json'));
  return path;
}

function configure() {
  if (!existsSync(dropIn)) {
    mkdirSync(resolve(dropIn, '..'), { recursive: true });
    writeFileSync(dropIn, dropInText, { mode: 0o644, flag: 'wx' });
  }
  exec('systemctl', ['daemon-reload']);
}

function checkLayout() {
  assert.equal(process.platform, 'linux', '服务器发布脚本仅支持当前 Linux/systemd 部署');
  assert.equal(process.getuid(), 0, '发布需要管理 shadeflow.service 的权限');
  assert.equal(realpathSync(root), root, '服务器根目录不符合预期');
  assert(
    !lstatSync(join(root, 'app', '.data')).isSymbolicLink(),
    '请先确认自定义数据目录的备份方式',
  );
  if (existsSync(dropIn))
    assert.equal(readFileSync(dropIn, 'utf8'), dropInText, '存在其他发布配置，停止覆盖');
  const working = exec('systemctl', ['show', service, '-p', 'WorkingDirectory', '--value']).trim();
  assert(
    [join(root, 'app'), join(root, 'current')].includes(working),
    '服务目录不符合当前发布约定',
  );
  assert.equal(
    exec('systemctl', ['show', service, '-p', 'User', '--value']).trim(),
    'shadeflow',
    '服务运行用户不符合发布约定',
  );
  assert(
    exec('systemctl', ['show', service, '-p', 'ExecStart', '--value']).includes(
      'argv[]=/usr/local/bin/node --env-file-if-exists=.env server/index.mjs ;',
    ),
    '服务启动命令已变化，请先调整发布脚本',
  );
  const envPath = join(root, 'app', '.env');
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const pid = exec('systemctl', ['show', service, '-p', 'MainPID', '--value']).trim();
  if (pid !== '0') {
    for (const entry of readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean)) {
      const split = entry.indexOf('=');
      env[entry.slice(0, split)] = entry.slice(split + 1);
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (
      !value ||
      !/(?:_DB_PATH|_DATA_DIR|CONNECTIONS_PATH|SCHEDULE_DB_PATH|BRANDING_CACHE_PATH|JOURNAL_PATH)$/.test(
        key,
      )
    )
      continue;
    const path = resolve(join(root, 'app'), value);
    const data = join(root, 'app', '.data');
    assert(
      path === data || path.startsWith(data + '/'),
      `${key} 使用独立存储路径，请先补充对应备份方案`,
    );
  }
}

async function main([mode, revision, digest, upload]) {
  checkLayout();
  if (mode === 'check') {
    await checkQuiet();
    const candidate = existsSync(join(root, 'current'))
      ? realpathSync(join(root, 'current'))
      : join(root, 'app');
    await verify(candidate);
    console.log(
      JSON.stringify({
        healthy: true,
        current: candidate,
        data: join(root, 'app', '.data'),
        port: 14311,
      }),
    );
    return;
  }
  assert(['deploy', 'rollback'].includes(mode), '无效发布操作');
  const lock = join(root, '.release-lock');
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, 'pid'), String(process.pid));
  try {
    let candidate;
    if (mode === 'deploy') {
      assert(/^[a-f0-9]{40}$/.test(revision) && /^[a-f0-9]{64}$/.test(digest), '无效版本或校验值');
      assert(/^[a-f0-9-]+\.tar$/.test(upload), '无效上传文件名');
      const archive = join(root, 'incoming', upload);
      assert.equal(
        createHash('sha256').update(readFileSync(archive)).digest('hex'),
        digest,
        '发布包校验失败',
      );
      validateArchiveEntries(exec('tar', ['-tf', archive]).trim().split('\n'));
      assert(
        exec('tar', ['-tvf', archive])
          .trim()
          .split('\n')
          .every((line) => ['-', 'd'].includes(line[0])),
        '发布包只允许普通文件和目录',
      );
      candidate = join(root, 'releases', revision);
      if (existsSync(candidate)) {
        assertReleasePath(root, candidate);
        assert.equal(readFileSync(join(candidate, '.release-revision'), 'utf8'), revision);
      } else {
        const staging = join(root, 'releases', '.staging-' + randomUUID());
        mkdirSync(staging, { recursive: true });
        try {
          exec('tar', ['--no-same-owner', '-xf', archive, '-C', staging]);
          exec('chown', ['-R', 'shadeflow:shadeflow', staging]);
          console.log('在独立版本目录安装生产依赖');
          exec('runuser', ['-u', 'shadeflow', '--', 'npm', 'ci', '--omit=dev'], {
            cwd: staging,
            stdio: 'inherit',
          });
          assert(existsSync(join(staging, 'dist', 'index.html')), '发布包缺少前端构建');
          symlinkSync(join(root, 'app', '.data'), join(staging, '.data'), 'dir');
          symlinkSync(join(root, 'app', '.env'), join(staging, '.env'), 'file');
          symlinkSync(join(root, 'app', '.env.local'), join(staging, '.env.local'), 'file');
          writeFileSync(join(staging, '.release-revision'), revision);
          renameSync(staging, candidate);
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
      }
      rmSync(archive);
      if (existsSync(join(root, 'current')) && realpathSync(join(root, 'current')) === candidate) {
        await verify(candidate);
        console.log('该提交已在云端正常运行，无需重复切换');
        return;
      }
      await checkQuiet();
    } else {
      candidate = JSON.parse(readFileSync(join(root, 'release-state.json'), 'utf8')).previous;
      assert(candidate, '尚无可回退版本');
      let healthy = false;
      try {
        healthy = (await getJson('/api/health')).ok === true;
      } catch {}
      if (healthy) await checkQuiet();
    }
    const state = await activateRelease({
      directory: root,
      candidate,
      stop: () => exec('systemctl', ['stop', service]),
      backup: snapshot,
      configure,
      start: () => exec('systemctl', ['start', service]),
      verify,
    });
    console.log(JSON.stringify(state));
  } finally {
    rmSync(lock, { recursive: true });
  }
}

if (
  process.argv[1] === '-' ||
  (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    if (error instanceof AggregateError)
      for (const cause of error.errors) console.error(cause.message);
    process.exitCode = 1;
  });
}
