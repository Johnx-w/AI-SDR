import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectScraplingPage } from '../server/scrapling-collector.mjs';
import {
  chromiumExecutable,
  chromiumRevisionDirectory,
  chromiumVersion,
  verifyReleaseChromium,
} from '../server/scrapling-runtime.mjs';

const archive = fileURLToPath(new URL('../server/scrapling/runtime-linux.tar.gz', import.meta.url));
const directory = fileURLToPath(new URL('../server/scrapling/runtime-linux', import.meta.url));
const requireIsolation = process.argv.includes('--require-isolation');

if (requireIsolation) assert(existsSync(archive), '官网采集受限探测缺少发布运行时');

if (existsSync(archive)) {
  assert.equal(process.platform, 'linux', '官网采集发布运行时须在 Linux 上安装');
  const listing = (option) =>
    execFileSync('tar', [option, archive], { encoding: 'utf8' }).trim().split('\n');
  const entries = listing('-tzf');
  assert(entries.includes('worker'), '官网采集运行时缺少工作进程');
  const browser = 'browsers/' + chromiumRevisionDirectory;
  assert(entries.includes('browsers/' + chromiumExecutable), '官网采集运行时缺少浏览器');
  assert.equal(new Set(entries).size, entries.length, '官网采集运行时含重复文件');
  assert(
    entries.every((entry) => {
      if (entry === 'worker' || entry === 'browsers/') return true;
      return (
        entry.startsWith(browser + '/') &&
        entry
          .replace(/\/$/, '')
          .split('/')
          .every((part) => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..')
      );
    }),
    '官网采集运行时含意外路径',
  );
  assert(
    listing('-tvzf').every((entry) => entry.startsWith('-') || entry.startsWith('d')),
    '官网采集运行时只允许普通文件和目录',
  );
  mkdirSync(directory, { recursive: true });
  execFileSync('tar', ['--no-same-owner', '-xzf', archive, '-C', directory]);
  const browserDirectory = await verifyReleaseChromium(join(directory, 'browsers'));
  const checked = await collectScraplingPage('https://collection-health.example.org/', {
    python: null,
    offlineProbe: !requireIsolation,
    async readResourceImpl(_url, kind) {
      return kind === 'document'
        ? {
            status: 200,
            type: 'text/html',
            body: Buffer.from('<main>Loading...</main><script src="/health.js"></script>'),
          }
        : {
            status: 200,
            type: 'text/javascript',
            body: Buffer.from(
              'document.querySelector("main").innerText = "Scrapling release probe";',
            ),
          };
    },
  });
  assert.equal(
    checked.status,
    'ok',
    '官网采集发布运行时无法渲染固定页面：' + (checked.failure_reason || checked.status),
  );
  assert.match(checked.content, /Scrapling release probe/);
  assert.deepEqual(checked.versions, {
    python: '3.12.16',
    scrapling: '0.5.1',
    playwright: '1.65.2',
    chromium: chromiumVersion,
  });
  const cgroupLimit = checked.resources.cgroup_limit_bytes;
  if (requireIsolation) {
    assert.equal(cgroupLimit, 1073741824, '官网采集运行时未启用 1 GiB 硬限制');
    assert(checked.resources.cgroup_peak_bytes > 0, '官网采集未取得受限进程内存峰值');
  }
  console.log(
    '官网采集发布运行时已验证：' +
      JSON.stringify({
        ...checked.versions,
        browserDirectory,
        isolation: cgroupLimit ? 'delegated' : 'archive_only',
        ...(cgroupLimit ? { resources: checked.resources } : {}),
      }),
  );
}
