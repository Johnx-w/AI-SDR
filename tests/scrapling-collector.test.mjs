import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createScraplingCgroup } from '../server/scrapling-cgroup.mjs';
import { collectScraplingPage } from '../server/scrapling-collector.mjs';

const fixture = fileURLToPath(new URL('./fixtures/scrapling-process.py', import.meta.url));

test('delayed cgroup cleanup blocks new workers until the original leaf can be removed', async () => {
  const parent = '/system.slice/stale-test.service';
  const path = join(parent, 'scrapling-worker');
  let populated = true;
  let generation = 0;
  let current = 0;
  let kills = 0;
  let unreadable = false;
  const controls = new Map([
    ['cgroup.subtree_control', 'memory'],
    ['memory.events', 'oom 0'],
    ['memory.peak', '4096'],
  ]);
  const files = {
    mkdir(directory) {
      assert.equal(directory, path);
      if (current) throw Object.assign(new Error('Leaf already exists'), { code: 'EEXIST' });
      current = ++generation;
    },
    identity(directory) {
      assert.equal(directory, path);
      return current;
    },
    read(_directory, key) {
      if (key !== 'cgroup.events') return controls.get(key);
      if (unreadable) throw Object.assign(new Error('Unreadable'), { code: 'EACCES' });
      return populated ? 'populated 1' : 'populated 0';
    },
    write(_directory, key, value) {
      if (key === 'cgroup.kill') kills++;
      controls.set(key, String(value));
    },
    access() {},
    remove(directory) {
      assert.equal(directory, path);
      assert.equal(populated, false);
      current = 0;
    },
  };

  const first = createScraplingCgroup(parent, files);
  await assert.rejects(first.close(), /still populated/);
  assert.throws(() => createScraplingCgroup(parent, files), /still populated/);
  populated = false;
  unreadable = true;
  assert.throws(() => createScraplingCgroup(parent, files), { code: 'EACCES' });
  assert.deepEqual([current, generation, kills], [1, 1, 1]);

  unreadable = false;
  const next = createScraplingCgroup(parent, files);
  assert.deepEqual([current, generation, kills], [2, 2, 1]);
  assert.equal(controls.get('memory.max'), '1073741824');
  assert.deepEqual(await next.close(), {
    oom: false,
    resources: { cgroup_limit_bytes: 1073741824, cgroup_peak_bytes: 4096 },
  });
  assert.deepEqual([current, generation, kills], [0, 2, 2]);

  const previous = createScraplingCgroup(parent, files);
  unreadable = true;
  await assert.rejects(previous.close(), { code: 'EACCES' });
  current = ++generation;
  unreadable = false;
  assert.throws(() => createScraplingCgroup(parent, files), { code: 'EEXIST' });
  assert.deepEqual([current, generation, kills], [4, 4, 3]);
});

function liveProcess(pid) {
  try {
    if (process.platform === 'linux')
      return (
        readFileSync('/proc/' + pid + '/stat', 'utf8')
          .split(') ')
          .at(-1)[0] !== 'Z'
      );
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return false;
    throw error;
  }
}

function processFixture(context, name, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'scrapling-process-'));
  const marker = join(directory, 'pids');
  const ids = () => readFileSync(marker, 'utf8').split(' ').map(Number);
  context.after(() => {
    try {
      for (const pid of ids()) if (liveProcess(pid)) process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  return {
    ids,
    collect: () =>
      collectScraplingPage('https://' + name + '.example.org/', {
        workerScript: fixture,
        async readResourceImpl() {
          return { status: 200, type: 'text/html', body: Buffer.from(marker) };
        },
        ...options,
      }),
  };
}

test(
  'a crashed Python process reports a safe reason and leaves neither process alive',
  { skip: !process.env.SCRAPLING_PYTHON },
  async (context) => {
    const { ids, collect } = processFixture(context, 'crash');
    const result = await collect();
    assert.equal(result.status, 'failed');
    assert.equal(result.failure_reason, 'worker_crashed');
    assert.deepEqual(ids().map(liveProcess), [false, false]);
    const next = await collectScraplingPage('https://control.example.org/', {
      async readResourceImpl() {
        return { status: 403 };
      },
    });
    assert.equal(next.status, 'blocked');
    assert.equal(next.resource_wait, undefined);
  },
);

test(
  'cancelling a running capture closes its process tree before another candidate reads',
  { skip: !process.env.SCRAPLING_PYTHON, timeout: 6000 },
  async (context) => {
    const abort = new AbortController();
    const { ids, collect } = processFixture(context, 'cancel', { signal: abort.signal });
    const pending = collect();
    for (let i = 0; i < 200; i++) {
      try {
        if (ids().every((pid) => pid > 0)) break;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await delay(10);
    }
    assert.deepEqual(ids().map(liveProcess), [true, true]);
    let aliveAtRead;
    const following = collectScraplingPage('https://following.example.org/', {
      async readResourceImpl() {
        aliveAtRead = ids().map(liveProcess);
        return { status: 403 };
      },
    });
    abort.abort();
    const [cancelled, next] = await Promise.all([pending, following]);
    assert.equal(cancelled.status, 'deferred');
    assert.equal(cancelled.failure_reason, 'aborted');
    assert.deepEqual(aliveAtRead, [false, false]);
    assert.equal(next.status, 'blocked');
    assert.equal(next.resource_wait.reason, 'browser_busy');
  },
);

test(
  'the 30 second request timeout kills Python and its child before releasing the slot',
  { skip: !process.env.SCRAPLING_PYTHON, timeout: 40000 },
  async (context) => {
    const { ids, collect } = processFixture(context, 'timeout');
    const start = performance.now();
    const result = await collect();
    assert.equal(result.status, 'timeout');
    assert.equal(result.failure_reason, 'worker_timeout');
    assert.deepEqual(ids().map(liveProcess), [false, false]);
    assert.ok(performance.now() - start >= 29000);
  },
);

test(
  'the Linux production collector fails closed before reading the page without delegation',
  { skip: process.platform !== 'linux' || !!process.env.SCRAPLING_CGROUP_TEST },
  async () => {
    const previous = process.env.NODE_ENV;
    let requests = 0;
    try {
      process.env.NODE_ENV = 'production';
      const result = await collectScraplingPage('https://unavailable.example.org/', {
        python: process.execPath,
        async readResourceImpl() {
          requests++;
          return { status: 403 };
        },
      });
      assert.equal(result.status, 'unavailable');
      assert.equal(result.failure_reason, 'worker_isolation_unavailable');
      assert.equal(requests, 0);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  },
);

test(
  'Linux cgroup OOM kills the worker and child while the app stays in its own subgroup',
  {
    skip:
      process.platform !== 'linux' ||
      !process.env.SCRAPLING_CGROUP_TEST ||
      !process.env.SCRAPLING_PYTHON,
    timeout: 12000,
  },
  async (context) => {
    const scope = '/system.slice/shadeflow-scrapling-probe.service';
    const membership = () => readFileSync('/proc/self/cgroup', 'utf8').trim();
    assert.equal(membership(), '0::' + scope + '/app');
    const { ids, collect } = processFixture(context, 'memory');
    const result = await collect();
    assert.equal(result.status, 'memory_limit');
    assert.equal(result.failure_reason, 'worker_memory_limit');
    assert.equal(result.resources.cgroup_limit_bytes, 1073741824);
    assert.ok(result.resources.cgroup_peak_bytes >= 31 * 1024 ** 2);
    assert.deepEqual(ids().map(liveProcess), [false, false]);
    assert.equal(membership(), '0::' + scope + '/app');
    assert.throws(
      () => readFileSync('/sys/fs/cgroup' + scope + '/scrapling-worker/cgroup.events'),
      { code: 'ENOENT' },
    );
    const next = await collectScraplingPage('https://control.example.org/', {
      async readResourceImpl() {
        return { status: 403 };
      },
    });
    assert.equal(next.status, 'blocked');
  },
);

test('public HTML capture immediately blocks loopback, credentials and insecure URLs', async () => {
  for (const url of [
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://admin@www.example.org/',
    'http://www.example.org/',
  ]) {
    const snapshot = await collectScraplingPage(url, { reason: 'missing_identity' });
    assert.equal(snapshot.requested_url, url);
    assert.equal(snapshot.final_url, null);
    assert.equal(snapshot.status, 'blocked');
    assert.equal(snapshot.content, '');
    assert.equal(snapshot.content_hash, null);
    assert.equal(snapshot.reason, 'missing_identity');
  }
});

test('the fallback keeps a cross-site redirect and an access challenge out of Chromium', async () => {
  const start = 'https://canyon.example.org/';
  for (const reply of [
    { redirect: 'https://third-party.example.org/' },
    { status: 200, type: 'text/html', body: Buffer.from('<title>Just a moment...</title>') },
  ]) {
    const reads = [];
    const result = await collectScraplingPage(start, {
      python: process.execPath,
      async readResourceImpl(url) {
        reads.push(url.href);
        return reply;
      },
    });
    assert.deepEqual(reads, [start]);
    assert.equal(result.status, 'blocked');
    assert.equal(result.final_url, null);
  }
});

test('browser captures wait in FIFO across callers while low memory and capacity defer safely', async () => {
  const reads = [];
  const waits = [];
  const availableMemoryImpl = () => memory;
  let memory = 1024 ** 3;
  let continueFirst;
  const firstPage = new Promise((resolve) => (continueFirst = resolve));
  const request = (name, options = {}) =>
    collectScraplingPage('https://' + name + '.example.org/', {
      python: process.execPath,
      availableMemoryImpl,
      onQueue: (state) => waits.push([name, state?.reason]),
      async readResourceImpl(url) {
        reads.push(url.hostname);
        if (name === 'first') await firstPage;
        return {
          status: 200,
          type: 'text/html',
          body: Buffer.from('<title>Access denied</title>'),
        };
      },
      ...options,
    });
  const first = request('first');
  await new Promise((resolve) => setImmediate(resolve));
  const second = request('second');
  const third = request('third');
  const backup = new AbortController();
  const controls = Array.from({ length: 6 }, (_, n) =>
    request('control-' + n, { signal: backup.signal }),
  );
  const overflow = await request('overflow');
  assert.equal(overflow.status, 'deferred');
  assert.equal(overflow.resource_wait.reason, 'queue_full');
  assert.deepEqual(reads, ['first.example.org']);
  assert.ok(waits.some(([name, reason]) => name === 'second' && reason === 'browser_busy'));
  backup.abort();
  assert.ok(
    (await Promise.all(controls)).every(
      (result) => result.status === 'deferred' && result.failure_reason === 'aborted',
    ),
  );
  memory = 1024 ** 3 - 1;
  continueFirst();
  assert.equal((await first).status, 'blocked');
  assert.ok(waits.some(([name, reason]) => name === 'second' && reason === 'low_memory'));
  assert.deepEqual(reads, ['first.example.org']);
  memory = 1024 ** 3;
  const [next, last] = await Promise.all([second, third]);
  assert.deepEqual([next.status, last.status], ['blocked', 'blocked']);
  assert.equal(next.resource_wait.reason, 'low_memory');
  assert.equal(last.resource_wait.reason, 'browser_busy');
  assert.deepEqual(reads, ['first.example.org', 'second.example.org', 'third.example.org']);
});

test(
  'sandboxed Chromium renders two same-site fixture businesses and retains the empty-shell control',
  { skip: !process.env.SCRAPLING_PYTHON },
  async (context) => {
    const targets = [
      'https://canyon.example.org/',
      'https://harbour.example.org/',
      'https://empty.example.org/',
    ];
    const accessed = [];
    const replies = {
      'https://canyon.example.org/':
        '<main>Loading...</main><script src="/render.js"></script><script src="https://third-party.example.org/tracker.js"></script>',
      'https://canyon.example.org/render.js':
        'document.querySelector("main").innerHTML="<h1>Canyon Shade LLC</h1><p>We manufacture and install custom roller shades.</p><a href=/contact>Contact</a>";',
      'https://harbour.example.org/': { redirect: 'https://www.harbour.example.org/' },
      'https://www.harbour.example.org/':
        '<main>Loading...</main><script src="/render.js"></script><img src="http://127.0.0.1/forbidden">',
      'https://www.harbour.example.org/render.js':
        'document.querySelector("main").innerHTML="<h1>Harbour Curtains Pty Ltd</h1><p>We supply custom drapery for hotels in Sydney.</p>";',
      'https://empty.example.org/':
        '<main>Loading...</main><script src="https://127.0.0.1/render.js"></script>',
    };
    const readResourceImpl = async (url, kind) => {
      accessed.push(url.href);
      const reply = replies[url.href];
      assert.ok(reply, url.href);
      if (reply.redirect) return reply;
      return {
        status: 200,
        type: kind === 'script' ? 'text/javascript' : 'text/html',
        body: Buffer.from(reply),
      };
    };
    const results = [];
    for (const url of targets) results.push(await collectScraplingPage(url, { readResourceImpl }));
    assert.deepEqual(
      results.map((r) => r.status),
      ['ok', 'ok', 'failed'],
    );
    assert.match(results[0].content, /Canyon Shade LLC/);
    assert.doesNotMatch(results[0].raw_content, /Canyon Shade LLC/);
    assert.deepEqual(results[0].links, ['/contact']);
    assert.match(results[1].content, /Harbour Curtains Pty Ltd/);
    assert.equal(results[1].final_url, 'https://www.harbour.example.org/');
    assert.match(results[2].content, /Loading/);
    assert.equal(results[0].versions.scrapling, '0.5.1');
    assert.equal(results[0].versions.playwright, '1.65.2');
    assert.equal(results[0].versions.chromium, '159.0.8154.6');
    assert.match(results[0].versions.python, /^3\.12\./);
    assert.ok(results[0].resources.processes > 1);
    assert.deepEqual(accessed, Object.keys(replies));
    context.diagnostic(
      JSON.stringify({ versions: results[0].versions, resources: results[0].resources }),
    );
  },
);

test(
  'a page title or an isolated review badge cannot substitute for rendered body evidence',
  { skip: !process.env.SCRAPLING_PYTHON },
  async () => {
    const samples = [
      ['<head><title>Cameron Blinds</title></head><body></body>', 'failed'],
      [
        '<head><title>Empire Window Furnishings</title></head><body><div class="ti-widget-container">4.7 <span>1703 reviews</span></div><title>Empire Window Furnishings</title></body>',
        'failed',
      ],
      ['<head><title>Clearview Blinds</title></head><body><p>Roller blinds.</p></body>', 'ok'],
    ];
    const snapshots = [];
    for (const [html] of samples) {
      snapshots.push(
        await collectScraplingPage('https://blinds.example.org/', {
          async readResourceImpl() {
            return { status: 200, type: 'text/html', body: Buffer.from(html) };
          },
        }),
      );
    }
    assert.deepEqual(
      snapshots.map(({ status }) => status),
      samples.map(([, status]) => status),
    );
    assert.match(snapshots[0].content, /Cameron Blinds/);
    assert.match(snapshots[1].content, /1703 reviews/);
    assert.match(snapshots[2].content, /Roller blinds\./);
  },
);

test(
  'slow optional resources leave the already loaded public evidence readable',
  { skip: !process.env.SCRAPLING_PYTHON },
  async () => {
    const html =
      '<main><p>Canyon Shade LLC manufactures complete roller shades.</p></main>' +
      Array.from({ length: 5 }, (_, i) => '<script src="/slow-' + i + '.js"></script>').join('');
    const result = await collectScraplingPage('https://canyon.example.org/', {
      async readResourceImpl(_url, kind, signal) {
        if (kind === 'document') {
          return { status: 200, type: 'text/html', body: Buffer.from(html) };
        }
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        return { status: 503 };
      },
    });
    assert.equal(result.status, 'ok');
    assert.match(result.content, /Canyon Shade LLC manufactures complete roller shades/);
  },
);
