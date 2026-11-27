import { personalizationPolicy, templateModelFields } from './sequence-personalization.mjs';
import { setImmediate } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { expandTemplate, normalizeTemplate } from '../src/domain/sequence-email.mjs';
import {
  writerPolicy,
  normalizeOutreachLead,
  selectOutreachCandidates,
  outreachProductScope,
  eligibleOutreachFacts,
} from './outreach-content.mjs';
import {
  generateFollowUp,
  followUpWritingPolicy,
  checkOutreachScope,
} from './outreach-follow-ups.mjs';
import { sequencePolicy, writingInstruction } from './outreach-sequence-policy.mjs';
import {
  normalizeWritingOptions,
  firstWritingRequirements,
  followWritingRequirement,
} from './mail-writing-options.mjs';
import { renderMailboxSignature } from '../src/domain/mail-signature.mjs';
import { siteAllowsProduct } from '../src/domain/mail-site.mjs';

const acquisition = JSON.parse(
  readFileSync(new URL('../src/data/acquisition.json', import.meta.url)),
);
const categories = [
  ...acquisition.customerTypes.map(({ value, label }) => ({ value, label })),
  { value: 'installer', label: '安装服务商' },
];
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
export function previewOptions(service) {
  const products = service.products();
  return {
    categories,
    mailboxes: service.mailboxes.list().map((box) => ({
      id: box.id,
      email: box.email,
      brand: box.brandName,
      products: products
        .filter(
          (p) =>
            box.productIds?.includes(p.id) &&
            siteAllowsProduct(p, box) &&
            eligibleOutreachFacts(
              p,
              { productScopes: [outreachProductScope(p)] },
              new Date(service.now()),
            ).length,
        )
        .map((p) => ({ id: p.id, name: p.name })),
    })),
  };
}

async function previewContext(service, input) {
  if (
    !input ||
    typeof input !== 'object' ||
    ['category', 'mailboxId', 'productId', 'sampleId', 'after'].some(
      (key) =>
        input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 300),
    )
  )
    throw fail('预览范围格式无效', 400);
  if (!categories.some((c) => c.value === input.category)) throw fail('请选择现有客户类别', 400);
  const mailbox = service.mailboxes.get(input.mailboxId);
  if (!mailbox) throw fail('请选择发件邮箱', 400);
  const products = service
    .products()
    .filter(
      (p) =>
        mailbox.productIds?.includes(p.id) &&
        siteAllowsProduct(p, mailbox) &&
        (!input.productId || p.id === input.productId),
    );
  const campaign = {
    mailboxIds: [mailbox.id],
    filters: { products: products.map((p) => p.id) },
    productScopes: products.map(outreachProductScope),
  };
  if (!products.length) throw fail('当前邮箱没有获准介绍的匹配产品；没有合格样本');
  let after = typeof input.after === 'string' ? input.after : '';
  let wrapped = false;
  const rejected = new Set();
  for (;;) {
    const rows = await service.previewLeads(input.category, after, input.sampleId || '');
    if (!rows.length) {
      if (input.after && after && !wrapped && !input.sampleId) {
        after = '';
        wrapped = true;
        continue;
      }
      if (input.after) throw fail('未找到其他合格样本；可保留当前样本，或重新取样核对最新资料');
      throw fail(
        '该类别在当前邮箱及产品范围内没有合格样本；需有同源角色、产品及商务联系依据' +
          (rejected.size ? '：' + [...rejected].join('；') : ''),
      );
    }
    for (const row of rows) {
      if (wrapped && input.after && row.id > input.after) throw fail('没有其他合格样本');
      if (wrapped && row.id === input.after) continue;
      const normalized = normalizeOutreachLead(row.lead);
      const roles = normalized.evidence.filter(
        (e) => ['customer_type', 'customer_types'].includes(e.field) && e.value === input.category,
      );
      if (!roles.length) {
        rejected.add('类别缺少客户官网原文证据');
        continue;
      }
      const result = selectOutreachCandidates({
        leads: [row.lead],
        mailboxes: [mailbox],
        products,
        campaign,
        now: new Date(service.now()),
        previewOnly: true,
      });
      if (result.eligible.length) {
        const fixed = service.customerMailState(row.id)?.context?.fixedEmail;
        if (fixed && fixed.toLowerCase() !== mailbox.email.toLowerCase()) {
          rejected.add('客户已固定归属其他发件邮箱');
          continue;
        }
        return {
          candidate: result.eligible[0],
          mailbox,
          product: products.find((p) => p.id === result.eligible[0].productId),
          campaign,
          roles,
        };
      }
      if (result.blocked[0]) rejected.add(result.blocked[0].reason);
    }
    if (input.sampleId) throw fail('所选样本已不符合当前类别、邮箱或产品范围，请更换同类样本');
    after = rows.at(-1).id;
    await setImmediate();
  }
}
function sampleDetails({ candidate, mailbox, product, roles }, category) {
  return {
    id: candidate.customerId,
    name: candidate.companyName,
    category: categories.find((c) => c.value === category)?.label,
    mailboxId: mailbox.id,
    from: mailbox.email,
    brand: mailbox.brandName,
    product: product.name,
    productId: product.id,
    reason: candidate.matchReason,
    roleEvidence: roles.map(({ quote, sourceUrl }) => ({ quote, sourceUrl })),
    selection:
      '按客户编号遍历完整类别，选取通过正式产品匹配校验的首个样本；更换时从当前样本之后继续，末尾循环',
  };
}
export async function previewSample(service, input) {
  return {
    ...sampleDetails(await previewContext(service, input), input.category),
    demo: service.previewDemo === true,
  };
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
    throw fail('请选择有效的邮件步骤和跟进日', 400);
  const context = await previewContext(service, input);
  const { candidate, mailbox, product, campaign } = context;
  const policy = sequencePolicy(service.db);
  const writing = normalizeWritingOptions(input.writing);
  const template = normalizeTemplate(input.template, firstTouch);
  const instruction = writingInstruction(
    input.instruction,
    firstTouch || !!template || !!(writing?.angle || writing?.reply),
  );
  const signature = renderMailboxSignature(mailbox).text;
  const greeting = 'Hi ' + candidate.companyName + ' team,';
  const requirements = firstWritingRequirements(
    writingInstruction(
      firstTouch
        ? (input.firstBodyInstruction ?? '')
        : (input.firstBodyInstruction ?? policy.firstBodyInstruction),
      true,
    ),
    firstTouch
      ? instruction
      : writingInstruction(input.firstInstruction ?? policy.firstInstruction, true),
    firstTouch ? writing : normalizeWritingOptions(input.firstWriting ?? policy.firstWriting),
  );
  const firstTemplate = firstTouch
    ? template
    : normalizeTemplate(input.firstTemplate ?? policy.firstTemplate, true);
  const priorSteps = firstTouch ? [] : (input.priorSteps ?? policy.steps);
  if (
    !Array.isArray(priorSteps) ||
    priorSteps.length > 12 ||
    priorSteps.some((s) => !s || !Number.isInteger(s.day) || s.day < 1 || s.day > 365) ||
    new Set(priorSteps.map((s) => s.day)).size !== priorSteps.length
  )
    throw fail('跟进上下文无效', 400);
  const prior = priorSteps.filter((s) => s.day < input.day).sort((a, b) => a.day - b.day);
  const metadata = {
    sample: sampleDetails(context, input.category),
    rules: {
      step: input.step,
      day: input.day,
      first: requirements,
      system:
        (firstTouch ? writerPolicy : followUpWritingPolicy) +
        (template?.variables?.length ? personalizationPolicy : ''),
      productFacts: eligibleOutreachFacts(product, campaign, new Date(service.now())).map(
        (f) => f.text,
      ),
      instruction: firstTouch ? instruction : followWritingRequirement(instruction, writing),
      writing,
      template,
      firstTemplate,
      policyRevision: policy.revision,
    },
    greeting,
    signature,
    to: candidate.to,
  };
  if (firstTouch) {
    const draft = await service.generatorClient().generate({
      candidate,
      mailbox,
      product,
      campaign,
      template,
      includeVariables: true,
      now: new Date(service.now()),
      ...requirements,
    });
    checkOutreachScope(
      draft.subject + '\n' + draft.bodyText,
      mailbox,
      service,
      candidate.companyName,
    );
    return {
      ...metadata,
      variables: draft.variables,
      subject: draft.subject,
      body: draft.bodyText + '\n\n' + signature,
    };
  }
  const local = {
    company: candidate.companyName,
    product: product.englishName || product.name,
    brand: mailbox.brandName,
  };
  const aiVariable = /\{\{(?:ai_|custom_)[^{}]+\}\}/u;
  const localBody = (previous) =>
    expandTemplate(
      (previous?.body || '').replaceAll(new RegExp(aiVariable.source, 'gu'), ''),
      local,
    ).trim();
  const first = {
    candidate,
    companyName: candidate.companyName,
    subject:
      firstTemplate && !aiVariable.test(firstTemplate.subject)
        ? expandTemplate(firstTemplate.subject, local)
        : '',
    bodyText: localBody(firstTemplate),
  };
  const previous = input.firstPreview;
  if (
    !first.subject &&
    previous?.sampleId === candidate.customerId &&
    previous.mailboxId === mailbox.id &&
    previous.productId === product.id &&
    typeof previous.subject === 'string' &&
    previous.subject.length <= 150 &&
    !/[\x00-\x1f\x7f]/u.test(previous.subject)
  )
    first.subject = previous.subject.trim();
  const history = templateModelFields(template).needed
    ? prior.flatMap((s) => {
        const bodyText = localBody(normalizeTemplate(s.template, false));
        return bodyText ? [{ direction: 'outbound', bodyText }] : [];
      })
    : [];
  const generate = service.generator?.generateFollowUp || generateFollowUp;
  const follow = async (step, day, instruction, template) => {
    const result = await generate({
      env: service.getEnv(),
      fetchImpl: service.fetchImpl,
      first,
      step,
      day,
      instruction,
      mailbox,
      product,
      campaign,
      template,
      previewOnly: true,
      history,
      now: service.now(),
    });
    checkOutreachScope(
      typeof result === 'string'
        ? result
        : [result.subject, result.body].filter(Boolean).join('\n'),
      mailbox,
      service,
      candidate.companyName,
    );
    return result;
  };
  const body = await follow(
    input.step,
    input.day,
    followWritingRequirement(instruction, writing),
    template,
  );
  return {
    ...metadata,
    variables: body.variables,
    warning: body.warning,
    subject: body.subject || (first.subject ? 'Re: ' + first.subject : '沿用首封主题'),
    body: [greeting, typeof body === 'string' ? body : body.body, signature].join('\n\n'),
  };
}
