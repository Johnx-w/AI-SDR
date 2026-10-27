import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { CustomerBusiness } from '../server/customer-business.mjs';

function fixture(options = {}) {
  let clock = '2026-10-27T16:30:00.000Z';
  const records = new Map(
    ['one', 'two'].map((id) => [id, { record_id: id, fields: { 开发状态: '待开发' } }]),
  );
  const config = {
    scope: 'app/customers',
    customer: async (id) => records.get(id),
    now: () => clock,
    ...options,
  };
  const store = new CustomerBusiness(config);
  return {
    store,
    config,
    records,
    advance: (value) => {
      clock = value;
    },
    pause: (value = {}, id = 'one') =>
      store.actDevelopment(id, {
        action: 'pause',
        expectedVersion: store.development(id).version,
        reason: '客户要求稍后联系',
        ...value,
      }),
    resume: (value = {}, id = 'one') =>
      store.actDevelopment(id, {
        action: 'resume',
        expectedVersion: store.development(id).version,
        reviewToken: store.developmentView(id).reviewToken,
        reviewed: true,
        resumeNotes: '核对新来信后重新准备草稿，再确认发送时间',
        ...value,
      }),
    task: (value = {}) =>
      store.saveTask({
        customerId: 'one',
        title: '确认联系安排',
        kind: 'first_contact',
        channel: 'email',
        executionMode: 'automatic',
        dueAt: '2026-10-29T01:00:00Z',
        ...value,
      }),
    conversation: () =>
      store.saveConversation({
        customerId: 'one',
        title: '采购沟通',
        channel: 'email',
        account: 'sales@seller.example',
        participant: 'buyer@buyer.example',
      }),
    message: (conversation, value = {}) =>
      store.saveMessage({
        customerId: 'one',
        conversationId: conversation.id,
        channel: 'email',
        account: conversation.account,
        direction: 'inbound',
        from: 'buyer@buyer.example',
        to: conversation.account,
        occurredAt: clock,
        body: 'Please contact us next month.',
        deliveryStatus: 'received',
        classification: 'normal',
        actualConfirmed: true,
        ...value,
      }),
  };
}

test('无沟通记录的新客户暂缓也进入全局上下文，状态、审计和版本跨重启持久且按客户表隔离', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'customer-development-'));
  const path = join(folder, 'state.sqlite');
  const f = fixture({ path });
  let reopened;
  let other;
  try {
    assert.equal(f.store.development('one').version, 0);
    const result = await f.pause({
      reason: '其他',
      notes: '内部确认供货范围',
      reviewDate: '2026-11-15',
      actor: '不可信姓名',
    });
    assert.equal(result.version, 1);
    assert.equal(result.paused, true);
    assert.equal(result.audit[0].actor, '人工操作');
    assert.equal(f.store.view().customerContexts[0].customerId, 'one');
    assert.equal(f.store.view({ customerId: 'two' }).customerContexts.length, 1);
    assert.equal(f.store.view({ customerId: 'two' }).customerContexts[0].development.paused, false);
    f.store.putContext({
      customerId: 'one',
      fixedEmail: 'sales@seller.example',
      doNotContact: true,
    });
    assert.equal(f.store.context('one').development.version, 1);
    f.store.close();
    reopened = new CustomerBusiness(f.config);
    assert.equal(reopened.development('one').reviewDate, '2026-11-15');
    assert.equal(reopened.context('one').doNotContact, true);
    assert.equal(reopened.contexts().length, 1);
    other = new CustomerBusiness({ ...f.config, scope: 'other/customers' });
    assert.equal(other.development('one').paused, false);
    assert.deepEqual(other.contexts(), []);
  } finally {
    if (reopened) reopened.close();
    else f.store.close();
    other?.close();
    assert.equal(dirname(folder), tmpdir());
    rmSync(folder, { recursive: true, force: true });
  }
});

test('暂停原因、其他说明、版本、操作和北京时间复查日期在写入前校验', async () => {
  const f = fixture();
  try {
    for (const value of [
      { reason: '' },
      { reason: '未知原因' },
      { reason: '其他', notes: ' ' },
      { expectedVersion: undefined },
      { expectedVersion: 2 },
      { action: 'cancel' },
      { reviewDate: '2026-02-30' },
      { reviewDate: '2026-10-27' },
      { reviewDate: '2026-10-29T12:00:00Z' },
    ])
      await assert.rejects(
        () => f.pause(value),
        (error) => [400, 409].includes(error.status),
      );
    assert.equal(f.store.contexts().length, 0);
    await assert.rejects(
      () => f.pause({}, 'absent'),
      (error) => error.status === 404,
    );
    const paused = await f.pause({ reviewDate: '2026-10-28' });
    assert.equal(paused.reviewDate, '2026-10-28', 'UTC 27日16:30已经是北京时间28日');
    await assert.rejects(
      () => f.pause(),
      (error) => error.status === 409,
    );
    await assert.rejects(
      () => f.store.actDevelopment('one', { action: 'review', expectedVersion: 1 }),
      (error) => error.status === 400,
    );
    const reviewed = await f.store.actDevelopment('one', {
      action: 'review',
      expectedVersion: 1,
      reviewDate: '',
    });
    assert.equal(reviewed.paused, true);
    assert.equal(reviewed.reviewDate, '');
    assert.equal(reviewed.version, 2);
    await assert.rejects(
      () => f.resume({ reviewed: false }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      () => f.resume({ resumeNotes: '' }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      () => f.resume({ reviewToken: '' }),
      (error) => error.status === 400,
    );
  } finally {
    f.store.close();
  }
});

test('暂停仅停止该客户的系统邮件任务，保存新任务和任务恢复不能绕过，客户恢复不补发旧任务', async () => {
  const f = fixture();
  try {
    const automatic = await f.task();
    const manual = await f.task({ executionMode: 'manual' });
    const phone = await f.task({ channel: 'phone' });
    const another = await f.task({ customerId: 'two' });
    await f.pause();
    const held = f.store.get('tasks', automatic.id);
    assert.equal(held.status, 'paused');
    assert.equal(held.audit.at(-1).action, 'customer_development_pause');
    for (const task of [manual, phone, another])
      assert.equal(f.store.get('tasks', task.id).status, 'pending');
    assert.equal((await f.task()).status, 'paused', '新建系统邮件任务保留暂停');
    await assert.rejects(
      () => f.store.actTask(held.id, { action: 'resume', expectedVersion: held.version }),
      /客户已暂缓/,
    );
    assert.equal((await f.store.preflightTask(manual.id)).ready, true);
    f.store.putContext({ customerId: 'one', doNotContact: true });
    const resumed = await f.resume();
    assert.equal(resumed.paused, false);
    assert.equal(f.store.context('one').doNotContact, true);
    assert.equal(f.store.get('tasks', automatic.id).status, 'paused');
  } finally {
    f.store.close();
  }
});

test('新来信和人工发信不解除暂缓；预览后出现新沟通或任务时旧核对版本不能恢复', async () => {
  const f = fixture();
  try {
    const conversation = await f.conversation();
    await f.pause();
    const preview = f.store.developmentView('one');
    await f.message(conversation);
    assert.equal(f.store.development('one').paused, true);
    assert.equal(f.store.context('one').fixedEmail, conversation.account);
    await assert.rejects(
      () => f.resume({ reviewToken: preview.reviewToken }),
      (error) => error.status === 409,
    );
    await f.message(conversation, {
      direction: 'outbound',
      from: conversation.account,
      to: 'buyer@buyer.example',
      deliveryStatus: 'sent',
      body: 'We will contact you next month.',
    });
    assert.equal(f.store.development('one').paused, true);
    const beforeTask = f.store.developmentView('one').reviewToken;
    await f.task({ executionMode: 'manual' });
    await assert.rejects(
      () => f.resume({ reviewToken: beforeTask }),
      (error) => error.status === 409,
    );
    const result = await f.resume();
    assert.equal(result.paused, false);
    assert.equal(result.audit.at(-1).action, 'resume');
    assert.equal(result.resumeNotes, '核对新来信后重新准备草稿，再确认发送时间');
  } finally {
    f.store.close();
  }
});

test('恢复在异步客户核验之后重新检查沟通版本，远端错误保留原错误且不修改控制', async () => {
  const f = fixture();
  try {
    await f.pause();
    let finish;
    f.store.customer = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const restoring = f.resume();
    f.store.put('messages', {
      id: 'new-reply',
      customerId: 'one',
      channel: 'email',
      direction: 'inbound',
      deliveryStatus: 'received',
      version: 1,
      occurredAt: '2026-10-28T01:00:00Z',
      updatedAt: '2026-10-28T01:00:00Z',
    });
    finish(f.records.get('one'));
    await assert.rejects(restoring, (error) => error.status === 409);
    f.store.customer = async () => {
      throw Object.assign(new Error('企业资料暂不可读'), { status: 502 });
    };
    await assert.rejects(
      () => f.resume(),
      (error) => error.status === 502,
    );
    assert.equal(f.store.development('one').paused, true);
  } finally {
    f.store.close();
  }
});
