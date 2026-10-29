const progressStates = ['待开发', '已联系', '已回复', '跟进中'];
const initialStates = new Set([
  '',
  '未记录',
  '未联系',
  '尚未联系',
  'pending_outreach',
  '未开发',
  '待联系',
  '新线索',
]);
const followingStages = new Set(['clarifying', 'quoting', 'sampling', 'negotiating']);
const actualMessage = (message) =>
  message.actualConfirmed === true && message.classification === 'normal';
const actualReply = (message) =>
  actualMessage(message) &&
  message.direction === 'inbound' &&
  message.deliveryStatus === 'received';
const actualOutbound = (message) =>
  actualMessage(message) &&
  message.direction === 'outbound' &&
  ['sent', 'accepted'].includes(message.deliveryStatus);

export function normalizeDevelopmentStatus(status) {
  return !status?.trim() || status.trim() === '未记录' ? '待开发' : status;
}

// Derive display progress from saved business facts; keep the upstream record intact.
export function decorateLeadDevelopment(
  snapshot,
  { customerContexts = [], messages = [], demands = [] } = {},
) {
  const controls = new Map(customerContexts.map((row) => [row.customerId, row]));
  const progress = new Map();
  const advance = (customerId, rank) =>
    progress.set(customerId, Math.max(progress.get(customerId) || 0, rank));
  const messageById = new Map(messages.map((message) => [message.id, message]));
  const outgoingByDemand = new Map();
  for (const message of messages) {
    if (actualReply(message)) advance(message.customerId, 2);
    if (actualOutbound(message)) {
      advance(message.customerId, 1);
      for (const id of message.demandIds || []) {
        if (!outgoingByDemand.has(id)) outgoingByDemand.set(id, []);
        outgoingByDemand.get(id).push(message);
      }
    }
  }
  for (const demand of demands) {
    const source = messageById.get(demand.sourceMessageId);
    if (
      !source ||
      source.customerId !== demand.customerId ||
      source.conversationId !== demand.conversationId ||
      !actualMessage(source) ||
      !(
        actualReply(source) ||
        (source.direction === 'note' &&
          source.channel === 'phone' &&
          source.deliveryStatus === 'recorded')
      ) ||
      !demand.evidenceQuote?.trim() ||
      !source.body?.includes(demand.evidenceQuote)
    )
      continue;
    advance(demand.customerId, 2);
    if (
      followingStages.has(demand.stage) ||
      (demand.stage === 'new' &&
        (outgoingByDemand.get(demand.id) || []).some(
          (message) =>
            message.customerId === demand.customerId &&
            message.conversationId === demand.conversationId &&
            Date.parse(message.occurredAt) > Date.parse(source.occurredAt),
        ))
    )
      advance(demand.customerId, 3);
  }
  const decorate = (lead) => {
    const context = controls.get(lead.id);
    const control = context?.development;
    let status = normalizeDevelopmentStatus(lead.status);
    const rank = progress.get(lead.id) || 0;
    const sourceRank = initialStates.has(status || '') ? 0 : progressStates.indexOf(status);
    if (sourceRank >= 0 && rank > sourceRank) status = progressStates[rank];
    if (context?.doNotContact && !['已成交', '暂不开发', '停止开发'].includes(status))
      status = '停止开发';
    if (control?.paused) status = '暂缓开发';
    const suffix =
      (status !== lead.status ? `:progress:${status}` : '') +
      (control?.version ? `:development:${control.version}` : '');
    if (!suffix) return lead;
    return {
      ...lead,
      status,
      ...(lead.version ? { version: `${lead.version}${suffix}` } : {}),
    };
  };
  if (snapshot.leads) return { ...snapshot, leads: snapshot.leads.map(decorate) };
  if (snapshot.lead) {
    const lead = decorate({ ...snapshot.lead, version: snapshot.version });
    return {
      ...snapshot,
      lead: decorate(snapshot.lead),
      ...(snapshot.version ? { version: lead.version } : {}),
    };
  }
  return snapshot;
}
