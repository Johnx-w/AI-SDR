import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { mapFeishuRecord } from '../server/feishu.mjs';
import { mergeResearchFields } from '../server/company-research.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = {
  ACQUISITION_PROVIDER: 'native',
  FEISHU_APP_ID: 'test-app',
  FEISHU_APP_SECRET: 'test-secret',
  FEISHU_APP_TOKEN: 'test-base',
  FEISHU_TABLE_ID: 'test-table',
};
const evidence = [
  {
    kind: 'email',
    value: 'old@buyer.example.org',
    quote: 'Email us',
    source_url: 'https://buyer.example.org',
  },
  {
    kind: 'phone',
    value: '+1 9726960181',
    quote: 'Call us',
    source_url: 'https://buyer.example.org',
  },
];

async function withApp(
  callback,
  { uncertainWrite = false, failedWrite = false, simplified = false } = {},
) {
  let record = {
    record_id: 'rec-test',
    fields: {
      公司名称: 'Buyer',
      国家: 'United States',
      联系人: '',
      邮箱: evidence[0].value,
      电话: evidence[1].value,
      开发状态: '未记录',
      画像JSON: JSON.stringify({
        facts: [{ field: 'product', value: 'blinds' }],
        latest_research: { contact_evidence: evidence },
      }),
    },
  };
  if (simplified) {
    delete record.fields.联系人;
    delete record.fields.画像JSON;
  }
  let writes = 0;
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    const ok = (data) => Response.json({ code: 0, data });
    if (path.endsWith('/auth/v3/tenant_access_token/internal'))
      return Response.json({ code: 0, tenant_access_token: 'test-token', expire: 3600 });
    if (path.endsWith('/fields'))
      return ok({
        items: (simplified ? ['邮箱', '电话'] : ['联系人', '邮箱', '电话', '画像JSON']).map(
          (field_name) => ({
            field_name,
            type: 1,
          }),
        ),
        has_more: false,
      });
    if (path.endsWith('/records/rec-test')) {
      if (options.method === 'PUT') {
        writes++;
        if (failedWrite) throw new Error('remote unavailable');
        record = { ...record, fields: { ...record.fields, ...JSON.parse(options.body).fields } };
        if (uncertainWrite) throw new Error('response lost after commit');
      }
      return ok({ record });
    }
    if (path.endsWith('/records')) return ok({ items: [record], has_more: false });
    throw new Error('Unexpected request: ' + path);
  };
  const app = createApp({ env, fetchImpl });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  const edit = (contacts, expected = current(), extra = {}) =>
    fetch(base + '/api/v1/leads/real/rec-test/contacts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...extra },
      body: JSON.stringify({ contacts, expected }),
    });
  const current = () => {
    const lead = mapFeishuRecord(record);
    return { contact: lead.contact, email: lead.email, phone: lead.phone };
  };
  try {
    await callback({ base, edit, current, record: () => record, writes: () => writes });
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}

test('网页修改并读回联系方式，规范去重；保留研究证据和业务状态', async () => {
  await withApp(async ({ edit, record, writes, base }) => {
    const response = await edit({
      contact: '采购部',
      email: 'Sales@buyer.example.org\nsales@buyer.example.org',
      phone: '(972) 696-0181\n+19726960181',
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(data.contacts, {
      contact: '采购部',
      email: 'sales@buyer.example.org',
      phone: '+1 9726960181',
    });
    assert.equal(writes(), 1);
    const profile = JSON.parse(record().fields.画像JSON);
    assert.deepEqual(profile.latest_research.contact_evidence, evidence);
    assert.equal(profile.manual_contacts.contact.value, '采购部');
    assert.equal(record().fields.开发状态, '未记录');
    assert.deepEqual(profile.facts, [{ field: 'product', value: 'blinds' }]);
    const refreshed = await (await fetch(base + '/api/v1/leads/real')).json();
    assert.equal(refreshed.leads[0].email, data.contacts.email);
  });
});

test('清空错误联系方式后，刷新和重新研究都不恢复旧值', async () => {
  await withApp(async ({ edit, record, base }) => {
    assert.equal((await edit({ email: '', phone: '' })).status, 200);
    const refreshed = await (await fetch(base + '/api/v1/leads/real')).json();
    assert.equal(refreshed.leads[0].email, '');
    assert.equal(refreshed.leads[0].phone, '');
    const updated = mergeResearchFields(record().fields, {
      邮箱: 'old@buyer.example.org',
      电话: '+1 9726960181',
      画像JSON: JSON.stringify({
        facts: [{ field: 'product', value: 'new facts' }],
        latest_research: { contact_evidence: evidence },
      }),
    });
    assert.equal(updated.邮箱, '');
    assert.equal(updated.电话, '');
    const mapped = mapFeishuRecord({ ...record(), fields: { ...record().fields, ...updated } });
    assert.equal(mapped.email, '');
    assert.equal(mapped.phone, '');
    assert.deepEqual(mapped.facts, [{ field: 'product', value: 'new facts' }]);
    assert.deepEqual(
      mapped.contactEvidence.map(({ kind, value, quote, source_url }) => ({
        kind,
        value,
        quote,
        source_url,
      })),
      evidence,
    );
  });
});

test('无效内容、过期修改和跨站请求不写入飞书', async () => {
  await withApp(async ({ edit, current, writes }) => {
    for (const contacts of [
      { email: 'invalid email' },
      { phone: '123' },
      { email: null },
      { grade: 'A' },
      {},
    ])
      assert.equal((await edit(contacts)).status, 400);
    assert.equal(
      (
        await edit(
          { email: 'new@buyer.example.org' },
          { ...current(), email: 'outdated@buyer.example.org' },
        )
      ).status,
      409,
    );
    assert.equal(
      (await edit({ contact: 'Buyer' }, current(), { Origin: 'https://untrusted.example.org' }))
        .status,
      403,
    );
    assert.equal(writes(), 0);
  });
});

test('写入响应丢失时通过读回确认成功，不重复写入', async () => {
  await withApp(
    async ({ edit, writes }) => {
      assert.equal((await edit({ contact: '采购部' })).status, 200);
      assert.equal(writes(), 1);
    },
    { uncertainWrite: true },
  );
});

test('未保存成功时返回错误，不伪造成功或丢弃原有联系方式', async () => {
  await withApp(
    async ({ edit, current, writes }) => {
      const before = current();
      const response = await edit({ email: 'new@buyer.example.org' });
      assert.equal(response.status, 502);
      assert.deepEqual(current(), before);
      assert.equal(writes(), 1);
    },
    { failedWrite: true },
  );
});

test('兼容当前精简T2：联系人保存在后台，邮箱电话同步现有列，无需新增字段', async () => {
  await withApp(
    async ({ edit, base, record }) => {
      const first = await edit({ contact: '采购部', email: 'new@buyer.example.org', phone: '' });
      assert.equal(first.status, 200);
      const data = await first.json();
      assert.equal(data.contacts.contact, '采购部');
      assert.equal(record().fields.邮箱, 'new@buyer.example.org');
      assert.equal(record().fields.电话, '');
      assert.equal(record().fields.画像JSON, undefined);
      assert.equal(record().fields.联系人, undefined);
      const refreshed = await (await fetch(base + '/api/v1/leads/real')).json();
      assert.equal(refreshed.leads[0].contact, '采购部');
      assert.equal(refreshed.leads[0].phone, '');
      assert.equal((await edit({ email: '' }, data.contacts)).status, 200);
      const cleared = await (await fetch(base + '/api/v1/leads/real')).json();
      assert.equal(cleared.leads[0].email, '');
    },
    { simplified: true },
  );
});

test('人工修订按客户表隔离，后台重启后仍保留清空记录', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadeflow-contacts-'));
  const path = join(directory, 'contacts.sqlite');
  const corrections = {
    email: {
      value: '',
      previous_value: 'old@buyer.example.org',
      updated_at: new Date().toISOString(),
    },
  };
  let store = new AcquisitionStore(path, 'table-one');
  try {
    store.saveContactCorrections('rec-test', corrections);
    store.close();
    store = new AcquisitionStore(path, 'table-one');
    assert.deepEqual(store.contactCorrections('rec-test'), corrections);
    const other = new AcquisitionStore(path, 'table-two');
    try {
      assert.deepEqual(other.contactCorrections('rec-test'), {});
    } finally {
      other.close();
    }
  } finally {
    store.close();
    await Promise.all(
      [path, path + '-wal', path + '-shm'].map((file) => rm(file, { force: true })),
    );
    await rmdir(directory);
  }
});
