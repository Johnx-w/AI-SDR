import test from 'node:test';
import assert from 'node:assert/strict';
import { customerMirrorFields, customerEmailValidity } from '../server/customer-mirror.mjs';
import { isDevelopmentCustomer } from '../server/customer-eligibility.mjs';
import { CustomerBusinessApi } from '../server/customer-business-api.mjs';
import { communicationRoundFields, communicationRounds } from '../server/communication-rounds.mjs';
import { recordMailConversation } from '../server/mail-conversation-business.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('邮箱有效性仅按匹配地址的实际收发，地址失效优先于重发接受，策略拒收不标失效', () => {
  const lead = { id: 'one', email: 'buyer@example.org' };
  const sent = {
    customerId: 'one',
    channel: 'email',
    actualConfirmed: true,
    direction: 'outbound',
    deliveryStatus: 'accepted',
    to: lead.email,
    occurredAt: '2026-11-01T08:00:00Z',
  };
  assert.equal(customerEmailValidity(lead, []), '待核验');
  assert.equal(customerEmailValidity({ id: 'empty' }, []), null);
  assert.equal(customerEmailValidity(lead, [sent]), '有效');
  const bounce = {
    ...sent,
    direction: 'inbound',
    deliveryStatus: 'received',
    from: 'mailer-daemon@example.com',
    subject: 'Delivery Status Notification (Failure)',
    body: 'Address not found: buyer@example.org',
    occurredAt: '2026-11-02T08:00:00Z',
  };
  assert.equal(customerEmailValidity(lead, [sent, bounce]), '失效');
  assert.equal(
    customerEmailValidity(lead, [sent, bounce, { ...sent, occurredAt: '2026-11-03T08:00:00Z' }]),
    '失效',
  );
  assert.equal(
    customerEmailValidity(lead, [sent, { ...bounce, body: 'Message blocked by policy' }]),
    '有效',
  );
  assert.equal(customerEmailValidity(lead, [{ ...sent, to: 'other@example.org' }]), '待核验');
  assert(
    !Object.hasOwn(customerMirrorFields([lead], { messages: [sent] })[0].fields, '邮箱有效性'),
  );
});

test('原T3后台同步调用并缓存来信分析，切换目标表后不复用旧同步成功标记', async () => {
  const env = {
    FEISHU_APP_TOKEN: 'base',
    FEISHU_TABLE_ID: 't2',
    FEISHU_MESSAGES_TABLE_ID: 'original-t3',
  };
  let calls = 0,
    syncs = 0;
  const api = new CustomerBusinessApi({
    getEnv: () => env,
    knowledge: () => ({ list: () => [] }),
    loadCustomers: async () => [],
    communicationModel: {
      research: async () => {
        calls++;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  replyType: '真人客户回复',
                  classificationQuote: 'No new suppliers needed.',
                  facts: [],
                  demandSummary: '暂不考虑新供应商。',
                  demandQuote: 'No new suppliers needed.',
                }),
              },
            },
          ],
        };
      },
    },
  });
  try {
    const state = api.state();
    state.store.put('messages', {
      id: 'message',
      customerId: 'one',
      conversationId: 'conversation',
      channel: 'email',
      direction: 'inbound',
      actualConfirmed: true,
      body: 'No new suppliers needed.',
      from: 'buyer@example.org',
      account: 'sales@example.com',
      classification: 'normal',
    });
    state.mirror = {
      sync: async (workspace) => {
        syncs++;
        assert.equal(workspace.messages[0].replyAnalysis.demandSummary, '暂不考虑新供应商。');
        return { status: 'synced' };
      },
    };
    assert.equal((await api.synchronize({ force: false })).status, 'synced');
    assert.equal((await api.synchronize()).status, 'synced');
    assert.equal(calls, 1);
    assert.equal(syncs, 2);
    assert.equal((await api.synchronize({ force: false })).status, 'synced');
    assert.equal(syncs, 2);
    env.FEISHU_MESSAGES_TABLE_ID = 'other-t3';
    assert.notEqual(api.state(), state);
  } finally {
    await api.close();
  }
});

test('后台同步直接登记已识别的普通外出回执，仍从真人询价创建采购需求', async () => {
  const samples = [
    [
      'alpine',
      'Automatic reply: out of office',
      'I am out of the office until Monday.',
      'auto_reply',
    ],
    [
      'bay',
      'Out of office',
      'Thank you for your email.\nI am away from the office this week.',
      'normal',
    ],
    ['cedar', 'Quote request', 'Please send a quote for 120 units of PVC shutters.', 'normal'],
    [
      'delegate',
      'Out of office',
      'I am out of the office until Monday.\nFor urgent matters, contact Jordan Lee at jordan@alpine.example.',
      'auto_reply',
    ],
    [
      'mixed',
      'Out of office',
      'I am out of the office until Monday.\nPlease send a quote for 100 units.',
      'auto_reply',
    ],
  ];
  const expectedCustomer = new Set(samples.map(([id]) => id));
  const trace = [];
  let mirrored;
  const api = new CustomerBusinessApi({
    getEnv: () => ({ FEISHU_MESSAGES_TABLE_ID: 'original-t3' }),
    knowledge: () => ({ list: () => [] }),
    loadCustomers: async () => [...expectedCustomer].map((id) => ({ id, fields: {} })),
    customerRecord: async (id) => (expectedCustomer.has(id) ? { record_id: id } : null),
    communicationModel: {
      research: async ({ schema, messages }) => {
        const { body } = JSON.parse(messages[1].content);
        const [id] = samples.find(([, , original]) => original === body);
        const demand = schema.required.includes('demands');
        trace.push([id, demand ? 'T1' : 'T3']);
        const data = demand
          ? {
              reviewReason: '',
              demands: [
                {
                  existingId: '',
                  title: 'PVC 百叶窗询价',
                  productText: 'PVC shutters',
                  specifications: '',
                  quantity: '120',
                  unit: 'units',
                  quote: body,
                },
              ],
            }
          : {
              replyType: id === 'cedar' ? '真人客户回复' : '系统自动回复',
              classificationQuote: body,
              facts: [],
              demandSummary: id === 'cedar' ? 'PVC 百叶窗 120 件' : '',
              demandQuote: id === 'cedar' ? body : '',
            };
        return { output_text: JSON.stringify(data) };
      },
    },
  });
  const { store, mirror } = api.state();
  mirror.sync = async ({ messages }) => {
    mirrored = communicationRounds(messages).rounds.map((round) => ({
      customer: round.members[0].customerId,
      ...communicationRoundFields(round),
    }));
    return { status: 'synced' };
  };
  const account = 'sales@example.test';
  async function receive([id, subject, bodyText, classification], customerId = id) {
    return recordMailConversation({
      store,
      conversation: { customerId, account, id: 'thread-' + id, subject },
      messages: [
        {
          id: 'mail-' + id,
          messageId: '<mail-' + id + '@example.test>',
          direction: 'inbound',
          from: id + '@buyer.example',
          to: account,
          subject,
          bodyText,
          classification,
          deliveryStatus: 'received',
          occurredAt: '2026-11-10T01:00:00.000Z',
        },
      ],
    });
  }
  try {
    for (const sample of samples.slice(0, 3)) assert.equal((await receive(sample)).recorded, 1);
    const initial = await api.synchronize({ force: false });
    assert.equal(initial.status, 'synced', initial.error);
    assert.deepEqual(trace, [
      ['cedar', 'T1'],
      ['cedar', 'T3'],
    ]);
    assert.equal(mirrored.length, 3);
    for (const [id, , body] of samples.slice(0, 3)) {
      const row = mirrored.find((row) => row.customer === id);
      assert.equal(row.回复类型, id === 'cedar' ? '真人客户回复' : '系统自动回复');
      assert.equal(row.提取客户信息, '来信邮箱：' + id + '@buyer.example');
      assert(row.收到回复内容.endsWith(body));
      assert(row.收到回复内容.includes(id + '@buyer.example'));
    }
    const read = async (kind) =>
      (await api.handle({ method: 'GET' }, new URL('http://localhost/api/v1/business/' + kind)))
        .body.records;
    let demands = await read('demands');
    assert.equal(demands.length, 1);
    const [d] = demands;
    const quote = (await read('messages')).find((m) => m.customerId === 'cedar');
    assert.deepEqual(
      [d.customerId, d.productText, d.quantity, d.unit, d.sourceMessageId, d.evidenceQuote],
      ['cedar', 'PVC shutters', '120', 'units', quote.id, samples[2][2]],
    );

    for (const sample of samples.slice(3)) assert.equal((await receive(sample)).recorded, 1);
    assert.equal((await receive(['unassigned', ...samples[0].slice(1)], null)).recorded, 0);
    assert.equal((await api.synchronize({ force: false })).status, 'synced');
    assert.deepEqual(trace, [
      ['cedar', 'T1'],
      ['cedar', 'T3'],
      ['mixed', 'T3'],
    ]);
    assert.equal(mirrored.length, 5);
    const delegate = mirrored.find((row) => row.customer === 'delegate');
    assert.equal(delegate.提取客户信息, '来信邮箱：delegate@buyer.example');
    assert(delegate.收到回复内容.endsWith(samples[3][2]));
    demands = await read('demands');
    assert.equal(demands.length, 1);
    assert.equal((await api.synchronize({ force: false })).status, 'synced');
    assert.equal(trace.length, 3);
  } finally {
    await api.close();
  }
});

test('镜像只以实际正常收发推进状态及时间，排除自动回复和未知结果', () => {
  const message = {
    customerId: 'one',
    actualConfirmed: true,
    classification: 'normal',
    occurredAt: '2026-11-01T08:00:00Z',
  };
  const workspace = {
    demands: [],
    customerContexts: [],
    messages: [
      { ...message, direction: 'outbound', deliveryStatus: 'accepted' },
      {
        ...message,
        direction: 'inbound',
        deliveryStatus: 'received',
        occurredAt: '2026-11-02T08:00:00Z',
      },
      {
        ...message,
        direction: 'inbound',
        deliveryStatus: 'received',
        classification: 'auto_reply',
        occurredAt: '2026-11-03T08:00:00Z',
      },
      {
        ...message,
        direction: 'outbound',
        deliveryStatus: 'unknown',
        occurredAt: '2026-11-04T08:00:00Z',
      },
    ],
  };
  const [one, two] = customerMirrorFields(
    [
      { id: 'one', grade: 'A', status: '待开发' },
      { id: 'two', grade: 'C', status: '待开发' },
    ],
    workspace,
  );
  assert.equal(one.fields.开发状态, '已回复');
  assert.equal(one.fields.最近联系时间, Date.parse(message.occurredAt));
  assert.equal(one.fields.最近回复时间, Date.parse('2026-11-02T08:00:00Z'));
  assert.equal(two.fields.开发状态, '待开发');
  assert.equal(two.fields.最近联系时间, null);
});

test('所有供货方向均明确不匹配才移出日常视图，市场不符或证据缺失不误判', () => {
  const no = { dimensions: { P: { score: 0 }, R: { score: 30 } } };
  const yes = { dimensions: { P: { score: 40 }, R: { score: 30 } } };
  for (const [opportunities, expected] of [
    [[no], false],
    [[no, yes], true],
    [[{ status: 'rejected', dimensions: {} }], true],
    [[], true],
  ]) {
    const lead = { id: 'one', grade: 'C', assessment: { opportunities } };
    assert.equal(isDevelopmentCustomer(lead), expected);
    assert.equal(customerMirrorFields([lead], {})[0].fields.初评结果, expected ? 'C' : null);
  }
});

test('一分钟后台同步、失败持久化、重启重试和未变化时不重复写镜像', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mirror-worker-'));
  const env = {
    BATCH_DB_PATH: join(root, 'business.sqlite'),
    FEISHU_APP_TOKEN: 'base',
    FEISHU_TABLE_ID: 't2',
  };
  let writes = 0,
    fail = true;
  const create = () => {
    const api = new CustomerBusinessApi({
      getEnv: () => env,
      knowledge: () => ({ list: () => [] }),
      loadCustomers: async () => [],
    });
    api.state().mirror = {
      sync: async () => {
        writes++;
        if (fail) throw Error('offline');
        return { status: 'synced' };
      },
    };
    return api;
  };
  let api = create();
  try {
    t.mock.timers.enable({ apis: ['setInterval'] });
    api.start();
    t.mock.timers.tick(59999);
    assert.equal(writes, 0);
    t.mock.timers.tick(1);
    await api.syncTail;
    assert.equal(writes, 1);
    assert.equal(
      api.state().store.db.prepare('SELECT error FROM customer_business_sync').get().error,
      'offline',
    );
    await api.close();
    api = create();
    fail = false;
    assert.equal((await api.synchronize({ force: false })).status, 'synced');
    assert.equal(writes, 2);
    await api.synchronize({ force: false });
    assert.equal(writes, 2);
  } finally {
    await api.close();
    t.mock.timers.reset();
    rmSync(root, { recursive: true, force: true });
  }
});
