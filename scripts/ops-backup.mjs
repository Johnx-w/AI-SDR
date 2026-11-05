import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

export async function copyData(source, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  const files = [];
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      files.push(
        ...(await copyData(from, to)).map((file) => ({
          ...file,
          path: `${entry.name}/${file.path}`,
        })),
      );
      continue;
    }
    assert(entry.isFile(), '备份源出现非普通文件，需要人工核对');
    if (/-(wal|shm|journal)$/.test(entry.name)) continue;
    if (entry.name.endsWith('.sqlite')) {
      const db = new DatabaseSync(from, { readOnly: true, timeout: 5000 });
      try {
        await backup(db, to);
      } finally {
        db.close();
      }
      const restored = new DatabaseSync(to);
      try {
        assert.deepEqual(
          restored
            .prepare('PRAGMA integrity_check')
            .all()
            .map((row) => row.integrity_check),
          ['ok'],
        );
        assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length, 0);
        restored.exec('PRAGMA journal_mode=DELETE');
      } finally {
        restored.close();
      }
    } else {
      const before = digest(from);
      copyFileSync(from, to);
      assert.equal(digest(to), before, '备份期间配置发生变化，请重试');
      assert.equal(digest(from), before, '备份期间配置发生变化，请重试');
    }
    files.push({ path: entry.name, sha256: digest(to), sqlite: entry.name.endsWith('.sqlite') });
  }
  return files;
}

export async function createBackup() {
  process.umask(0o077);
  const root = '/var/backups/shadeflow';
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(root, '.staging-'));
  const startedAt = new Date().toISOString();
  const name = `backup-${startedAt.replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
  try {
    const files = await copyData('/srv/shadeflow/app/.data', join(stage, '.data'));
    for (const file of files.filter((file) => !file.sqlite)) {
      assert.equal(
        digest(join('/srv/shadeflow/app/.data', file.path)),
        file.sha256,
        '备份期间配置发生变化，请重试',
      );
    }
    for (const name of ['.env', '.env.local']) {
      const source = join('/srv/shadeflow/app', name);
      if (existsSync(source)) {
        copyFileSync(source, join(stage, name));
        assert.equal(digest(source), digest(join(stage, name)), '备份期间环境配置发生变化');
      }
    }
    writeFileSync(
      join(stage, 'shadeflow.service.txt'),
      execFileSync('systemctl', ['cat', 'shadeflow.service']),
    );
    copyFileSync('/srv/shadeflow/release-state.json', join(stage, 'release-state.json'));
    const manifest = {
      startedAt,
      completedAt: new Date().toISOString(),
      release: realpathSync('/srv/shadeflow/current'),
      consistency: '每个 SQLite 数据库独立一致；多个数据库不构成同一全局事务快照',
      files,
    };
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const archive = join(root, `${name}.tar.gz`);
    execFileSync('tar', ['-czf', `${archive}.partial`, '-C', stage, '.'], { timeout: 300000 });
    renameSync(`${archive}.partial`, archive);
    const result = { ...manifest, archive, sha256: digest(archive) };
    writeFileSync(join(root, `${name}.json`), JSON.stringify(result, null, 2));
    writeFileSync(join(root, 'latest.json.tmp'), JSON.stringify(result, null, 2));
    renameSync(join(root, 'latest.json.tmp'), join(root, 'latest.json'));
    return result;
  } finally {
    assert.equal(dirname(realpathSync(stage)), realpathSync(root));
    rmSync(stage, { recursive: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  createBackup().then(
    ({ archive, completedAt, files }) =>
      console.log(JSON.stringify({ archive, completedAt, files: files.length })),
    () => {
      console.error('SHADEFLOW_BACKUP_FAILED：请核对目录权限、磁盘和数据库；未更新 latest.json');
      process.exitCode = 1;
    },
  );
}
