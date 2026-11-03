import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutreachService } from '../server/outreach-service.mjs';
import { OutreachMailboxes } from '../server/outreach-mailboxes.mjs';

function buyer(id = 'buyer-one') {
  const domain = `${id}.example.org`;
  return {
    id,
    name: id,
    website: `https://${domain}`,
    market: 'Australia',
    grade: 'B',
    status: '待开发',
    email: `info@${domain}`,
    type: '经销商',
    product: 'PVC shutters',
    facts: [
      {
        field: 'entity_type',
        value: 'business',
        quote: 'We are a window furnishing business.',
        source_url: `https://${domain}/about`,
      },
      {
        field: 'products',
        value: 'PVC shutters',
        quote: 'We supply PVC shutters.',
        source_url: `https://${domain}/products`,
      },
    ],
    contactEvidence: [
      {
        kind: 'email',
        value: `info@${domain}`,
        quote: `Email info@${domain}`,
        source_url: `https://${domain}/contact`,
      },
    ],
  };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'outreach-development-'));
  const state = {
    clock: Date.parse('2026-10-27T04:00:00Z'),
    leads: [buyer()],
    contexts: [],
    transportGate: null,
    generateGate: null,
    smtpGate: null,
    scope: 'customer-table-one',
  };
  const sent = [];
  const mailboxes = new OutreachMailboxes({
    path: join(directory, 'mailboxes.json'),
    seedPath: null,
    protect: async (value) => ({
      credentialProtection: 'windows-dpapi-current-user',
      credential: Buffer.from(value).toString('base64'),
    }),
    unprotect: async (value) => Buffer.from(value, 'base64').toString('utf8'),
    transportFactory: async () => {
      if (state.transportGate) await state.transportGate();
      return {
        verify: async () => true,
        sendMail: async (message) => {
          sent.push(message);
          if (state.smtpGate) await state.smtpGate();
          return { accepted: [message.to], rejected: [] };
        },
        close() {},
      };
    },
  });
  for (const id of ['brand-a', 'brand-b']) {
    await mailboxes.save({
      id,
      email: `sales@${id}.example.org`,
      signature: id,
      displayName: id,
      productIds: ['pvc'],
      paused: false,
      clientPassword: 'synthetic-password',
      intervalSeconds: 30,
    });
    await mailboxes.verify(id);
  }
  const product = {
    id: 'pvc',
    name: 'PVC shutters',
    englishName: 'PVC shutters',
    direction: 'finished',
    status: 'approved',
    version: 1,
    markets: [],
  };
  const service = new OutreachService({
    mailboxes,
    now: () => state.clock,
    tickMs: 3600000,
    loadLeads: async () => structuredClone(state.leads),
    customers: () => state.leads,
    products: () => [product],
    businessState: () => ({ customerContexts: state.contexts }),
    getScope: () => state.scope,
    generator: {
      configured: true,
      generate: async () => {
        if (state.generateGate) await state.generateGate();
        return { subject: 'PVC shutters', bodyText: 'Our approved shutter range.' };
      },
    },
  });
  t.after(async () => {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const setDevelopment = (id, paused, version) => {
    state.contexts = state.contexts.filter((row) => row.customerId !== id);
    state.contexts.push({ customerId: id, development: { paused, version } });
  };
  const prepare = async (overrides = {}) => {
    const campaign = service.saveCampaign({
      name: 'Development controls',
      mailboxIds: ['brand-a', 'brand-b'],
      targetCount: 10,
      intervalSeconds: 30,
      includeExisting: true,
      continuous: false,
      filters: { markets: ['Australia'] },
      outreachClaims: [{ productId: 'pvc', productVersion: 1, text: 'We supply PVC shutters.' }],
      ...overrides,
    });
    service.prepare(campaign.id);
    await service.preparing.get(campaign.id);
    return service.campaign(campaign.id);
  };
  const enableProduction = async () => {
    const { campaign } = service.internalTest({
      confirmed: true,
      idempotencyKey: 'development-internal-test',
      expectedMailboxIds: ['brand-a', 'brand-b'],
    });
    await service.tick();
    for (const row of service.deliveries(campaign.id)) service.confirmInternalReceipt(row.id);
    service.approveReview(true);
    state.clock += 31000;
    sent.length = 0;
  };
  return { service, mailboxes, state, sent, setDevelopment, prepare, enableProduction };
}

test('暂缓以客户编号拦截所有计划和联系人，不影响其他客户', async (t) => {
  const h = await harness(t);
  h.state.leads.push(buyer('buyer-two'));
  h.setDevelopment('buyer-one', true, 1);
  for (const name of ['First plan', 'Another plan']) {
    const campaign = await h.prepare({ name });
    const rows = h.service.deliveries(campaign.id);
    assert.ok(
      rows.some(
        (row) =>
          row.customerId === 'buyer-one' && row.status === 'blocked' && /暂缓开发/.test(row.reason),
      ),
    );
    assert.ok(!rows.some((row) => row.customerId === 'buyer-one' && row.status === 'draft'));
  }
  assert.ok(
    h.service.deliveries().some((row) => row.customerId === 'buyer-two' && row.status === 'draft'),
  );
  const alternate = 'another@buyer-one.example.org';
  h.state.leads[0].email = alternate;
  h.state.leads[0].contactEvidence[0].value = alternate;
  h.state.leads[0].contactEvidence[0].quote = `Email ${alternate}`;
  const campaign = await h.prepare({ name: 'Alternate recipient' });
  assert.match(
    h.service.deliveries(campaign.id).find((row) => row.customerId === 'buyer-one').reason,
    /暂缓开发/,
  );
});

test('已排队邮件遇到客户暂缓转待核对，其他客户继续发送', async (t) => {
  const h = await harness(t);
  await h.enableProduction();
  h.state.leads.push(buyer('buyer-two'));
  const campaign = await h.prepare();
  h.service.approve(campaign.id, campaign.revision);
  h.setDevelopment('buyer-one', true, 1);
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  const blocked = h.service.deliveries(campaign.id).find((row) => row.customerId === 'buyer-one');
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.reason, /暂缓开发/);
  assert.deepEqual(
    h.sent.map((message) => message.to),
    [buyer('buyer-two').email],
  );
  assert.equal(
    h.mailboxes.list().some((box) => box.paused),
    false,
  );
});

test('暂缓后立即恢复也不能发送旧草稿，审核旧版本时明确拒绝并释放占用', async (t) => {
  const h = await harness(t);
  const campaign = await h.prepare();
  const draft = h.service.deliveries(campaign.id)[0];
  h.setDevelopment(draft.customerId, false, 2);
  assert.throws(() => h.service.approve(campaign.id, campaign.revision), { status: 409 });
  assert.equal(h.service.delivery(draft.id).status, 'blocked');
  assert.match(h.service.delivery(draft.id).reason, /重新准备并审核/);
  assert.equal(h.service.isReserved(draft.candidate), false);
});

test('已审核旧草稿在客户暂缓并恢复后仍不能发送', async (t) => {
  const h = await harness(t);
  await h.enableProduction();
  const campaign = await h.prepare();
  h.service.approve(campaign.id, campaign.revision);
  h.setDevelopment('buyer-one', false, 2);
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.service.deliveries(campaign.id)[0].status, 'blocked');
});

test('恢复后可直接重新准备新草稿，旧草稿占用自动释放但新草稿仍需审核', async (t) => {
  const h = await harness(t);
  const campaign = await h.prepare();
  h.service.approve(campaign.id, campaign.revision);
  const old = h.service.deliveries(campaign.id)[0];
  h.setDevelopment('buyer-one', false, 2);
  h.service.prepare(campaign.id);
  await h.service.preparing.get(campaign.id);
  assert.equal(h.service.delivery(old.id).status, 'cancelled');
  const fresh = h.service.deliveries(campaign.id).find((row) => row.status === 'draft');
  assert.notEqual(fresh.id, old.id);
  assert.equal(fresh.developmentVersion, 2);
  assert.equal(h.service.campaign(campaign.id).approvedRevision, null);
  assert.throws(() => h.service.activate(campaign.id, campaign.revision), { status: 409 });
});

for (const recovered of [false, true])
  test(`SMTP连接准备期间暂缓${recovered ? '并恢复' : ''}，实际SMTP提交前仍被拦截`, async (t) => {
    const h = await harness(t);
    await h.enableProduction();
    const campaign = await h.prepare();
    h.service.approve(campaign.id, campaign.revision);
    const entering = deferred(),
      release = deferred();
    h.state.transportGate = () => {
      entering.resolve();
      return release.promise;
    };
    h.service.activate(campaign.id, campaign.revision);
    await entering.promise;
    h.setDevelopment('buyer-one', !recovered, recovered ? 2 : 1);
    release.resolve();
    await h.service.tick();
    const row = h.service.deliveries(campaign.id)[0];
    assert.equal(row.status, 'blocked');
    assert.equal(row.attemptedAt, undefined, '未交给SMTP的邮件不保留真实发送尝试');
    assert.equal(h.sent.length, 0);
    assert.equal(h.mailboxes.get(row.mailboxId).paused, false);
  });

test('生成期间改变开发安排，迟到的样稿不能入队或继续占用客户', async (t) => {
  const h = await harness(t);
  const entering = deferred(),
    release = deferred();
  h.state.generateGate = () => {
    entering.resolve();
    return release.promise;
  };
  const preparing = h.prepare();
  await entering.promise;
  h.setDevelopment('buyer-one', false, 2);
  release.resolve();
  const campaign = await preparing;
  const row = h.service.deliveries(campaign.id)[0];
  assert.equal(row.status, 'blocked');
  assert.equal(h.service.isReserved(row.candidate), false);
});

test('SMTP连接准备期间切换客户表，即使客户开发版本相同也不能发送旧表邮件', async (t) => {
  const h = await harness(t);
  await h.enableProduction();
  const campaign = await h.prepare();
  h.service.approve(campaign.id, campaign.revision);
  const entering = deferred(),
    release = deferred();
  h.state.transportGate = () => {
    entering.resolve();
    return release.promise;
  };
  h.service.activate(campaign.id, campaign.revision);
  await entering.promise;
  h.state.scope = 'customer-table-two';
  release.resolve();
  await h.service.tick();
  const row = h.service.deliveries(campaign.id)[0];
  assert.equal(row.status, 'blocked');
  assert.match(row.reason, /客户数据来源已改变/);
  assert.equal(h.sent.length, 0);
  assert.equal(h.mailboxes.get(row.mailboxId).paused, false);
});

test('已经交给SMTP的邮件保留实际发送结果，暂缓不伪装成可撤回或释放重复发送占用', async (t) => {
  const h = await harness(t);
  await h.enableProduction();
  const campaign = await h.prepare();
  h.service.approve(campaign.id, campaign.revision);
  const entering = deferred(),
    release = deferred();
  h.state.smtpGate = () => {
    entering.resolve();
    return release.promise;
  };
  h.service.activate(campaign.id, campaign.revision);
  await entering.promise;
  h.setDevelopment('buyer-one', true, 1);
  release.resolve();
  await h.service.tick();
  const row = h.service.deliveries(campaign.id)[0];
  assert.equal(row.status, 'accepted');
  assert.equal(h.sent.length, 1);
  assert.equal(h.service.isReserved(row.candidate), true);
  assert.equal(h.service.development('buyer-one').paused, true);
});

test('活跃计划中新恢复客户仅生成待审核草稿，明确审核后才按原限制发信', async (t) => {
  const h = await harness(t);
  await h.enableProduction();
  const campaign = await h.prepare({ continuous: true });
  h.service.approve(campaign.id, campaign.revision);
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  await h.service.preparing.get(campaign.id);
  h.state.clock += 31000;
  h.state.leads.push(buyer('restored-buyer'), buyer('fresh-buyer'));
  h.setDevelopment('restored-buyer', false, 2);
  h.service.prepare(campaign.id);
  await h.service.preparing.get(campaign.id);
  const restored = h.service
    .deliveries(campaign.id)
    .find((row) => row.customerId === 'restored-buyer' && row.status === 'draft');
  assert.equal(restored.developmentVersion, 2);
  await h.service.tick();
  assert.equal(h.service.delivery(restored.id).status, 'draft');
  assert.ok(
    h.sent.some((message) => message.to === buyer('fresh-buyer').email),
    '其他客户继续自动发送',
  );
  assert.equal(
    h.sent.some((message) => message.to === buyer('restored-buyer').email),
    false,
  );
  h.service.approve(campaign.id, campaign.revision);
  assert.equal(h.service.delivery(restored.id).status, 'queued');
  h.state.clock += 31000;
  await h.service.tick();
  assert.equal(h.service.delivery(restored.id).status, 'accepted');
});

test('暂停再恢复整个计划不能绕过恢复客户新样稿的审核；暂停计划中审核不会启动发送', async (t) => {
  const h = await harness(t);
  await h.enableProduction();
  const campaign = await h.prepare({ continuous: true });
  h.service.approve(campaign.id, campaign.revision);
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  await h.service.preparing.get(campaign.id);
  h.state.clock += 31000;
  h.state.leads.push(buyer('restored-buyer'));
  h.setDevelopment('restored-buyer', false, 2);
  h.service.prepare(campaign.id);
  await h.service.preparing.get(campaign.id);
  const draft = h.service.deliveries(campaign.id).find((row) => row.status === 'draft');
  assert.equal(draft.customerId, 'restored-buyer');
  h.service.pause(campaign.id);
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  assert.equal(h.service.delivery(draft.id).status, 'draft');
  assert.equal(
    h.sent.some((message) => message.to === buyer('restored-buyer').email),
    false,
  );
  h.service.pause(campaign.id);
  h.service.approve(campaign.id, campaign.revision);
  assert.equal(h.service.campaign(campaign.id).status, 'paused');
  assert.equal(h.service.delivery(draft.id).status, 'draft');
  assert.equal(h.service.delivery(draft.id).developmentReviewedVersion, 2);
  await h.service.tick();
  assert.equal(
    h.sent.some((message) => message.to === buyer('restored-buyer').email),
    false,
  );
  h.service.activate(campaign.id, campaign.revision);
  await h.service.tick();
  assert.equal(h.service.delivery(draft.id).status, 'accepted');
});

test('客户暂缓时人工回信仍可发送，且发送不会解除客户暂缓', async (t) => {
  const h = await harness(t);
  h.setDevelopment('buyer-one', true, 1);
  h.mailboxes.saveSent = async () => ({ saved: true });
  const box = h.mailboxes.get('brand-a');
  h.service.conversations.putMessage(box, {
    messageId: '<buyer-reply@buyer-one.example.org>',
    direction: 'inbound',
    from: buyer().email,
    to: box.email,
    toAddresses: [box.email],
    subject: 'Please contact next month',
    bodyText: 'Can you confirm?',
    occurredAt: new Date(h.state.clock).toISOString(),
    deliveryStatus: 'received',
    source: 'imap',
  });
  const thread = h.service.conversations.list().items[0];
  const source = h.service.conversations.detail(thread.id).messages[0];
  const draft = h.service.replies.saveDraft(thread.id, {
    replyToMessageId: source.id,
    bodyHtml: '<p>Of course, we will contact you next month.</p>',
    attachments: [],
  });
  const result = await h.service.replies.reply(thread.id, {
    replyToMessageId: source.id,
    draftRevision: draft.revision,
    idempotencyKey: 'paused-manual-reply',
    bodyHtml: draft.bodyHtml,
    bodyText: draft.bodyText,
    attachments: draft.attachments,
  });
  assert.equal(result.reply.status, 'accepted');
  assert.equal(h.sent.length, 1);
  assert.equal(h.service.development('buyer-one').paused, true);
});
