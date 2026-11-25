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
      return Object.keys(fields).map((field_name) => ({ field_name, type: 1 }));
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
  assert.equal((await library.list()).total, 1, '导入飞书镜像不能重复建档');
});

test('断网修改仍保存到SQLite，慢速或失败的飞书读取不阻塞已有档案', async (t) => {
  const { remote, open } = fixture(t);
  remote.rows = [{ record_id: 'rec_old', fields }];
  const { library, archive } = open();
  library.upsert(mapFeishuRecord(remote.rows[0]));
  remote.online = false;
  await archive.write('update', { 邮箱: 'new@shadeco.com' }, 'rec_old');
  await archive.sync();
  assert.equal((await library.detail('rec_old')).lead.email, 'new@shadeco.com');
  assert.equal(library.metadata().sync.pendingWrites, 1);
  assert.ok(library.metadata().sync.writeError);
  assert.ok(!JSON.stringify(library.metadata()).includes('secret-offline-error'));
  assert.equal((await library.list()).leads[0].email, 'new@shadeco.com');
  remote.online = true;
  await archive.sync();
  assert.equal(remote.rows[0].fields.邮箱, 'new@shadeco.com');
  assert.equal(library.metadata().sync.pendingWrites, 0);
});

test('新增同步响应丢失并重启后先核对飞书，不重复创建，客户本地编号不变', async (t) => {
  const { remote, open } = fixture(t);
  const first = open();
  remote.loseResponse = true;
  const record = await first.archive.write('insert', fields, undefined, 'operation-lost');
  await first.archive.sync();
  assert.equal(remote.writes, 1);
  assert.equal(first.library.metadata().sync.pendingWrites, 1);
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

test('本地字段定义独立于飞书，本地保存失败时不触发飞书写入', async (t) => {
  const { remote, open } = fixture(t);
  const first = open();
  const schema = await first.archive.fields();
  await first.close();
  const next = open();
  assert.deepEqual(await next.archive.fields(), schema);
  assert.equal(remote.schemaReads, 0);
  next.library.db.exec('PRAGMA query_only=ON');
  await assert.rejects(next.archive.write('insert', fields, undefined, 'operation-no-write'));
  assert.equal(remote.writes, 0);
  assert.equal(next.library.snapshot().total, 0);
});

test('远端修改和删除不覆盖本地主档案，相同官网内容冲突或主体变更不自动覆盖飞书', async (t) => {
  const { remote, open } = fixture(t);
  remote.rows = [{ record_id: 'rec_old', fields: structuredClone(fields) }];
  const { library, archive } = open();
  library.upsert(mapFeishuRecord(remote.rows[0]));
  remote.rows[0].fields.公司名称 = 'Remote edit';
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

test('精简原T2按实际写入列核对，内部编号和完整摘要保留本地，重启不重复客户', async (t) => {
  const { remote, open } = fixture(t);
  remote.fields = async () => [
    { field_name: '客户ID', type: 1005 },
    { field_name: '公司名称', type: 1 },
    { field_name: '官网链接', type: 1 },
    { field_name: '客户画像摘要', type: 1 },
    { field_name: '主要供货机会', type: 1 },
  ];
  const { archive, library } = open();
  const raw = {
    公司名称: 'Shade Co',
    企业官网: 'https://shadeco.com',
    customer_id: 'web_shadeco.com',
    来源链接: 'https://directory.example/shade',
    公开采购需求: '原始需求依据',
    客户行业画像:
      '旧摘要\n依据：old\n来源：https://shadeco.com/\n最新摘要\n依据：new\n来源：https://shadeco.com/about',
    主要供货机会: '成品 · ZIP（潜在供货机会）',
  };
  const saved = await archive.write('insert', raw, undefined, 'compact-original-t2');
  remote.loseResponse = true;
  await archive.sync();
  await archive.close();
  const restarted = open();
  await restarted.archive.sync();
  assert.equal(restarted.library.metadata().sync.pendingWrites, 0);
  assert.equal(remote.rows.length, 1);
  assert.deepEqual(remote.rows[0].fields, {
    公司名称: 'Shade Co',
    官网链接: 'https://shadeco.com',
    客户画像摘要: '最新摘要',
    主要供货机会: '成品 · ZIP',
  });
  assert.equal(
    (await restarted.archive.record(saved.record_id)).fields.客户行业画像,
    raw.客户行业画像,
  );
  assert.equal(restarted.archive.remoteId(saved.record_id), remote.rows[0].record_id);
});

test('首次关联已有报表时，只补同一企业可核实的业务进展', async (t) => {
  const { remote, open } = fixture(t);
  const { archive, library } = open();
  const hive = {
    公司名称: 'Hive & Design Ltd',
    企业官网: 'https://www.stitched.co.uk/shop/press',
    开发状态: '已回复',
    最近联系时间: 1794999583324,
    最近回复时间: 1794999615000,
    评级依据摘要: '主营产品、定制服务已核实',
    邮箱有效性: '有效',
  };
  const cases = [
    [hive, { 开发状态: '待开发' }, true],
    [
      {
        公司名称: 'Shade Co',
        企业官网: 'https://shade.example',
        开发状态: '已联系',
        最近联系时间: 1794999583324,
      },
      { 开发状态: '待开发' },
      true,
    ],
    [
      { ...hive, 企业官网: 'https://other.example' },
      { 公司名称: 'Other Company', 开发状态: '待开发' },
      false,
    ],
    [{ ...hive, 企业官网: 'https://closed.example' }, { 开发状态: '停止开发' }, false],
    [
      { ...hive, 企业官网: 'https://different.example' },
      { 开发状态: '待开发', 邮箱有效性: '失效' },
      false,
    ],
    [
      { ...hive, 企业官网: 'https://missing.example', 最近回复时间: null },
      { 开发状态: '待开发' },
      false,
    ],
  ];
  remote.fields = async () => Object.keys(hive).map((field_name) => ({ field_name, type: 1 }));
  const ids = [];
  const originals = [];
  for (const [i, [local, overrides]] of cases.entries()) {
    const old = {
      公司名称: local.公司名称,
      企业官网: local.企业官网,
      内部备注: '保留',
      ...overrides,
    };
    originals.push(old);
    remote.rows.push({ record_id: 'rec_' + i, fields: { ...old } });
    ids.push((await archive.write('insert', local, undefined, 'customer-' + i)).record_id);
  }
  await archive.write('update', { 最近联系时间: hive.最近联系时间 }, ids[0]);
  await archive.write('update', { 最近回复时间: hive.最近回复时间 }, ids[0]);
  assert.equal(archive.entry(ids[0]).revision, 3);
  await archive.sync();
  await archive.sync();
  assert.equal(remote.rows.length, cases.length);
  for (const [i, [local, , recover]] of cases.entries()) {
    const entry = archive.entry(ids[i]);
    assert.equal(entry.remoteId, recover ? 'rec_' + i : null, local.企业官网);
    assert.deepEqual(remote.rows[i].fields, recover ? { ...originals[i], ...local } : originals[i]);
    assert.equal(entry.syncedRevision, recover ? entry.revision : 0);
    if (!recover) assert.ok(entry.error.includes(local.公司名称));
  }
  assert.equal(remote.writes, 2);
  assert.equal(library.metadata().sync.pendingWrites, 4);
});

test('首次关联遇到同域名多行、已归属的飞书行或读回时主体改变，均保留待核对', async (t) => {
  const { remote, open } = fixture(t);
  const { archive, library } = open();
  const { record_id } = await archive.write('insert', fields, undefined, 'verify-owner');
  remote.rows = ['rec_a', 'rec_b'].map((id) => ({ record_id: id, fields: { ...fields } }));
  await archive.sync();
  assert.match(archive.entry(record_id).error, /多条同官网/);
  remote.rows.pop();
  remote.record = async () => ({ ...remote.rows[0], fields: { ...fields, 公司名称: 'Other' } });
  await archive.sync();
  assert.match(archive.entry(record_id).error, /公司名称/);
  remote.record = async () => remote.rows[0];
  library.upsert(mapFeishuRecord(remote.rows[0]));
  await archive.sync();
  assert.match(archive.entry(record_id).error, /另一份本地档案/);
  assert.equal(archive.remoteId(record_id), null);
  assert.equal(remote.writes, 0);
});
