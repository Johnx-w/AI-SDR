import test from 'node:test';
import assert from 'node:assert/strict';
import { OutreachService } from '../server/outreach-service.mjs';
import { LeadLibrary } from '../server/lead-library.mjs';
import { followupDesk, setFollowupPriority } from '../server/followup-desk.mjs';
test('跟进按重点标记和审核工单归属，空客户没有记录', () => {
  const leads = new LeadLibrary({ scope: 'leads' });
  const service = new OutreachService({ mailboxes: { list: () => [] }, getScope: () => 'mail' });
  const list = (queue, opts = {}) =>
    followupDesk(service, leads, new URLSearchParams({ queue, ...opts }));
  try {
    for (const id of ['north', 'south', 'empty']) {
      leads.db
        .prepare('INSERT INTO lead_library_customers VALUES(?,?,0,?,?,?)')
        .run('leads', id, JSON.stringify({ name: id, email: id + '@example.com' }), '{}', '1');
    }
    for (const id of ['north', 'south']) {
      setFollowupPriority(leads, id, true);
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
    for (const queue of ['priority', 'approval']) {
      assert.deepEqual(
        list(queue)
          .items.map((r) => r.customerId)
          .sort(),
        ['north', 'south'],
      );
      assert.equal(list(queue, { customerId: 'empty' }).total, 0);
      assert.equal(list(queue, { q: 'north' }).total, 1);
    }
    assert.equal(Object.hasOwn(list('approval').counts, 'assigned'), false);
    setFollowupPriority(leads, 'south', false);
    assert.equal(list('priority').total, 1);
    assert.equal(list('lookup', { q: 'south' }).items[0].id, 'south');
    assert.throws(() => setFollowupPriority(leads, 'missing', true));
  } finally {
    service.close();
    leads.close();
  }
});
