import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { OutreachService } from '../server/outreach-service.mjs';

test('只有同源文档导航取得无缓存首屏；脚本边界、作用域和维护不泄露资料', async (t) => {
  const dist = await mkdtemp(join(tmpdir(), 'page-first-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(join(dist, 'server-render'));
  await mkdir(join(dist, 'assets'));
  await writeFile(join(dist, 'assets', 'style-demo1234.css'), 'body{margin:0}');
  await writeFile(
    join(dist, 'index.html'),
    '<link rel="stylesheet" href="/assets/style-demo1234.css"><div id="root"></div>',
  );
  await writeFile(
    join(dist, 'server-render', 'entry-server.js'),
    'export const renderPage=()=>"<main>first</main>"',
  );
  const service = new OutreachService({ mailboxes: { list: () => [] } });
  service.putCampaign({
    id: 'safe',
    name: '</script><script>bad()</script>',
    mode: 'production',
    status: 'active',
  });
  const maintenance = join(dist, 'maintenance.json');
  const app = createApp({
    dist,
    env: { RELEASE_MAINTENANCE_PATH: maintenance },
    outreachServiceFactory: () => service,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const url = 'http://127.0.0.1:' + app.address().port;
  const headers = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'document' };
  const read = (extra) =>
    fetch(url + '/inbox?tab=campaigns', { headers: { ...headers, ...extra } });
  const res = await read({});
  assert.match(res.headers.get('cache-control'), /no-store/);
  const body = await res.text();
  assert.match(body, /data-initial-css/);
  const warm = await read({ cookie: 'sf_style=style-demo1234.css', 'accept-encoding': 'br' });
  assert.equal(warm.headers.get('content-encoding'), 'br');
  assert.doesNotMatch(await warm.text(), /data-initial-css/);
  assert.match(await (await read({ cookie: 'sf_style=old.css' })).text(), /data-initial-css/);
  assert.match(body, /<main>first/);
  assert.ok(!body.includes('<script>bad()'));
  assert.ok(body.includes('\\u003c/script>'));
  assert.ok(
    !(await (await read({ 'Sec-Fetch-Site': 'cross-site' })).text()).includes('initial-page'),
  );
  assert.ok(!(await (await read({ 'Sec-Fetch-Dest': 'iframe' })).text()).includes('initial-page'));
  assert.equal((await fetch(url + '/server-render/entry-server.js')).status, 404);
  await writeFile(maintenance, '{}');
  assert.ok(!(await (await read({})).text()).includes('initial-page'));
});

test('准备计划只查该客户的历史，额度统计不取正文或候选证据', (t) => {
  const service = new OutreachService({ mailboxes: { list: () => [] } });
  t.after(() => service.close());
  for (const id of ['one', 'two'])
    service.putDelivery({
      id,
      status: 'accepted',
      customerId: id,
      campaignId: 'same',
      bodyHtml: 'x'.repeat(10000),
      mailboxId: 'box',
      sentAt: '2026-01-01',
    });
  assert.deepEqual(
    service.deliveries('same', undefined, 'two').map((r) => r.id),
    ['two'],
  );
  const stats = service.deliveryActivity('accepted');
  assert.equal(stats.length, 2);
  assert.ok(
    stats.every(
      (r) =>
        r.mailboxId === 'box' &&
        r.sentAt === '2026-01-01' &&
        !('bodyHtml' in r) &&
        !('candidate' in r),
    ),
  );
  assert.equal(service.deliveryActivity('queued').length, 0);
});
