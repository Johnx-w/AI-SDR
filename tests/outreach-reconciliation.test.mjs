import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutreachService } from '../server/outreach-service.mjs';
import { saveSequencePolicy } from '../server/outreach-sequence-policy.mjs';
import { handleOutreach } from '../server/outreach-api.mjs';

const at = '2026-11-12T02:00:00.000Z';
const mailbox = { id: 'sales', email: 'sales@brand.example', configured: true };
const messageId = '<first-touch@brand.example>';
const delivery = (id, extra = {}) => ({
  id,
  campaignId: 'campaign',
  customerId: 'buyer',
  mode: 'production',
  status: 'unknown',
  mailboxId: mailbox.id,
  from: mailbox.email,
  to: 'buyer@customer.example',
  messageId,
  attemptedAt: at,
  candidate: {
    customerId: 'buyer',
    companyDomain: 'customer.example',
    to: 'buyer@customer.example',
  },
  ...extra,
});
const sent = (extra = {}) => ({
  uid: 1,
  messageId,
  from: mailbox.email,
  to: 'buyer@customer.example',
  direction: 'outbound',
  subject: 'First touch',
  bodyText: 'Hello',
  occurredAt: at,
  bodyFormatVersion: 2,
  ...extra,
});
const batch = (messages, nextUid = 2) => ({
  folders: [{ path: 'Sent', sent: true, uidValidity: '1', nextUid, messages }],
  hasMore: false,
});

function harness(t, { path = ':memory:', loadLeads = async () => [], recordAccepted } = {}) {
  const reads = [];
  let response = batch([]);
  const mailboxes = {
    list: () => [mailbox],
    readMailbox: async (id) => {
      reads.push(id);
      return structuredClone(response);
    },
    send: () => {
      throw new Error('Reconciliation must not send mail');
    },
  };
  const options = {
    path,
    mailboxes,
    loadLeads,
    recordAccepted,
    products: () => [],
    now: () => Date.parse(at),
  };
  const service = new OutreachService(options);
  t.after(() => service.close());
  return {
    service,
    options,
    reads,
    respond: (value) => {
      response = value;
    },
  };
}

test('仅正式 unknown 可核实；IMAP 原邮箱准确发送证据才确认已发送', async (t) => {
  const recorded = [];
  const h = harness(t, { recordAccepted: async (item) => recorded.push(item.id) });
  h.service.putDelivery(delivery('unknown'));
  h.service.putDelivery(delivery('test', { mode: 'internal_test' }));
  h.service.putDelivery(delivery('blocked', { status: 'blocked' }));
  for (const id of ['test', 'blocked'])
    await assert.rejects(h.service.reconcileDelivery(id), { status: 409 });
  for (const id of ['test', 'blocked'])
    await assert.rejects(
      h.service.resolveDelivery(id, {
        outcome: 'failed',
        evidence: '供应商日志证明未提交',
        operator: '测试员',
      }),
      { status: 409 },
    );

  h.respond(batch([sent({ messageId: '<another@brand.example>' })]));
  const url = new URL('http://localhost/api/v1/outreach/deliveries/unknown/reconcile');
  const apiCall = () =>
    handleOutreach({
      request: { method: 'POST' },
      url,
      service: h.service,
      readJson: async () => ({}),
    });
  const unresolved = await apiCall();
  assert.equal(unresolved.status, 'unknown');
  assert.equal(unresolved.reconciliation.result, 'unconfirmed');
  assert.equal(h.reads.length, 1);

  h.respond(batch([sent({ uid: 2 })], 3));
  const resolved = await apiCall();
  assert.equal(resolved.status, 'accepted');
  assert.equal(resolved.resolution.source, 'imap');
  assert.match(resolved.resolution.evidence, /UID 2.*Message-ID/);
  assert.equal(resolved.candidate, undefined, 'API 不返回内部候选快照');
  assert.equal(h.service.delivery('unknown').sentAt, at);
  assert.deepEqual(recorded, ['unknown']);
  assert.equal(h.service.delivery('unknown').businessRecordedAt, at);
  await assert.rejects(h.service.reconcileDelivery('unknown'), { status: 409 });
});

test('首封结果未知时等待已发件证据，追信到期相对于实际发出时间', async (t) => {
  const h = harness(t);
  h.service.putCampaign({
    id: 'campaign',
    status: 'active',
    followUpEnabled: true,
    mailboxIds: [mailbox.id],
  });
  h.service.putDelivery(delivery('unknown', { followUpAtSubmission: true }));
  await h.service.reconcileDelivery('unknown');
  assert.equal(h.service.followUps.all().length, 0);
  saveSequencePolicy(h.service, {
    revision: 1,
    name: '之后的首封',
    steps: [{ day: 11, instruction: '确认需求' }],
  });
  const actual = '2026-11-12T02:06:00.000Z';
  h.respond(batch([sent({ occurredAt: actual })]));
  await h.service.reconcileDelivery('unknown');
  assert.deepEqual(
    h.service.followUps.all().map((a) => a.dueAt),
    ['2026-11-15T02:06:00.000Z', '2026-11-19T02:06:00.000Z'],
  );
});
test('同 Message-ID 但发件人或收件人不一致不能确认，也不能人工判为未提交', async (t) => {
  const h = harness(t);
  h.service.putDelivery(delivery('unknown'));
  h.respond({
    folders: [{ path: 'INBOX', sent: false, uidValidity: '1', nextUid: 2, messages: [sent()] }],
    hasMore: false,
  });
  assert.equal((await h.service.reconcileDelivery('unknown')).status, 'unknown');
  h.respond(batch([sent({ from: 'other@brand.example' })]));
  assert.equal((await h.service.reconcileDelivery('unknown')).status, 'unknown');
  h.respond(batch([sent({ uid: 2, to: 'other@customer.example' })], 3));
  assert.equal((await h.service.reconcileDelivery('unknown')).status, 'unknown');

  h.respond(batch([sent({ uid: 3, toAddresses: ['buyer@customer.example'] })], 4));
  await h.service.conversations.sync({ mailboxId: mailbox.id });
  await assert.rejects(
    h.service.resolveDelivery('unknown', {
      outcome: 'failed',
      evidence: '供应商日志显示未提交',
      operator: '测试员',
    }),
    { status: 409 },
  );
  assert.equal(h.service.delivery('unknown').status, 'unknown');
});

test('后台首次发现正式未知结果时自动核实一次，不提交邮件', async (t) => {
  const h = harness(t);
  h.service.putDelivery(delivery('automatic', { status: 'sending' }));
  h.service.putDelivery(delivery('automatic'));
  h.respond(batch([sent()]));
  await h.service.runTick();
  assert.equal(h.service.delivery('automatic').status, 'accepted');
  const reads = h.reads.length;
  await h.service.runTick();
  assert.equal(h.reads.length, reads);
});

test('上线前已存在的未知发送记录留待人工核实，后台不批量处理', async (t) => {
  const h = harness(t);
  const old = delivery('historical');
  h.service.db
    .prepare('INSERT INTO outreach_deliveries VALUES(?,?,?,?)')
    .run(old.id, old.campaignId, old.status, JSON.stringify(old));
  h.respond(batch([sent()]));
  await h.service.runTick();
  assert.equal(h.service.delivery(old.id).status, 'unknown');
  assert.equal(h.service.delivery(old.id).reconciliation, undefined);
  assert.equal((await h.service.reconcileDelivery(old.id)).status, 'accepted');
});

test('人工结论要求操作人与依据；明确失败释放占用且旧计划重查不重发，重启保留结论', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'outreach-reconciliation-'));
  const h = harness(t, {
    path: join(directory, 'outreach.sqlite'),
    loadLeads: async () => [{ id: 'buyer' }],
  });
  let reopened;
  t.after(async () => {
    await reopened?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  h.service.putCampaign({
    id: 'campaign',
    scope: 'local',
    status: 'active',
    revision: 1,
    filters: { markets: [], grades: [], products: [] },
    mailboxIds: [mailbox.id],
    includeExisting: true,
    baselineCustomerIds: ['buyer'],
  });
  h.service.putDelivery(delivery('unknown'));
  h.service.reserve(delivery('unknown'));
  assert.equal(h.service.db.prepare('SELECT count(*) AS n FROM outreach_reservations').get().n, 3);
  for (const input of [
    { outcome: 'accepted', evidence: '服务商日志编号 123' },
    { outcome: 'failed', operator: '测试员' },
  ])
    await assert.rejects(h.service.resolveDelivery('unknown', input), { status: 400 });
  assert.equal(h.service.delivery('unknown').status, 'unknown');
  assert.equal((await h.service.state()).deliveryGroups.attention, 1);

  const resolved = await h.service.resolveDelivery('unknown', {
    outcome: 'failed',
    evidence: '服务商日志明确显示 SMTP 未接收；编号 123',
    operator: '测试员',
  });
  assert.equal(resolved.status, 'failed');
  assert.equal(resolved.resolution.source, 'manual');
  assert.equal(resolved.resolution.operator, '测试员');
  assert.equal(resolved.resolution.at, at);
  assert.equal(h.service.db.prepare('SELECT count(*) AS n FROM outreach_reservations').get().n, 0);
  const groups = (await h.service.state()).deliveryGroups;
  assert.equal(groups.attention, 0);
  assert.equal(groups.resolved, 1);
  assert.deepEqual(await h.service.candidates(h.service.campaign('campaign')), {
    eligible: [],
    blocked: [],
  });

  await h.service.close();
  reopened = new OutreachService(h.options);
  assert.deepEqual(reopened.delivery('unknown').resolution, resolved.resolution);
  assert.deepEqual(await reopened.candidates(reopened.campaign('campaign')), {
    eligible: [],
    blocked: [],
  });
});

test('删除后自动核实仍使用原邮箱证据且不建立新追信', async (t) => {
  const h = harness(t);
  h.service.putCampaign({
    id: 'campaign',
    mode: 'production',
    status: 'completed',
    revision: 2,
    followUpEnabled: true,
  });
  h.service.putDelivery(delivery('deleted-unknown', { followUpAtSubmission: true }));
  h.service.reserve(h.service.delivery('deleted-unknown'));
  h.service.deleteCampaign('campaign', 2, true);
  h.respond(batch([sent()]));
  const resolved = await h.service.reconcileDelivery('deleted-unknown');
  assert.equal(resolved.status, 'accepted');
  assert.equal(resolved.resolution.source, 'imap');
  assert.match(resolved.resolution.evidence, /UID 1.*Message-ID/);
  assert.equal(h.service.followUps.all().length, 0);
  assert.equal(h.service.isReserved(resolved.candidate), true);
});
