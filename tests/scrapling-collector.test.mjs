import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectScraplingPage } from '../server/scrapling-collector.mjs';

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
