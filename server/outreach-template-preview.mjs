import { normalizeTemplate } from '../src/domain/sequence-email.mjs';
import { eligibleOutreachFacts, outreachProductScope } from './outreach-content.mjs';
import { generateFollowUp } from './outreach-follow-ups.mjs';
import { writingInstruction } from './outreach-sequence-policy.mjs';
import {
  normalizeWritingOptions,
  firstWritingRequirements,
  followWritingRequirement,
} from './mail-writing-options.mjs';
import { renderMailboxSignature } from '../src/domain/mail-signature.mjs';
import { siteAllowsProduct } from '../src/domain/mail-site.mjs';

export function previewContacts(service, after = '') {
  const rows = service.db
    .prepare(
      `SELECT d.id, json_extract(d.data,'$.companyName') AS company, json_extract(d.data,'$.to') AS email
    FROM outreach_deliveries d JOIN outreach_campaigns c ON c.id=d.campaign_id
    WHERE d.state='accepted' AND d.id>? AND json_extract(c.data,'$.mode')='production'
    AND json_extract(c.data,'$.scope')=? ORDER BY d.id LIMIT 26`,
    )
    .all(after, service.getScope());
  return { items: rows.slice(0, 25), next: rows.length > 25 ? rows[24].id : null };
}

function previewContext(service, customer) {
  if (typeof customer === 'string' && customer.startsWith('record:')) {
    const first = service.delivery(customer.slice(7));
    const campaign = service.campaign(first.campaignId);
    const candidate = first.candidate;
    const mailbox = service.mailboxes.get(first.mailboxId);
    const product = service.products().find((p) => p.id === candidate?.productId);
    if (
      campaign.mode !== 'production' ||
      campaign.scope !== service.getScope() ||
      first.status !== 'accepted' ||
      !candidate?.evidence?.length ||
      !product ||
      !mailbox?.productIds?.includes(product.id) ||
      !siteAllowsProduct(product, mailbox) ||
      (first.senderBrand && first.senderBrand !== mailbox.brandName) ||
      (first.senderWebsite && first.senderWebsite !== mailbox.website) ||
      !eligibleOutreachFacts(product, campaign, new Date(service.now())).length
    )
      throw Object.assign(new Error('当前记录缺少适用的客户或发件资料，请选择其他联系人'), {
        status: 409,
      });
    return { candidate, mailbox, product, campaign, first };
  }
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
  return { candidate, mailbox, product, campaign };
}

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
  const template = normalizeTemplate(input.template, firstTouch);
  const instruction = writingInstruction(
    input.instruction,
    firstTouch || !!template || !!(writing?.angle || writing?.reply),
  );
  const {
    candidate,
    mailbox,
    product,
    campaign,
    first: stored,
  } = previewContext(service, input.customer ?? 'dealer');
  const greeting = 'Hi ' + candidate.companyName + ' team,';
  const signature = renderMailboxSignature(mailbox).text;
  if (firstTouch) {
    const draft = await service.generatorClient().generate({
      candidate,
      mailbox,
      product,
      campaign,
      template,
      includeVariables: true,
      now: new Date(service.now()),
      ...firstWritingRequirements(
        writingInstruction(input.firstBodyInstruction ?? '', true),
        instruction,
        writing,
      ),
    });
    return {
      variables: draft.variables,
      greeting,
      signature,
      to: candidate.to,
      subject: draft.subject,
      body: draft.bodyText + '\n\n' + signature,
    };
  }
  const first = stored ?? {
    candidate,
    subject: 'Roller blind supply',
    companyName: candidate.companyName,
    bodyText:
      greeting +
      (candidate.leadSnapshot.type === 'manufacturer'
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
    template,
    previewOnly: true,
    history: stored
      ? service.db
          .prepare(
            `SELECT 'outbound' AS direction, json_extract(data,'$.bodyText') AS bodyText
          FROM outreach_followups WHERE json_extract(data,'$.firstId')=? AND state='accepted'
          AND json_extract(data,'$.step')<? ORDER BY json_extract(data,'$.step')`,
          )
          .all(stored.id, input.step)
      : [],
    now: service.now(),
  });
  const text = typeof body === 'string' ? body : body.body;
  return {
    variables: body.variables,
    warning: body.warning,
    greeting,
    signature,
    to: candidate.to,
    subject: 'Re: ' + first.subject,
    body: [greeting, text, signature].join('\n\n'),
  };
}
