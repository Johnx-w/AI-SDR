import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  activateRelease,
  assertQuiet,
  validateArchiveEntries,
} from '../scripts/release-server.mjs';

test('Git保留历史文档，云端发布包排除归档并保留运行依赖的现行文档', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shadeflow-archive-test-'));
  const git = (...args) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true }).trim();
  try {
    mkdirSync(join(directory, 'docs', 'archive'), { recursive: true });
    writeFileSync(
      join(directory, '.gitattributes'),
      readFileSync(new URL('../.gitattributes', import.meta.url)),
    );
    writeFileSync(join(directory, 'docs', 'archive', 'old-design.md'), 'historical');
    writeFileSync(
      join(directory, 'docs', 'new-feishu-bitable-filling-spec.md'),
      'runtime templates',
    );
    writeFileSync(join(directory, 'AGENTS.md'), 'current instructions');
    git('init', '--quiet');
    git('-c', 'core.autocrlf=false', 'add', '.');
    const tree = git('write-tree');
    assert.match(git('ls-tree', '-r', '--name-only', tree), /docs\/archive\/old-design\.md/);
    const archive = join(directory, 'release.tar');
    git('archive', '--format=tar', '--output', archive, tree);
    const entries = execFileSync('tar', ['-tf', archive], {
      encoding: 'utf8',
      windowsHide: true,
    }).split(/\r?\n/);
    assert.equal(
      entries.some((entry) => entry.startsWith('docs/archive/')),
      false,
    );
    assert.ok(entries.includes('docs/new-feishu-bitable-filling-spec.md'));
    assert.ok(entries.includes('AGENTS.md'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('发布拒绝运行中的任务、自动计划和发信，允许已暂停或结束的任务', () => {
  const quiet = {
    jobs: [{ status: 'paused' }],
    schedules: [{ status: 'closed' }],
    campaigns: [{ status: 'completed' }],
    deliveryStats: { sending: 0 },
  };
  assert.doesNotThrow(() => assertQuiet(quiet));
  for (const change of [
    { jobs: [{ status: 'running' }] },
    { schedules: [{ status: 'enabled' }] },
    { campaigns: [{ status: 'preparing' }] },
    { campaigns: [{ status: 'active' }] },
    { deliveryStats: { sending: 1 } },
    { followUpStats: { sending: 1, active: 0 } },
    { followUpStats: { sending: 0, active: 2 } },
  ])
    assert.throws(() => assertQuiet({ ...quiet, ...change }));
  assert.throws(() => assertQuiet({}));
});

test('发布包拒绝云端数据、环境配置和越界路径', () => {
  assert.doesNotThrow(() =>
    validateArchiveEntries(['server/index.mjs', '.env.example', 'dist/', 'dist/index.html']),
  );
  for (const entry of [
    '.data/leads.sqlite',
    '.env',
    '.env.production',
    'node_modules/x',
    '.git/config',
    '../.env',
    '/root/key',
    'server/../../x',
  ]) {
    assert.throws(() => validateArchiveEntries([entry]), entry);
  }
});

for (const failure of [null, 'backup', 'start', 'verify']) {
  test(
    `Linux 发布切换与失败回退保留最新数据及配置：${failure || '成功'}`,
    { skip: process.platform !== 'linux' },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'shadeflow-deploy-test-'));
      const original = join(directory, 'app');
      const candidate = join(directory, 'releases', 'a'.repeat(40));
      mkdirSync(join(original, '.data'), { recursive: true });
      mkdirSync(candidate, { recursive: true });
      writeFileSync(join(original, '.env'), 'SERVER_ONLY=true');
      const data = join(original, '.data', 'state');
      writeFileSync(data, 'original');
      const events = [];
      let starts = 0;
      const perform = () =>
        activateRelease({
          directory,
          candidate,
          stop: () => events.push('stop'),
          backup: () => {
            events.push('backup');
            if (failure === 'backup') throw Error('backup failed');
            return 'backup-path';
          },
          configure: () => events.push('configure'),
          start: () => {
            events.push('start');
            starts++;
            if (starts === 1 && failure === 'start') throw Error('start failed');
          },
          verify: (path) => {
            events.push('verify');
            if (path === candidate) {
              writeFileSync(data, 'new business record');
              if (failure === 'verify') throw Error('health failed');
            }
          },
        });
      try {
        if (failure) await assert.rejects(perform, /已恢复原版本/);
        else await perform();
        assert.equal(realpathSync(join(directory, 'current')), failure ? original : candidate);
        assert.equal(readFileSync(join(original, '.env'), 'utf8'), 'SERVER_ONLY=true');
        assert.equal(
          readFileSync(data, 'utf8'),
          !failure || failure === 'verify' ? 'new business record' : 'original',
        );
        assert.deepEqual(events.slice(0, 2), ['stop', 'backup']);
        if (!failure) {
          const state = JSON.parse(readFileSync(join(directory, 'release-state.json'), 'utf8'));
          assert.equal(state.previous, original);
          assert.equal(state.current, candidate);
          await activateRelease({
            directory,
            candidate: state.previous,
            stop: () => {},
            backup: () => 'rollback-backup',
            configure: () => {},
            start: () => {},
            verify: (path) => assert.equal(path, original),
          });
          assert.equal(realpathSync(join(directory, 'current')), original);
          assert.equal(readFileSync(data, 'utf8'), 'new business record');
          assert.equal(readFileSync(join(original, '.env'), 'utf8'), 'SERVER_ONLY=true');
          const rolledBack = JSON.parse(
            readFileSync(join(directory, 'release-state.json'), 'utf8'),
          );
          assert.equal(rolledBack.previous, candidate);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
}
