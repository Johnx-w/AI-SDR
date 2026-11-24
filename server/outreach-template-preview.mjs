import { outreachProductScope } from './outreach-content.mjs';
import { generateFollowUp } from './outreach-follow-ups.mjs';
import { writingInstruction } from './outreach-sequence-policy.mjs';
import { renderMailboxSignature } from '../src/domain/mail-signature.mjs';

// Preview uses a fixed example so editing never reads a customer or enrolls a campaign.
export async function previewOutreachTemplate(service, input) {
  const firstTouch = input?.step === 0;
  if (
    !firstTouch &&
    (!Number.isInteger(input?.step) ||
      input.step < 1 ||
      input.step > 12 ||
      !Number.isInteger(input.day) ||
      input.day < 1 ||
      input.day > 365)
  )
    throw Object.assign(new Error('请选择有效的邮件步骤和跟进日'), { status: 400 });
  const instruction = writingInstruction(input.instruction, firstTouch);
  const product = {
    id: 'roller',
    name: '卷帘',
    englishName: 'roller blinds',
    direction: 'finished',
    status: 'approved',
    version: 1,
  };
  const mailbox = {
    id: 'example',
    email: 'sales@supply.example',
    website: 'https://supply.example',
    brandName: 'Example Supply',
    displayName: 'Alex',
    signature: 'Alex\nExample Supply',
    productIds: [product.id],
  };
  const campaign = { productScopes: [outreachProductScope(product)] };
  const candidate = {
    companyName: 'Example Dealer',
    customerId: 'example-dealer',
    mailboxId: mailbox.id,
    productId: product.id,
    productVersion: 1,
    to: 'info@dealer.example',
    leadSnapshot: { market: 'Australia', type: 'distributor' },
    evidence: [
      {
        id: 'example-range',
        value: 'roller blinds',
        quote: 'Our range includes roller blinds.',
        sourceUrl: 'https://dealer.example/products',
      },
    ],
  };
  const greeting = 'Hi Example Dealer team,';
  const signature = renderMailboxSignature(mailbox).text;
  if (firstTouch) {
    const draft = await service.generatorClient().generate({
      candidate,
      mailbox,
      product,
      campaign,
      firstBodyInstruction: writingInstruction(input.firstBodyInstruction ?? '', true),
      firstInstruction: instruction,
    });
    return { subject: draft.subject, body: draft.bodyText + '\n\n' + signature };
  }
  const first = {
    subject: 'Roller blind supply',
    companyName: candidate.companyName,
    bodyText:
      greeting +
      '\n\nExample Supply supplies roller blinds. Would a short introduction be useful?\n\n' +
      signature,
  };
  const body = await (service.generator?.generateFollowUp || generateFollowUp)({
    env: service.getEnv(),
    fetchImpl: service.fetchImpl,
    first,
    step: input.step,
    day: input.day,
    instruction,
    mailbox,
    product,
    campaign,
    history: [],
    now: service.now(),
  });
  return { subject: 'Re: ' + first.subject, body: [greeting, body, signature].join('\n\n') };
}
