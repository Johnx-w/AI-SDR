import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { copyData } from '../scripts/ops-backup.mjs';
import { backupStatus, notifyChanges } from '../scripts/ops-monitor.mjs';

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

const filters = (id, source, excluded = '') =>
  `time="2026-11-05T05:15:00+08:00" msg="first target item [${source}], include filter : [], exclude filter : [${excluded}]" tskid=${id}`;
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
