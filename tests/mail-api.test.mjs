import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';

const operatorToken = 'fixture-mail-operator-token-32-characters-long';

async function startHarness() {
  const calls = [];
  const mail = {
    status: () => ({
      mode: 'test_only',
      mailbox: { address: 'fixture@example.com', configured: false },
      agent: { status: 'not_running' },
    }),
    listConversations: () => ({ items: [] }),
    getConversation: (id) => ({ conversation: { id }, messages: [], draft: null }),
    saveDraft: (id, body) => {
      calls.push(['draft', id, body]);
      return { bodyText: body.bodyText, revision: 1, status: 'pending_review' };
    },
    sendTechnicalTest: async (body) => {
      calls.push(['test-send', body]);
      return { accepted: true };
    },
    sendReply: async (id, body) => {
      calls.push(['reply', id, body]);
      return { accepted: true };
    },
    sync: async () => {
      calls.push(['sync']);
      return { imported: 0 };
    },
    start: () => {},
    close: () => {},
  };
  const app = createApp({
    env: {
      ACQUISITION_PROVIDER: 'n8n',
      MAIL_OPERATOR_TOKEN: operatorToken,
      BATCH_DB_PATH: ':memory:',
      SCHEDULE_DB_PATH: ':memory:',
    },
    mailServiceFactory: () => mail,
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.address().port}`;
  return {
    calls,
    request: (path, options = {}) =>
      fetch(base + path, {
        ...options,
        headers: {
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...options.headers,
        },
      }),
    close: () => new Promise((resolve) => app.close(resolve)),
  };
}

test('真实邮件接口需本机操作者口令，未授权不能读会话或触发发信', async () => {
  const h = await startHarness();
  try {
    const unauthenticated = await h.request('/api/v1/mail/status');
    assert.equal(unauthenticated.status, 401);
    const wrong = await h.request('/api/v1/mail/conversations', {
      headers: { 'X-Mail-Operator-Token': 'wrong' },
    });
    assert.equal(wrong.status, 401);
    const send = await h.request('/api/v1/mail/test-send', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
      headers: { 'Idempotency-Key': 'test-send-01' },
    });
    assert.equal(send.status, 401);
    assert.deepEqual(h.calls, []);
    const authorized = await h.request('/api/v1/mail/status', {
      headers: { 'X-Mail-Operator-Token': operatorToken },
    });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).mode, 'test_only');
  } finally {
    await h.close();
  }
});

test('邮件写接口透传确认、草稿版本和幂等键，拒绝无键发送', async () => {
  const h = await startHarness();
  const auth = { 'X-Mail-Operator-Token': operatorToken };
  try {
    const missingKey = await h.request('/api/v1/mail/test-send', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
      headers: auth,
    });
    assert.equal(missingKey.status, 400);
    assert.deepEqual(h.calls, []);

    const draft = await h.request('/api/v1/mail/conversations/test-01/draft', {
      method: 'PUT',
      body: JSON.stringify({ bodyText: 'Test reply', expectedRevision: 0 }),
      headers: auth,
    });
    assert.equal(draft.status, 200);
    const reply = await h.request('/api/v1/mail/conversations/test-01/reply', {
      method: 'POST',
      body: JSON.stringify({ draftRevision: 1, confirmed: true }),
      headers: { ...auth, 'Idempotency-Key': 'reply-test-01' },
    });
    assert.equal(reply.status, 200);
    const sync = await h.request('/api/v1/mail/sync', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true }),
      headers: auth,
    });
    assert.equal(sync.status, 200);
    assert.deepEqual(h.calls, [
      ['draft', 'test-01', { bodyText: 'Test reply', expectedRevision: 0 }],
      [
        'reply',
        'test-01',
        {
          draftRevision: 1,
          confirmed: true,
          idempotencyKey: 'reply-test-01',
        },
      ],
      ['sync'],
    ]);
  } finally {
    await h.close();
  }
});
