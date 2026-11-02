import { performance } from 'node:perf_hooks';
import { OutreachService } from '../server/outreach-service.mjs';
import { handleOutreach } from '../server/outreach-api.mjs';

const mailboxes = Array.from({ length: 3 }, (_, index) => ({
  id: `box-${index}`,
  email: `sales-${index}@example.org`,
  configured: true,
  signatureDesign: { logo: { contentBase64: 'A'.repeat(230_000) } },
}));
const customerSnapshot = JSON.stringify(
  Array.from({ length: 800 }, (_, index) => ({
    id: `customer-${index}`,
    name: `Customer ${index}`,
    email: `customer-${index}@example.org`,
    contactEvidence: [],
  })),
);
let customerReads = 0;
const service = new OutreachService({
  mailboxes: { list: () => mailboxes },
  customers: () => {
    customerReads++;
    return JSON.parse(customerSnapshot);
  },
});
const sentAt = '2026-10-27T04:00:00.000Z';
try {
  for (let index = 0; index < 1676; index++)
    service.putDelivery({
      id: `delivery-${index}`,
      campaignId: 'benchmark',
      mailboxId: mailboxes[index % 3].id,
      from: mailboxes[index % 3].email,
      to: `buyer-${index}@example.org`,
      companyName: `Buyer ${index}`,
      subject: 'Window products',
      bodyText: 'Hello, window products.',
      candidate: { evidence: 'X'.repeat(10_000) },
      status: index < 138 ? 'accepted' : 'cancelled',
      messageId: `<delivery-${index}@example.org>`,
      sentAt,
    });
  for (let index = 0; index < 26; index++)
    service.conversations.putMessage(mailboxes[0], {
      messageId: `<incoming-${index}@example.org>`,
      direction: 'inbound',
      from: `incoming-${index}@example.org`,
      to: mailboxes[0].email,
      subject: 'Question',
      bodyText: 'Please send a catalog.',
      occurredAt: sentAt,
      source: 'imap',
    });
  for (const path of ['/state', '/deliveries?page=1', '/conversations?mailboxId=all']) {
    const durations = [];
    let bytes = 0;
    for (let index = 0; index < 6; index++) {
      const start = performance.now();
      const result = await handleOutreach({
        request: { method: 'GET' },
        url: new URL(`http://localhost/api/v1/outreach${path}`),
        service,
      });
      const serialized = JSON.stringify(result);
      const elapsed = performance.now() - start;
      bytes = Buffer.byteLength(serialized);
      if (index) durations.push(elapsed);
      if (
        path === '/state' &&
        (result.deliveryStats?.total !== 1676 || serialized.includes('"candidate"'))
      )
        throw new Error('State must count every delivery without candidates');
      if (path.startsWith('/deliveries') && (result.total !== 1676 || result.items[0].candidate))
        throw new Error('Delivery page must keep totals without candidates');
      if (path.startsWith('/conversations') && result.total !== 164)
        throw new Error(`Expected 164 conversations, got ${result.total}`);
    }
    durations.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        path,
        bytes,
        medianMs: Number(durations[2].toFixed(1)),
        maxMs: Number(durations.at(-1).toFixed(1)),
        customerReads,
      }),
    );
  }
} finally {
  await service.close();
}
