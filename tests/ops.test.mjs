import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configurationHashes, copyData, digest } from '../scripts/ops-backup.mjs';
import {
  backupStatus,
  cloudBackupPending,
  notifyChanges,
  retryServiceCheck,
} from '../scripts/ops-monitor.mjs';

test('online backup includes committed WAL data, excludes uncommitted data and preserves credentials', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'shadeflow-ops-test-'));
  const source = join(root, 'source');
  const copy = join(root, 'copy');
  mkdirSync(source);
  writeFileSync(join(source, '.credential-key'), 'test-key');
  const db = new DatabaseSync(join(source, 'test.sqlite'));
  t.after(() => db.close());
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE events(id INTEGER PRIMARY KEY); INSERT INTO events VALUES(1); BEGIN; INSERT INTO events VALUES(2);',
  );
  const manifest = await copyData(source, copy);
  const restored = new DatabaseSync(join(copy, 'test.sqlite'), { readOnly: true });
  t.after(() => restored.close());
  assert.equal(restored.prepare('SELECT count(*) AS n FROM events').get().n, 1);
  assert.equal(readFileSync(join(copy, '.credential-key'), 'utf8'), 'test-key');
  assert.equal(manifest.filter((file) => file.sqlite).length, 1);
  assert(!readdirSync(copy).some((name) => /-(wal|shm)$/.test(name)));
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM events').get().n, 1);
});

test('backup manifest records hashes for every copied configuration file', (t) => {
  const stage = mkdtempSync(join(tmpdir(), 'shadeflow-ops-config-test-'));
  t.after(() => rmSync(stage, { recursive: true }));
  writeFileSync(join(stage, '.env'), 'a=1');
  writeFileSync(join(stage, 'shadeflow.service.txt'), 'service');
  assert.throws(() => configurationHashes(stage));
  writeFileSync(join(stage, 'release-state.json'), '{}');
  const hashes = configurationHashes(stage);
  assert.deepEqual(Object.keys(hashes).sort(), [
    '.env',
    'release-state.json',
    'shadeflow.service.txt',
  ]);
  for (const [name, hash] of Object.entries(hashes)) assert.equal(hash, digest(join(stage, name)));
});

const filters = (id, source, excluded = '') =>
  `time="2026-11-05T05:15:00+08:00" msg="first target item [${source}], include filter : [], exclude filter : [${excluded}]" tskid=${id}`;
const start = (id) => `time="2026-11-05T05:14:59+08:00" msg="lock id is test" tskid=${id}`;
const success = (id) =>
  `time="2026-11-05T05:44:00+08:00" msg="FULL backup completed successfully, snapshot: test" tskid=${id}`;

test('backup coverage binds filters to the successful job and respects path boundaries', () => {
  const log = `${filters('a', '/', '/srv/ /proc/')}\n${success('a')}`;
  assert.equal(backupStatus(log, '/srv/shadeflow').covered, false);
  assert.equal(backupStatus(log).covered, true);
  assert.equal(
    backupStatus(`${filters('b', '/', '/var/backups/shadeflow/private/')}\n${success('b')}`)
      .covered,
    false,
  );
  assert.equal(
    backupStatus(`${filters('b', '/', '/var/backups/shadeflow-other/')}\n${success('b')}`).covered,
    true,
  );
  assert.equal(
    backupStatus(`${filters('failed', '/', '/var/')}\n${success('missing')}`).covered,
    null,
  );
  assert.equal(backupStatus(`${filters('b', '/', '/var/*')}\n${success('b')}`).covered, null);
  assert.equal(backupStatus(success('missing')).covered, null);
  assert.equal(
    backupStatus(
      `${filters('incremental', '/')}\n${success('incremental').replace('FULL', 'INCR')}`,
    ).covered,
    true,
  );
});

test('cloud coverage compares archive completion with the same job start', () => {
  const log = `${start('job')}\n${filters('job', '/')}\n${success('job')}`;
  const result = backupStatus(log);
  const snapshot = { completedAt: '2026-11-05T05:18:00+08:00' };
  const afterGrace = Date.parse('2026-11-05T08:00:00+08:00');
  assert.equal(result.startedAt, Date.parse('2026-11-05T05:14:59+08:00'));
  assert.equal(cloudBackupPending(snapshot, result.startedAt, afterGrace), true);
  assert.equal(
    cloudBackupPending(
      snapshot,
      backupStatus(`${filters('job', '/')}\n${success('job')}`).startedAt,
      afterGrace,
    ),
    true,
  );
  assert.equal(
    cloudBackupPending({ completedAt: '2026-11-05T04:30:00+08:00' }, result.startedAt, afterGrace),
    false,
  );
});

test('notifications deduplicate, remind, recover and retain retry state on SMTP failure', async () => {
  const sent = [];
  const send = async (message) => sent.push(message);
  const start = 2 * 86400000;
  assert.equal((await notifyChanges({}, {}, send, start)).sent, false);
  const first = await notifyChanges({}, { disk: 'full' }, send, start);
  assert.equal(first.sent, true);
  assert.equal(
    (await notifyChanges(first.state, { disk: 'still full' }, send, start + 300000)).sent,
    false,
  );
  assert.equal(
    (await notifyChanges(first.state, { disk: 'full' }, send, start + 86400000)).sent,
    true,
  );
  await assert.rejects(
    notifyChanges(
      first.state,
      {},
      async () => {
        throw new Error('offline');
      },
      start + 600000,
    ),
  );
  assert.deepEqual(first.state.ids, ['disk']);
  assert.equal((await notifyChanges(first.state, {}, send, start + 900000)).sent, true);
  assert.match(sent.at(-1).subject, /恢复/);
});

test('service check ignores a single transient probe failure but reports two failures', async () => {
  let calls = 0;
  await retryServiceCheck(() => {
    if (++calls === 1) throw new Error('timeout');
  });
  assert.equal(calls, 2);
  await assert.rejects(
    retryServiceCheck(() => {
      throw new Error('down');
    }),
    /down/,
  );
});

test('service emails require consecutive failed runs', async () => {
  const sent = [];
  const send = async (message) => sent.push(message);
  const start = 2 * 86400000;
  const first = await notifyChanges({}, { service: 'timeout' }, send, start);
  assert.equal(first.sent, false);
  const recovered = await notifyChanges(first.state, {}, send, start + 300000);
  assert.equal(recovered.sent, false);
  const second = await notifyChanges(recovered.state, { service: 'timeout' }, send, start + 600000);
  assert.equal(second.sent, false);
  const confirmed = await notifyChanges(second.state, { service: 'timeout' }, send, start + 900000);
  assert.equal(confirmed.sent, true);
  assert.equal((await notifyChanges(confirmed.state, {}, send, start + 1200000)).sent, true);
  assert.equal(sent.length, 2);
});

test('normal 04:30 to 08:00 cloud backup gap sends no alert', async () => {
  const sent = [];
  const send = async (message) => sent.push(message);
  const snapshot = { completedAt: '2026-11-15T20:30:00.000Z' };
  const priorCloud = Date.parse('2026-11-14T21:15:00.000Z');
  const atFive = Date.parse('2026-11-15T21:00:00.000Z');
  const issue = (now, startedAt, latest = snapshot) =>
    cloudBackupPending(latest, startedAt, now) ? { 'cloud-backup': '新归档未入云' } : {};
  const first = await notifyChanges({}, issue(atFive, priorCloud), send, atFive);
  assert.equal(first.sent, false);
  assert.equal(sent.length, 0);
  const atEight = Date.parse('2026-11-16T00:00:00.000Z');
  const delayed = await notifyChanges(first.state, issue(atEight, priorCloud), send, atEight);
  assert.equal(delayed.sent, true);
  const completed = await notifyChanges(
    delayed.state,
    issue(atEight + 600000, Date.parse('2026-11-15T21:15:00.000Z')),
    send,
    atEight + 600000,
  );
  assert.equal(completed.sent, true);
  assert.equal(sent.length, 2);
  assert(
    cloudBackupPending({ completedAt: '2026-11-14T20:30:00.000Z' }, priorCloud - 86400000, atFive),
  );
  assert(
    cloudBackupPending({ completedAt: '2026-11-16T02:15:00.000Z' }, priorCloud, atEight + 8400000),
  );
});
