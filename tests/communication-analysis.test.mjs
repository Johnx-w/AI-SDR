import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CustomerBusiness } from '../server/customer-business.mjs';
import {
  analyzeCommunication,
  enrichCommunicationMessages,
} from '../server/communication-analysis.mjs';

const incoming = {
  id: 'in',
  direction: 'inbound',
  actualConfirmed: true,
  classification: 'normal',
  from: 'info@tonic.example',
  account: 'sales@example.com',
  subject: 'Re: Supply',
  body: 'Hi Lucy,\nWe manufacture all drapery in-house and are not looking to source externally.\nAbdul\nTrade Specialist\nabdul@tonic.example\n--- original message ---\nLucy Wang\nWe supply 1000 blinds.',
};
const valid = {
  replyType: '真人客户回复',
  classificationQuote:
    'We manufacture all drapery in-house and are not looking to source externally.',
  facts: [
    { label: '联系人', value: 'Abdul', quote: 'Abdul' },
    { label: '联系邮箱', value: 'abdul@tonic.example', quote: 'abdul@tonic.example' },
  ],
  demandSummary: '窗帘自行生产，目前不考虑外采。',
  demandQuote: 'We manufacture all drapery in-house and are not looking to source externally.',
};
const model = (data) => ({
  research: async () => ({ choices: [{ message: { content: JSON.stringify(data) } }] }),
});

test('仅提取有原文证据的客户信息和态度，排除引用开发信和凭空数量', async () => {
  let request;
  const data = await analyzeCommunication(incoming, {
    research: async (input) => {
      request = input;
      return model(valid).research();
    },
  });
  assert.match(data.customerInfo, /联系人：Abdul/);
  assert.equal(data.demandSummary, valid.demandSummary);
  assert(!request.messages[1].content.includes('1000 blinds'));
  await assert.rejects(
    analyzeCommunication(
      incoming,
      model({ ...valid, facts: [{ label: '联系人', value: 'Lucy Wang', quote: 'Lucy Wang' }] }),
    ),
    /原文依据/,
  );
  await assert.rejects(
    analyzeCommunication(incoming, model({ ...valid, demandSummary: '需要1000个窗帘' })),
    /数量/,
  );
  await assert.rejects(
    analyzeCommunication(
      incoming,
      model({ ...valid, facts: [{ label: '电话', value: '12345678', quote: 'Abdul' }] }),
    ),
    /原文依据/,
  );
});

test('自动回执不产生采购摘要，投递策略拒绝不调用模型或提取为客户联系方式', async () => {
  const auto = await analyzeCommunication(
    { ...incoming, classification: 'auto_reply' },
    model(valid),
  );
  assert.equal(auto.replyType, '系统自动回复');
  assert.equal(auto.demandSummary, '');
  const notice = await analyzeCommunication(
    {
      ...incoming,
      from: 'postmaster@example.com',
      subject: 'Undeliverable',
      body: 'Only authenticated senders are allowed.',
    },
    {
      research: () => {
        throw Error('must not call');
      },
    },
  );
  assert.deepEqual(notice, { replyType: '系统自动回复', customerInfo: '', demandSummary: '' });
});

test('分析结果存入数据库，重启不重复调用；正文变更重新分析；失败不缓存', async () => {
  const root = mkdtempSync(join(tmpdir(), 'communication-analysis-')),
    path = join(root, 'business.sqlite');
  let store = new CustomerBusiness({ path, scope: 'test' }),
    calls = 0;
  const analyzer = {
    research: async () => {
      calls++;
      return model(valid).research();
    },
  };
  try {
    const sent = { ...incoming, id: 'out', direction: 'outbound' };
    let messages = await enrichCommunicationMessages(store, [sent, incoming], { model: analyzer });
    assert.equal(calls, 1);
    assert.equal(messages[0], sent);
    assert.equal(messages[1].replyAnalysis.demandSummary, valid.demandSummary);
    store.close();
    store = new CustomerBusiness({ path, scope: 'test' });
    await enrichCommunicationMessages(store, [incoming], { model: analyzer });
    assert.equal(calls, 1);
    await enrichCommunicationMessages(store, [{ ...incoming, body: incoming.body + '\nextra' }], {
      model: analyzer,
    });
    assert.equal(calls, 2);
    await assert.rejects(
      enrichCommunicationMessages(store, [{ ...incoming, id: 'bad' }], {
        model: {
          research: async () => {
            throw Error('offline');
          },
        },
      }),
    );
    assert(
      !store.db
        .prepare('SELECT * FROM customer_business_message_analysis WHERE message_id=?')
        .get('bad'),
    );
    assert.equal(store.all('demands').length, 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
