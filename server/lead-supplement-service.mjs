import { createHash } from 'node:crypto';
import { fieldText, mapFeishuRecord } from './feishu.mjs';
import {
  customerWebsite,
  assessmentSummaryFields,
  resolveCustomerField,
} from './customer-fields.mjs';
import {
  assessmentId,
  assessmentRating,
  assertAssessmentIdentity,
  formatAssessmentReason,
} from './customer-assessment.mjs';
import { domainKey } from './website-identity.mjs';
import { validateSupplement, recomputeFromSnapshot } from './lead-supplements.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const sameFields = (record, fields) =>
  Object.entries(fields).every(
    ([key, value]) => fieldText(record.fields?.[key]) === fieldText(value),
  );

export function decorateDossierConfirmations(lead, confirmations) {
  const legal = confirmations.filter((c) => c.category === 'legal_name').at(-1);
  const purchase = confirmations.filter((c) => c.category === 'purchase_need').at(-1);
  const resolved = new Set(
    confirmations
      .filter((c) => c.category === 'profile')
      .map((c) => c.pendingItem)
      .filter(Boolean),
  );
  return {
    ...lead,
    confirmations,
    ...(legal
      ? {
          companyIdentity: {
            ...lead.companyIdentity,
            legal_name: legal.content,
            website_name: lead.companyIdentity?.website_name || lead.name,
            aliases: lead.companyIdentity?.aliases || [],
            evidence: lead.companyIdentity?.evidence || [],
            status: 'legal_name_manual_confirmed',
          },
        }
      : {}),
    ...(purchase ? { manualPurchaseNeed: purchase.content } : {}),
    pendingQuestions: String(lead.pendingQuestions || '')
      .split(/[；;\n]/)
      .filter((item) => !resolved.has(item.trim()))
      .join('；'),
  };
}

function validatePurchase(input, customerId, business) {
  if (input.category !== 'purchase_need') return;
  const message = business?.get('messages', input.sourceMessageId);
  if (
    !message ||
    message.customerId !== customerId ||
    message.actualConfirmed !== true ||
    message.classification !== 'normal' ||
    !(
      (message.direction === 'inbound' && message.deliveryStatus === 'received') ||
      (message.direction === 'note' &&
        message.channel === 'phone' &&
        message.deliveryStatus === 'recorded')
    )
  )
    throw fail(400, '采购需求需要关联该客户的实际来信或已确认电话纪要，请先在沟通与跟进中记录');
  if (!message.body?.includes(input.evidence))
    throw fail(400, '采购需求依据必须摘自所选实际沟通记录');
}

export async function saveLeadSupplement({ engine, id, input: rawInput, key, business }) {
  const input = validateSupplement(rawInput);
  const opId =
    'supplement_' +
    createHash('sha256')
      .update(JSON.stringify([id, key]))
      .digest('hex');
  let entry = engine.supplements.get(opId);
  const record = await engine.feishu.record(id);
  const website = customerWebsite(record);
  const prior = engine.supplements.confirmations(id, website);
  const current = engine.assessments.latest(id);
  if (!entry) {
    if ((current?.id || null) !== input.expectedAssessmentId)
      throw fail(409, '档案评估已更新，请刷新客户档案后重新补充');
    if (current) assertAssessmentIdentity(current, record);
    if (input.category === 'assessment' && !current)
      throw fail(409, '尚无可补充的产品评估，请先完成企业研究');
    const scoringMissing = [
      ...(current?.missing || []).filter((item) => item !== current?.supplyOpportunity?.note),
      ...Object.values(current?.dimensions || {}).map((d) => d.missing),
      ...(current?.opportunities || []).flatMap((o) => o.missing || []),
    ];
    if (
      input.category === 'profile' &&
      input.pendingItem &&
      (scoringMissing.includes(input.pendingItem) ||
        /经营法人|采购需求|采购方式/.test(input.pendingItem))
    )
      throw fail(400, '请从对应项目补充评分事实、法人名称或实际采购需求，普通备注不能清除该缺项');
    validatePurchase(input, id, business);
    const confirmedAt = new Date(
      Math.max(Date.now(), Date.parse(current?.evaluatedAt || '') + 1 || 0),
    ).toISOString();
    const confirmation = { ...input, id: opId, confirmedAt };
    delete confirmation.expectedAssessmentId;
    const snapshot = current
      ? recomputeFromSnapshot(current, [...prior, confirmation], {
          id: assessmentId(engine.assessments.scope, opId),
          at: Date.parse(confirmedAt),
        })
      : null;
    if (snapshot) resolveConfirmedPending(snapshot, [...prior, confirmation]);
    const definitions = await engine.feishu.fields();
    const fields = {};
    if (snapshot) {
      const grade = resolveCustomerField(definitions, '用户评级');
      if (!definitions.some((f) => f.field_name === grade && f.type === 3))
        throw fail(503, '客户表缺少初评结果字段，请先核对表结构');
      fields[grade] = assessmentRating(snapshot);
      const summaries = assessmentSummaryFields(snapshot);
      for (const [name, value] of Object.entries(summaries))
        if (definitions.some((f) => f.field_name === name && f.type === 1))
          fields[name] = value || '';
      if (definitions.some((f) => f.field_name === '评级依据' && f.type === 1))
        fields['评级依据'] = snapshot.reason;
    }
    entry = engine.supplements.prepare(opId, id, input, () => ({
      website,
      key,
      input: rawInput,
      confirmation,
      snapshot,
      fields,
      beforeFields: Object.fromEntries(
        Object.keys(fields).map((name) => [name, record.fields?.[name] ?? '']),
      ),
    }));
  } else {
    // prepare also checks that an idempotency key never changes its payload.
    engine.supplements.prepare(opId, id, input, () => ({}));
  }
  if (domainKey(website) !== domainKey(entry.website)) {
    engine.supplements.supersede(entry);
    throw fail(409, '客户官网已更换，请先核对原补充记录');
  }
  if (entry.state === 'superseded')
    throw fail(409, '原补充资料对应档案已变化，请重新打开表单核对后保存');
  if (entry.state !== 'completed') {
    const latestId = engine.assessments.latest(id)?.id || null;
    if (![input.expectedAssessmentId, entry.snapshot?.id || null].includes(latestId)) {
      engine.supplements.supersede(entry);
      throw fail(409, '评估已更新，原保存结果需要核对，请刷新档案');
    }
    if (!sameFields(record, entry.fields)) {
      if (!sameFields(record, entry.beforeFields)) {
        engine.supplements.supersede(entry);
        throw fail(409, '客户评级字段已被更新，请先核对原保存结果');
      }
      try {
        await engine.feishu.write('update', entry.fields, id);
      } catch {
        /* Read back before deciding whether a write committed. */
      }
    }
    let saved;
    try {
      saved = await engine.feishu.record(id);
    } catch {
      throw fail(502, '保存结果尚未确认，确认内容已保留；请保留表单并重试保存以核对');
    }
    if (
      domainKey(customerWebsite(saved)) !== domainKey(entry.website) ||
      !sameFields(saved, entry.fields)
    )
      throw fail(502, '飞书保存结果待核对，确认内容已保留；请保留表单并重试保存');
    if (entry.snapshot) engine.assessments.save(entry.snapshot, saved);
    engine.supplements.complete(entry);
  }
  const saved = await engine.feishu.record(id);
  const lead = engine.decorateLeads({ leads: [mapFeishuRecord(saved)] }).leads[0];
  return { lead, confirmation: entry.confirmation };
}

// Only the exact confirmed non-scoring question is resolved. A note or purchase
// confirmation cannot fill P/R/D/V, and input procurement stays product-scoped.
export function resolveConfirmedPending(snapshot, confirmations) {
  const scoring = new Set(
    Object.values(snapshot.dimensions || {})
      .map((d) => d.missing)
      .filter(Boolean),
  );
  const resolved = new Set();
  for (const confirmation of confirmations) {
    const item = confirmation.pendingItem;
    if (!item || scoring.has(item)) continue;
    const potential = snapshot.supplyOpportunity;
    if (item === potential?.note) {
      if (
        confirmation.category !== 'purchase_need' ||
        confirmation.direction !== 'materials' ||
        confirmation.product.trim().toLowerCase() !== potential.targetProduct.trim().toLowerCase()
      )
        continue;
      potential.procurementStatus = 'confirmed';
    } else if (/经营法人/.test(item)) {
      if (confirmation.category !== 'legal_name') continue;
    } else if (/采购需求|采购方式/.test(item)) {
      if (confirmation.category !== 'purchase_need') continue;
    } else if (confirmation.category !== 'profile') continue;
    resolved.add(item);
  }
  snapshot.missing = snapshot.missing.filter((item) => !resolved.has(item));
  snapshot.reason = formatAssessmentReason(snapshot);
  return snapshot;
}
