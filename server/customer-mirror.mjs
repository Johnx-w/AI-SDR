import { decorateLeadDevelopment } from './lead-development.mjs';
import { isDevelopmentCustomer } from './customer-eligibility.mjs';
import { ratingSummary } from './lead-library.mjs';
import { knownReplyType, customerReplyText } from './communication-rounds.mjs';

const emails = (value) => [
  ...new Set(
    String(value || '')
      .toLowerCase()
      .match(/[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [],
  ),
];

export function customerEmailValidity(lead, messages) {
  const addresses = emails(lead.email || lead.fields?.['邮箱']);
  if (!addresses.length) return null;
  const status = new Map();
  for (const message of messages
    .filter((m) => m.customerId === lead.id && m.actualConfirmed)
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))) {
    if (message.channel !== 'email') continue;
    if (message.direction === 'outbound' && ['accepted', 'sent'].includes(message.deliveryStatus)) {
      for (const address of emails(message.to || message.recipient))
        if (addresses.includes(address) && status.get(address) !== '失效')
          status.set(address, '有效');
    } else if (message.direction === 'inbound' && message.deliveryStatus === 'received') {
      if (knownReplyType(message) === '联系方式失效') {
        for (const address of emails(customerReplyText(message)))
          if (addresses.includes(address)) status.set(address, '失效');
      } else
        for (const address of emails(message.from || message.sender))
          if (addresses.includes(address)) status.set(address, '有效');
    }
  }
  return [...status.values()].includes('有效')
    ? '有效'
    : [...status.values()].includes('失效')
      ? '失效'
      : '待核验';
}

export function customerMirrorFields(leads, workspace, { emailValidity = false } = {}) {
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
      ...(emailValidity
        ? { 邮箱有效性: customerEmailValidity(lead, workspace.messages || []) }
        : {}),
    },
  }));
}
