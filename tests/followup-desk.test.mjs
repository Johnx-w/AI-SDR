import test from 'node:test';
import assert from 'node:assert/strict';
import { OutreachService } from '../server/outreach-service.mjs';
import { LeadLibrary } from '../server/lead-library.mjs';
import { CustomerBusiness } from '../server/customer-business.mjs';
import { followupDesk, setFollowupPriority, saveFollowupPlan } from '../server/followup-desk.mjs';
test('五栏跟进按真实标记、人工会话和审核工单归属，空客户没有记录', () => {
  const leads = new LeadLibrary({ scope: 'leads' }),
    store = new CustomerBusiness({ scope: 'work' });
  const service = new OutreachService({ mailboxes: { list: () => [] }, getScope: () => 'mail' });
  const list = (queue, opts = {}) =>
    followupDesk(service, store, leads, new URLSearchParams({ queue, ...opts }));
  try {
    for (const id of ['north', 'south', 'empty']) {
      leads.db
        .prepare('INSERT INTO lead_library_customers VALUES(?,?,0,?,?,?)')
        .run('leads', id, JSON.stringify({ name: id, email: id + '@example.com' }), '{}', '1');
    }
    for (const id of ['north', 'south']) {
      setFollowupPriority(leads, id, true);
      store.put('conversations', {
        id,
        customerId: id,
        channel: 'email',
        ownership: 'human',
        status: 'active',
        title: id,
        participant: id + '@example.com',
        owner: 'owner',
        updatedAt: '2026-11-24T00:00:00Z',
      });
      service.db
        .prepare('INSERT INTO mailbox_threads VALUES(?,?,?)')
        .run(id, 'box', JSON.stringify({ customerId: id, companyName: id }));
      service.db
        .prepare('INSERT INTO mail_reception VALUES(?,?,?,?,0,0,?)')
        .run(
          'msg-' + id,
          id,
          'box',
          id === 'north' ? 'attention' : 'review',
          JSON.stringify({ customerId: id, scope: 'mail', subject: id }),
        );
    }
    for (const queue of ['priority', 'approval', 'assigned']) {
      assert.deepEqual(
        list(queue)
          .items.map((r) => r.customerId)
          .sort(),
        ['north', 'south'],
      );
      assert.equal(list(queue, { customerId: 'empty' }).total, 0);
      assert.equal(list(queue, { q: 'north' }).total, 1);
    }
    saveFollowupPlan(store, 'north', {
      owner: 'Alex',
      nextStep: '确认规格',
      dueAt: '2026-11-26T00:00:00Z',
      completed: true,
    });
    assert.equal(list('assigned').total, 1);
    assert.equal(list('assigned', { completed: '1' }).items[0].owner, 'Alex');
    setFollowupPriority(leads, 'south', false);
    assert.equal(list('priority').total, 1);
    assert.equal(list('lookup', { q: 'south' }).items[0].id, 'south');
    assert.throws(() => setFollowupPriority(leads, 'missing', true));
  } finally {
    service.close();
    store.close();
    leads.close();
  }
});
