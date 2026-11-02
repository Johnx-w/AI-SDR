const types = [
  [
    'privacy',
    '隐私 / 退订',
    /^(?:privacy(?:[._-]?(?:office|officer|team))?|data[._-]?(?:protection|rights)|dpo|dsar|gdpr|unsubscribe|opt[._-]?out)(?:[+._-]|$)/i,
  ],
  ['unmonitored', '无人回复', /^(?:no[._-]?reply|do[._-]?not[._-]?reply)(?:[+._-]|$)/i],
  ['legal', '法务 / 投诉', /^(?:abuse|dmca(?:agent)?|copyright|legal|notices)(?:[+._-]|$)/i],
  [
    'recruitment',
    '招聘',
    /^(?:hr|human[._-]?resources|careers?|jobs|recruit(?:ment|ing))(?:[+._-]|$)/i,
  ],
  [
    'support',
    '售后服务',
    /^(?:support|after[._-]?sales|customer[._-]?(?:service|support|care)|helpdesk|warranty|returns|repairs)(?:[+._-]|$)/i,
  ],
  [
    'finance',
    '财务 / 账务',
    /^(?:accounts?|accounting|finance|billing|invoices?|payments?)(?:[+._-]|$)/i,
  ],
  [
    'procurement',
    '采购 / 供应商合作',
    /^(?:purchasing|procurement|buying|buyer|purchases?|sourcing|suppliers?|vendors?)(?:[+._-]|$)/i,
  ],
  ['general', '通用咨询', /^(?:info|contact|enquiries|inquiries|office|hello|admin)(?:[+._-]|$)/i],
  ['sales', '销售咨询', /^sales(?:[+._-]|$)/i],
];
const priorities = { procurement: 0, management: 1, general: 2, sales: 3, unknown: 4 };
const labels = Object.fromEntries(types.map(([type, label]) => [type, label]));
labels.management = '经营负责人';
labels.unknown = '未识别';

function host(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password
      ? url.hostname
          .toLowerCase()
          .replace(/^www\./, '')
          .replace(/\.$/, '')
      : '';
  } catch {
    return '';
  }
}

function purposeInQuote(quote, sourceUrl) {
  if (
    /\b(?:customer (?:support|service|care)|after[- ]sales|technical support|warranty claims?|returns? department)\b|售后|维修服务/i.test(
      quote,
    )
  )
    return 'support';
  if (
    /\b(?:accounts? (?:payable|receivable)|billing (?:enquiries|inquiries)|invoices?|finance department)\b|财务|账务|发票/i.test(
      quote,
    )
  )
    return 'finance';
  if (/\b(?:recruitment|job applications?|careers?|human resources)\b|招聘|求职/i.test(quote))
    return 'recruitment';
  if (
    /\b(?:procurement|purchasing|sourcing|buying|buyer|(?:new|prospective|potential) (?:suppliers?|vendors?)|supplier (?:enquiries|inquiries|applications?|registration)|vendor (?:enquiries|inquiries|registration))\b|采购|供应商(?:合作|联系|入驻|申请)/i.test(
      quote,
    )
  )
    return 'procurement';
  if (
    /\b(?:owner|founder|managing director|chief executive|CEO|general manager)\b|经营负责人|总经理|创始人/i.test(
      quote,
    )
  )
    return 'management';
  if (
    /\b(?:general|business|commercial|product|order|trade)\s+(?:enquir(?:y|ies)|inquir(?:y|ies)|questions?|contact)\b|商务(?:咨询|联系)|业务(?:咨询|联系)/i.test(
      quote,
    )
  )
    return 'general';
  if (
    /\bsales\s+(?:team|department|enquir(?:y|ies)|inquir(?:y|ies)|contact)\b|销售咨询/i.test(quote)
  )
    return 'sales';
  if (
    /(?:privacy|legal|data[-_]?protection|gdpr|ccpa)/i.test(
      new URL(sourceUrl).pathname + new URL(sourceUrl).search,
    ) &&
    /\bunsubscrib(?:e|ing)\b|\bopt[ -]?out\b|\b(?:privacy|data[- ]?protection|data[- ]?subject)\s+(?:rights?|requests?|questions?|concerns?|inquir(?:y|ies)|enquir(?:y|ies))\b|\bexercise\b.{0,100}\b(?:rights?|choices)\b|\b(?:access|delet(?:e|ion)|eras(?:e|ure)|correct(?:ion)?|remov(?:e|al))\b.{0,80}\b(?:personal (?:data|information)|mailing list)\b|\b(?:questions?|concerns?|inquir(?:y|ies)|enquir(?:y|ies))\b.{0,70}\b(?:privacy (?:policy|notice)|personal (?:data|information))\b|退订|取消订阅|隐私(?:权|问题|请求)|个人(?:信息|数据).{0,20}(?:删除|更正|查阅)/i.test(
      quote,
    )
  )
    return 'privacy';
  return null;
}

// Classify current addresses only; historical evidence must never restore a removed address.
export function emailPurpose(address, evidence = [], website = '') {
  address = String(address).trim().toLowerCase();
  const local = address.split('@')[0];
  const inferred = types.find(([, , pattern]) => pattern.test(local))?.[0] || 'unknown';
  const entries = evidence.filter(
    (entry) =>
      entry?.kind === 'email' &&
      String(entry.value || '')
        .trim()
        .toLowerCase() === address,
  );
  const contexts = [];
  for (const entry of entries) {
    const sourceUrl = entry.source_url || entry.sourceUrl || '';
    if (!host(sourceUrl) || entry.method === 'guessed') continue;
    const official = Boolean(host(website)) && host(sourceUrl) === host(website);
    const original = String(entry.quote || '').trim();
    const quote =
      original
        .split(/[;；|\n]/)
        .find((part) => part.toLowerCase().includes(address))
        ?.trim() || original;
    const addresses = [
      ...new Set((quote.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []).map((v) => v.toLowerCase())),
    ];
    // shortcut: ambiguous multi-address excerpts use address inference; structured per-person evidence can refine them later.
    if (addresses.length > 1 || (addresses.length === 1 && addresses[0] !== address)) continue;
    const context = quote.replaceAll(
      new RegExp(address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      ' ',
    );
    const type = purposeInQuote(context, sourceUrl);
    if (type && (official || priorities[type] === undefined))
      contexts.push({ type, quote, context, sourceUrl, official });
  }
  const excluded = contexts.find((item) => priorities[item.type] === undefined);
  const chosen =
    excluded ||
    contexts.sort(
      (a, b) =>
        priorities[a.type] - priorities[b.type] ||
        a.sourceUrl.localeCompare(b.sourceUrl) ||
        a.quote.localeCompare(b.quote),
    )[0];
  const type = priorities[inferred] === undefined ? inferred : chosen?.type || inferred;
  const source = chosen?.type === type;
  const invalid = entries.some((entry) =>
    ['invalid', 'identity_conflict'].includes(entry.verification_status),
  );
  const context = source ? chosen.context : '';
  return {
    type,
    label: labels[type],
    basis: source
      ? chosen.official
        ? '官网说明'
        : '来源说明'
      : type === 'unknown'
        ? '暂无职责说明'
        : '邮箱名称推测',
    inferred: !source && type !== 'unknown',
    eligible: !invalid && priorities[type] !== undefined,
    priority: priorities[type] ?? 99,
    quote: source ? chosen.quote : '',
    sourceUrl: source ? chosen.sourceUrl : '',
    supplierEntry:
      /\b(?:new|prospective|potential)\s+(?:suppliers?|vendors?)\b|\b(?:supplier|vendor)\s+(?:registration|applications?|onboarding)\b|新供应商|供应商(?:入驻|申请)/i.test(
        context,
      ),
    namedBuyer:
      /\b(?:procurement|purchasing|sourcing|buying)\s+(?:manager|director|officer|head|lead)\b|\bhead of (?:procurement|purchasing)\b|采购(?:经理|负责人)/i.test(
        context,
      ),
    productScope:
      context
        .match(
          /(?:responsible for|(?:procurement|purchasing|sourcing|buyer)\s+(?:manager\s+)?(?:for|of)|采购(?:范围|品类)|负责采购)\s*[:：]?\s*([^.;|:：]+)/i,
        )?.[1]
        ?.trim() || '',
    marketScope:
      context.match(/(?:region|market|地区|市场)\s*[:：]\s*([^.;|:：]+)/i)?.[1]?.trim() || '',
  };
}
