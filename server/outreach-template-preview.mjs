import { outreachProductScope } from './outreach-content.mjs';
import { generateFollowUp } from './outreach-follow-ups.mjs';
import { writingInstruction } from './outreach-sequence-policy.mjs';
import {
  normalizeWritingOptions,
  firstWritingRequirements,
  followWritingRequirement,
} from './mail-writing-options.mjs';
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
  const writing = normalizeWritingOptions(input.writing);
  const instruction = writingInstruction(
    input.instruction,
    firstTouch || !!(writing?.angle || writing?.reply),
  );
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
  const customer = input.customer ?? 'dealer';
  if (!['dealer', 'workshop'].includes(customer))
    throw Object.assign(new Error('请选择有效的示例客户'), { status: 400 });
  const workshop = customer === 'workshop';
  const candidate = {
    companyName: workshop ? 'Example Workshop' : 'Example Dealer',
    customerId: workshop ? 'example-workshop' : 'example-dealer',
    mailboxId: mailbox.id,
    productId: product.id,
    productVersion: 1,
    to: workshop ? 'buyer@workshop.example' : 'info@dealer.example',
    leadSnapshot: { market: 'Australia', type: workshop ? 'manufacturer' : 'distributor' },
    evidence: [
      {
        id: 'example-range',
        value: 'roller blinds',
        quote: workshop
          ? 'We assemble roller blinds in our own workshop.'
          : 'Our range includes roller blinds.',
        sourceUrl: workshop
          ? 'https://workshop.example/products'
          : 'https://dealer.example/products',
      },
    ],
  };
  const greeting = 'Hi ' + candidate.companyName + ' team,';
  const signature = renderMailboxSignature(mailbox).text;
  if (firstTouch) {
    const draft = await service.generatorClient().generate({
      candidate,
      mailbox,
      product,
      campaign,
      ...firstWritingRequirements(
        writingInstruction(input.firstBodyInstruction ?? '', true),
        instruction,
        writing,
      ),
    });
    return { subject: draft.subject, body: draft.bodyText + '\n\n' + signature };
  }
  const first = {
    subject: 'Roller blind supply',
    companyName: candidate.companyName,
    bodyText:
      greeting +
      (workshop
        ? '\n\nYour workshop assembles roller blinds.'
        : '\n\nYour range includes roller blinds.') +
      '\n\nExample Supply supplies roller blinds. Would a short introduction be useful?\n\n' +
      signature,
  };
  const body = await (service.generator?.generateFollowUp || generateFollowUp)({
    env: service.getEnv(),
    fetchImpl: service.fetchImpl,
    first,
    step: input.step,
    day: input.day,
    instruction: followWritingRequirement(instruction, writing),
    mailbox,
    product,
    campaign,
    history: [],
    now: service.now(),
  });
  return { subject: 'Re: ' + first.subject, body: [greeting, body, signature].join('\n\n') };
}
