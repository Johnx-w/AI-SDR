const conversation = (id, customerId, title, extra = {}) => ({
  id, customerId, title, channel: 'email', account: 'sales@example.com', participant: 'buyer@example.org', owner: '张敏', ownership: 'auto', status: 'active', version: 1, createdAt: '2026-11-01T01:00:00Z', ...extra,
});
const message = (id, conversationId, body, occurredAt, extra = {}) => ({
  id, conversationId, customerId: conversationId === 'harbor' ? 'harbor-company' : 'signature', channel: 'email', direction: 'inbound', subject: 'Roller shades — samples and specifications', body, from: 'buyer@example.org', to: 'sales@example.com', account: 'sales@example.com', occurredAt, deliveryStatus: 'received', classification: 'normal', externalId: `<${id}@example.org>`, attachments: [], demandIds: [], version: 1, ...extra,
});
export const businessWorkspace = {
  customers: [{ id: 'signature', name: 'Signature Window Coverings LLC' }, { id: 'harbor-company', name: 'Harbor Blinds & Shutters' }],
  products: [{ id: 'roller', name: '遮光卷帘', status: 'approved', version: 1 }],
  conversations: [conversation('samples', 'signature', 'Roller shades — samples and specifications'), conversation('harbor', 'harbor-company', 'Plantation shutters for the spring collection', { ownership: 'human' }), conversation('empty', 'signature', 'Outdoor awning consultation')],
  messages: [
    message('latest', 'samples', 'Thank you, the specifications look good. Please send samples in warm white and charcoal.\n\nOn Tue, Nov 3, 2026 at 10:00 AM Sales wrote:\n> We can prepare samples after confirming the fabric.', '2026-11-05T02:30:00Z'),
    message('harbor-first', 'harbor', 'Could you share the plantation shutter catalogue and the available louvre sizes?', '2026-11-04T18:00:00Z'),
    message('sent', 'samples', 'Hello Emma,\n\nWe can prepare samples after confirming the fabric. Please review the specifications below.\n\n' + 'Fabric width: 280 cm. Composition: 100% polyester. Please confirm the required colour and dimensions.\n'.repeat(16), '2026-11-04T09:00:00+08:00', { direction: 'outbound', from: 'sales@example.com', to: 'buyer@example.org', deliveryStatus: 'accepted' }),
    message('first', 'samples', 'Hello,\n\nWe are updating our roller shade range. Could you confirm the fabric width and blackout options? We would also like to order samples.\n\nBest regards,\nEmma', '2026-11-03T04:00:00Z'),
  ],
  demands: [], tasks: [], customerContexts: [], feishu: { configured: true },
};
export const businessOriginals = {
  latest: {
    subject: 'Roller shades — samples and specifications', bodyText: businessWorkspace.messages[0].body, source: 'imap', bodyFormatVersion: 2,
    bodyHtml: '<html><body style="font-family:Arial;color:#24324a;font-size:14px"><p>Thank you, the specifications look good.</p><p>Please send samples in <strong>warm white</strong> and <strong>charcoal</strong>.</p><blockquote><p>On Tue, Nov 3, 2026 at 10:00 AM Sales wrote:</p><p>We can prepare samples after confirming the fabric.</p></blockquote></body></html>',
  },
};
