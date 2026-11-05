import { decorateLeadDevelopment } from './lead-development.mjs';
import { isDevelopmentCustomer } from './customer-eligibility.mjs';
import { ratingSummary } from './lead-library.mjs';

export function customerMirrorFields(leads, workspace) {
  const times = new Map();
  for (const message of workspace.messages || []) {
    if (!message.actualConfirmed || message.classification !== 'normal') continue;
    const at = Date.parse(message.occurredAt);
    if (!Number.isFinite(at)) continue;
    const key =
      message.direction === 'outbound' && ['accepted', 'sent'].includes(message.deliveryStatus)
        ? '最近联系时间'
        : message.direction === 'inbound' && message.deliveryStatus === 'received'
          ? '最近回复时间'
          : null;
    if (!key) continue;
    const prior = times.get(message.customerId) || {};
    prior[key] = Math.max(prior[key] || 0, at);
    times.set(message.customerId, prior);
  }
  return decorateLeadDevelopment({ leads }, workspace).leads.map((lead) => ({
    id: lead.id,
    fields: {
      初评结果: isDevelopmentCustomer(lead)
        ? ['A', 'B', 'C'].includes(lead.grade)
          ? lead.grade
          : 'C'
        : null,
      评级依据摘要: isDevelopmentCustomer(lead)
        ? ratingSummary(lead)
        : '所有已核实供货方向均不匹配；保留往来历史',
      开发状态: lead.status,
      最近联系时间: times.get(lead.id)?.['最近联系时间'] || null,
      最近回复时间: times.get(lead.id)?.['最近回复时间'] || null,
    },
  }));
}
