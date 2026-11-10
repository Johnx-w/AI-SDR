import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { createApp } from '../server/app.mjs';

test('浏览器静态资源压缩减少传输，原内容、HEAD 和不接受 gzip 的读取保持兼容', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'static-compression-'));
  const content = Buffer.from('const message = "获客任务";\n'.repeat(10000));
  const picture = Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]);
  writeFileSync(join(dist, 'index.html'), '<html>工作台</html>');
  writeFileSync(join(dist, 'app.js'), content);
  writeFileSync(join(dist, 'logo.png'), picture);
  const app = createApp({ dist, env: {} });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const request = (path, encoding, method = 'GET') =>
    new Promise((resolve, reject) => {
      const req = get(
        {
          host: '127.0.0.1',
          port: app.address().port,
          path,
          method,
          headers: { 'Accept-Encoding': encoding },
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
    });
  try {
    const compressed = await request('/app.js', 'gzip, deflate, br');
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.equal(compressed.headers.vary, 'Accept-Encoding');
    assert.equal(compressed.headers['content-type'], 'application/javascript');
    assert.deepEqual(gunzipSync(compressed.body), content);
    assert.ok(compressed.body.length < content.length / 2);
    assert.equal(Number(compressed.headers['content-length']), compressed.body.length);
    for (const encoding of ['identity', 'gzip;q=0', 'br, gzip;q=0.000']) {
      const plain = await request('/app.js', encoding);
      assert.equal(plain.headers['content-encoding'], undefined);
      assert.deepEqual(plain.body, content);
    }
    const head = await request('/app.js', 'gzip', 'HEAD');
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-encoding'], 'gzip');
    assert.equal(Number(head.headers['content-length']), compressed.body.length);
    const binary = await request('/logo.png', 'gzip');
    assert.equal(binary.headers['content-encoding'], undefined);
    assert.deepEqual(binary.body, picture);
    const health = await request('/api/health', 'gzip');
    assert.equal(health.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(health.body), { ok: true });
  } finally {
    await new Promise((resolve) => app.close(resolve));
    rmSync(dist, { recursive: true, force: true });
  }
});
