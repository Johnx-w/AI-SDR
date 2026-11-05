import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CustomerArchive } from '../server/customer-archive.mjs';
import { LeadLibrary } from '../server/lead-library.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';

const fields = {
  公司名称: 'Shade Co',
  企业官网: 'https://shadeco.com',
  customer_id: 'web_shadeco.com',
  邮箱: 'buyer@shadeco.com',
  开发状态: '待开发',
};
function fixture(t) {
  const path = mkdtempSync(join(tmpdir(), 'customer-archive-'));
  const opened = [];
  const remote = {
    rows: [],
    writes: 0,
    online: true,
    loseResponse: false,
    gate: null,
    schemaReads: 0,
    async records() {
      if (!this.online) throw new Error('secret-offline-error');
      return structuredClone(this.rows);
    },
    async record(id) {
      return (await this.records()).find((row) => row.record_id === id);
    },
    async fields() {
      this.schemaReads++;
      return [{ field_name: '公司名称', type: 1 }];
    },
    async write(action, patch, id) {
      if (!this.online) throw new Error('secret-offline-error');
      this.writes++;
      if (this.gate) await this.gate;
      const row =
        action === 'insert'
          ? { record_id: 'rec_' + (this.rows.length + 1), fields: {} }
          : this.rows.find((row) => row.record_id === id);
      Object.assign(row.fields, structuredClone(patch));
      if (action === 'insert') this.rows.push(row);
      if (this.loseResponse) {
        this.loseResponse = false;
        throw new Error('response lost');
      }
      return structuredClone(row);
    },
  };
  function open() {
    const library = new LeadLibrary({
      path: join(path, 'customers.sqlite'),
      scope: 'table-a',
      intervalMs: 0,
      readLeads: async () => {
        const rows = await remote.records();
        return { leads: rows.map(mapFeishuRecord), total: rows.length };
      },
    });
    const archive = new CustomerArchive({ library: () => library, remote });
    const instance = {
      library,
      archive,
      async close() {
        await archive.close();
        library.close();
      },
    };
    opened.push(instance);
    return instance;
  }
  t.after(async () => {
    remote.release?.();
    for (const instance of opened) await instance.close();
    rmSync(path, { recursive: true, force: true });
  });
  return { remote, open };
}

test('先事务保存完整档案与待同步操作，飞书尚未响应时本地就能读取', async (t) => {
  const { remote, open } = fixture(t);
  const { library, archive } = open();
  await library.refresh();
  let finish;
  remote.gate = new Promise((resolve) => {
    finish = resolve;
  });
  remote.release = finish;
  const record = await archive.write('insert', fields, undefined, 'operation-1');
  assert.match(record.record_id, /^local_/);
  assert.equal((await library.detail(record.record_id)).lead.name, fields.公司名称);
  assert.equal(library.metadata().source, 'sqlite');
  assert.equal(library.metadata().sync.pendingWrites, 1);
  finish();
  await archive.sync();
  assert.equal(archive.remoteId(record.record_id), 'rec_1');
  assert.equal(library.metadata().sync.pendingWrites, 0);
  assert.equal((await library.list()).leads[0].id, record.record_id);
  await library.refresh();
  assert.equal((await library.list()).total, 1, '导入飞书镜像不能重复建档');
});

test('断网修改仍保存到SQLite，慢速或失败的飞书读取不阻塞已有档案', async (t) => {
  const { remote, open } = fixture(t);
  remote.rows = [{ record_id: 'rec_old', fields }];
  const { library, archive } = open();
  await library.refresh();
  remote.online = false;
  await archive.write('update', { 邮箱: 'new@shadeco.com' }, 'rec_old');
  await archive.sync();
  assert.equal((await library.detail('rec_old')).lead.email, 'new@shadeco.com');
  assert.equal(library.metadata().sync.pendingWrites, 1);
  assert.ok(library.metadata().sync.writeError);
  assert.ok(!JSON.stringify(library.metadata()).includes('secret-offline-error'));
  let finish;
  library.readLeads = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const refreshing = library.refresh();
  assert.equal((await library.list()).leads[0].email, 'new@shadeco.com');
  finish({ leads: [], total: 0 });
  await refreshing;
  assert.equal((await library.list()).total, 1, '远端缺失不删除本地档案');
  remote.online = true;
  await archive.sync();
  assert.equal(remote.rows[0].fields.邮箱, 'new@shadeco.com');
  assert.equal(library.metadata().sync.pendingWrites, 0);
});

test('新增同步响应丢失并重启后先核对飞书，不重复创建，客户本地编号不变', async (t) => {
  const { remote, open } = fixture(t);
  const first = open();
  await first.library.refresh();
  remote.loseResponse = true;
  const record = await first.archive.write('insert', fields, undefined, 'operation-lost');
  await first.archive.sync();
  assert.equal(remote.writes, 1);
  assert.equal(first.library.metadata().sync.pendingWrites, 1);
  await first.library.refresh();
  assert.equal(first.library.snapshot().total, 1, '响应丢失后的飞书导入也不能重复建档');
  await first.close();
  const restarted = open();
  assert.equal((await restarted.library.detail(record.record_id)).lead.name, fields.公司名称);
  await restarted.archive.sync();
  assert.equal(remote.writes, 1);
  assert.equal(restarted.archive.remoteId(record.record_id), 'rec_1');
  assert.equal(restarted.library.metadata().sync.pendingWrites, 0);
});

test('同步期间再次编辑，旧同步完成不能清掉新修改，后续同步最新版本', async (t) => {
  const { remote, open } = fixture(t);
  const { library, archive } = open();
  await library.refresh();
  let finish;
  remote.gate = new Promise((resolve) => {
    finish = resolve;
  });
  remote.release = finish;
  const record = await archive.write('insert', fields, undefined, 'operation-race');
  const syncing = archive.sync();
  while (!remote.writes) await new Promise((resolve) => setImmediate(resolve));
  await archive.write('update', { 邮箱: 'latest@shadeco.com' }, record.record_id);
  finish();
  await syncing;
  assert.equal((await library.detail(record.record_id)).lead.email, 'latest@shadeco.com');
  assert.equal(library.metadata().sync.pendingWrites, 1);
  await archive.sync();
  assert.equal(remote.rows[0].fields.邮箱, 'latest@shadeco.com');
  assert.equal(library.metadata().sync.pendingWrites, 0);
});

test('字段定义跨重启保留，本地保存失败时不触发任何飞书写入', async (t) => {
  const { remote, open } = fixture(t);
  const first = open();
  await first.library.refresh();
  const schema = await first.archive.fields();
  await first.close();
  const next = open();
  assert.deepEqual(await next.archive.fields(), schema);
  assert.equal(remote.schemaReads, 1);
  next.library.db.exec('PRAGMA query_only=ON');
  await assert.rejects(next.archive.write('insert', fields, undefined, 'operation-no-write'));
  assert.equal(remote.writes, 0);
  assert.equal(next.library.snapshot().total, 0);
});

test('远端修改和删除不覆盖本地主档案，相同官网内容冲突或主体变更不自动覆盖飞书', async (t) => {
  const { remote, open } = fixture(t);
  remote.rows = [{ record_id: 'rec_old', fields: structuredClone(fields) }];
  const { library, archive } = open();
  await library.refresh();
  remote.rows[0].fields.公司名称 = 'Remote edit';
  await library.refresh();
  assert.equal(library.snapshot().leads[0].name, 'Shade Co');
  remote.rows[0].fields.企业官网 = 'https://other-company.com';
  await archive.write('update', { 邮箱: 'local@shadeco.com' }, 'rec_old');
  await archive.sync();
  assert.equal(remote.writes, 0);
  assert.match(library.metadata().sync.writeError, /官网已变更/);
  remote.online = false;
  const newFields = { ...fields, 企业官网: 'https://newco.com' };
  await archive.write('insert', newFields, undefined, 'operation-conflict');
  await archive.sync();
  remote.rows.push({ record_id: 'rec_elsewhere', fields: { ...newFields, 开发状态: '已成交' } });
  remote.online = true;
  await archive.sync();
  assert.equal(remote.writes, 0);
  assert.equal(remote.rows[1].fields.开发状态, '已成交');
  assert.equal(library.metadata().sync.pendingWrites, 2);
});
