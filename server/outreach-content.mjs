import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { domainKey } from './website-identity.mjs';
import { assessmentSummaryFields } from './customer-fields.mjs';
import { businessProductRelation, countryMatches, windowProductDirections } from './relevance.mjs';
import { researchProviderConfig } from './acquisition-config.mjs';
import { createResearchProviders } from './research-providers.mjs';

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const array = (value) => (Array.isArray(value) ? value : []);
const compact = (value) => text(value).replace(/\s+/gu, ' ');
const writerRoot = new URL('../agents/first-touch-writer/', import.meta.url);
const writerPrompt = readFileSync(new URL('system.md', writerRoot), 'utf8');
const confirmedSupply = JSON.parse(
  readFileSync(new URL('confirmed-supply.json', writerRoot), 'utf8'),
);

function confirmedWriterProduct(product) {
  if (array(product.brands).length !== 1) return null;
  const brand = confirmedSupply.brands.find((entry) => entry.name === product.brands[0]);
  const scope = brand?.products.find(
    (entry) => entry.name === product.englishName && entry.direction === product.direction,
  );
  return scope ? { brand: brand.name, domain: brand.domain, types: scope.types } : null;
}
const emailPattern =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
const untouched = new Set(['待开发', '未联系', '尚未联系', 'pending_outreach']);
const productFields = new Set(['products', 'manufactured_products', 'demand_products']);
const businessRoles = new Set([
  'supplier',
  'importer',
  'trader',
  'brand',
  'manufacturer',
  'contractor',
  'wholesaler',
  'service_provider',
  'installer',
  'distributor',
  'retailer',
]);
const marketAliases = {
  AU: 'Australia',
  US: 'United States',
  GB: 'United Kingdom',
  UK: 'United Kingdom',
  CA: 'Canada',
  NZ: 'New Zealand',
  CN: 'China',
};
const marketName = (value) => marketAliases[text(value).toUpperCase()] || text(value);

function publicUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !host.includes('.') ||
      isIP(host) ||
      /(?:^|\.)(?:localhost|local|internal)$/u.test(host)
    )
      return '';
    return url.href;
  } catch {
    return '';
  }
}

function ownSource(sourceUrl, domain) {
  const host = domainKey(sourceUrl);
  return Boolean(host && domain && (host === domain || host.endsWith('.' + domain)));
}

function sourceEvidence(fact, companyDomain) {
  const sourceUrl = publicUrl(fact?.source_url || fact?.sourceUrl);
  const quote = compact(fact?.quote);
  const value = typeof fact?.value === 'string' ? compact(fact.value) : '';
  if (
    !sourceUrl ||
    quote.length < 3 ||
    quote.length > 4000 ||
    !value ||
    !ownSource(sourceUrl, companyDomain)
  )
    return null;
  const field = text(fact.field);
  const id =
    'evidence-' +
    createHash('sha256')
      .update(JSON.stringify([field, value, quote, sourceUrl]))
      .digest('hex')
      .slice(0, 20);
  return { id, field, value, quote, sourceUrl };
}

function dedicatedContactPurpose(address, sourceUrl, quote) {
  const local = address.split('@')[0];
  if (
    /^(?:privacy(?:[._-]?(?:office|officer|team))?|data[._-]?(?:protection|rights)|dpo|dsar|gdpr|unsubscribe|opt[._-]?out|no[._-]?reply|do[._-]?not[._-]?reply|abuse|dmca(?:agent)?|copyright|legal|notices|hr|human[._-]?resources|careers?|jobs|recruit(?:ment|ing))(?:[+._-]|$)/iu.test(
      local,
    )
  )
    return true;
  // A policy page alone does not make its contact unsuitable: some businesses
  // publish their general commercial address there. Require an explicit purpose.
  if (!sourceUrl) return false;
  const source = new URL(sourceUrl);
  if (!/(?:privacy|legal|data[-_]?protection|gdpr|ccpa)/iu.test(source.pathname + source.search))
    return false;
  const purpose = quote.toLowerCase().replaceAll(address, '[email]');
  if (
    /\b(?:general|business|commercial|sales|product|order|trade)\s+(?:enquir(?:y|ies)|inquir(?:y|ies)|questions?|contact)\b|商务(?:咨询|联系)|业务(?:咨询|联系)/iu.test(
      purpose,
    )
  )
    return false;
  return /\bunsubscrib(?:e|ing)\b|\bopt[ -]?out\b|\b(?:privacy|data[- ]?protection|data[- ]?subject)\s+(?:rights?|requests?|questions?|concerns?|inquir(?:y|ies)|enquir(?:y|ies))\b|\bexercise\b.{0,100}\b(?:rights?|choices)\b|\b(?:access|delet(?:e|ion)|eras(?:e|ure)|correct(?:ion)?|remov(?:e|al))\b.{0,80}\b(?:personal (?:data|information)|mailing list)\b|\b(?:questions?|concerns?|inquir(?:y|ies)|enquir(?:y|ies))\b.{0,70}\b(?:privacy (?:policy|notice)|personal (?:data|information))\b|退订|取消订阅|隐私(?:权|问题|请求)|个人(?:信息|数据).{0,20}(?:删除|更正|查阅)/iu.test(
    purpose,
  );
}

// Only the existing research evidence establishes identity/products. Search labels,
// grade, website names and supplyOpportunity prose cannot stand in for those facts.
export function normalizeOutreachLead(lead = {}) {
  const website = publicUrl(lead.website);
  const companyDomain = domainKey(website);
  const evidence = array(lead.facts)
    .map((fact) => sourceEvidence(fact, companyDomain))
    .filter(Boolean);
  const emails = [
    ...new Set(
      text(lead.email)
        .split(/[\s,;，；、]+/u)
        .filter((value) => emailPattern.test(value))
        .map((value) => value.toLowerCase()),
    ),
  ];
  const contacts = emails.flatMap((address) => {
    const entries = array(lead.contactEvidence).filter(
      (entry) => entry?.kind === 'email' && text(entry.value).toLowerCase() === address,
    );
    const entry = entries.find(
      (item) =>
        item.verification_status !== 'invalid' &&
        !dedicatedContactPurpose(
          address,
          publicUrl(item.source_url || item.sourceUrl),
          compact(item.quote),
        ),
    );
    if ((!entry && entries.length) || dedicatedContactPurpose(address, '', '')) return [];
    return [
      {
        email: address,
        sourceUrl: publicUrl(entry?.source_url || entry?.sourceUrl),
        quote: compact(entry?.quote),
      },
    ];
  });
  const entities = evidence.filter((fact) => fact.field === 'entity_type');
  const business = entities.length
    ? entities.every((entity) => entity.value === 'business')
    : evidence.some(
        (fact) =>
          ['customer_type', 'customer_types'].includes(fact.field) && businessRoles.has(fact.value),
      );
  return {
    customerId: text(lead.id || lead.customerId),
    companyName: compact(lead.name || lead.companyName),
    companyDomain,
    website,
    market: text(lead.market),
    grade: text(lead.grade),
    matchLevel: text(lead.assessment?.matchLevel),
    status: text(lead.status),
    type: text(lead.type),
    business,
    evidence,
    contacts,
    emails,
    language: text(lead.language) || 'en',
    suppression: lead.suppression || {},
    humanOwned: lead.humanOwned === true || lead.human_owned === true,
    openConversation: lead.openConversation === true || lead.open_conversation === true,
  };
}

function identitySet(input) {
  const result = new Set();
  for (const item of input instanceof Set ? input : array(input)) {
    if (typeof item === 'string') {
      const identity = item.toLowerCase();
      result.add(identity);
      // The persistent worker stores typed keys; accept those alongside raw IDs.
      result.add(identity.replace(/^(?:company|domain|email):/u, ''));
    } else if (item && typeof item === 'object')
      for (const key of ['customerId', 'id', 'companyDomain', 'domain', 'email', 'to'])
        if (typeof item[key] === 'string') result.add(item[key].toLowerCase());
  }
  return result;
}

function recipient(contacts) {
  const unique = [...new Map(contacts.map((contact) => [contact.email, contact])).values()];
  const priority = (address) => {
    const local = address.split('@')[0];
    if (/^(?:purchasing|procurement|buying|purchases|purchase)(?:[._-]|$)/i.test(local)) return 0;
    if (/^(?:info|contact|enquiries|inquiries)(?:[._-]|$)/i.test(local)) return 1;
    if (/^(?:sales|office|hello|admin)(?:[._-]|$)/i.test(local)) return 2;
    return 3;
  };
  unique.sort((a, b) => priority(a.email) - priority(b.email) || a.email.localeCompare(b.email));
  if (!unique.length)
    return { error: 'contact_unverified', reason: '客户库中没有格式有效且适合商务联系的邮箱' };
  return { contact: unique[0] };
}

export function outreachProductScope(product) {
  return {
    productId: product.id,
    name: text(product.name),
    englishName: text(product.englishName),
    category: product.category || 'other',
    direction: product.direction,
    deliveryForms: [...array(product.deliveryForms)].sort(),
    brands: [...array(product.brands)].sort(),
    markets: [...array(product.markets)].sort(),
  };
}

export function eligibleOutreachFacts(product, campaign, now = new Date()) {
  if (!product || product.status !== 'approved' || !Number.isFinite(new Date(now).getTime()))
    return [];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
    new Date(now),
  );
  if (product.effectiveDate && product.effectiveDate > today) return [];
  if (Array.isArray(campaign?.productScopes)) {
    const scope = campaign.productScopes.find((row) => row.productId === product.id);
    if (!scope || JSON.stringify(scope) !== JSON.stringify(outreachProductScope(product)))
      return [];
  } else return [];
  const name = text(product.englishName);
  const confirmed = confirmedWriterProduct(product);
  return name
    ? [
        {
          id: `product-${product.id}-${product.version}`,
          kind: 'product',
          text: `We supply ${name}.`,
          conditions: '',
          validUntil: null,
        },
        ...(confirmed
          ? [
              {
                id: `manufacturing-${product.id}-${confirmedSupply.confirmedOn}`,
                kind: 'product',
                text: `${confirmed.brand} manufactures and supplies ${name}.${confirmed.types.length ? ` Confirmed product types: ${confirmed.types.join(', ')}.` : ''}`,
                conditions: '',
                validUntil: null,
              },
            ]
          : []),
      ]
    : [];
}

export function outreachMaterialVersion(product, campaign, now = new Date()) {
  const facts = eligibleOutreachFacts(product, campaign, now);
  return facts.length
    ? createHash('sha256')
        .update(
          JSON.stringify([
            product.version,
            outreachProductScope(product),
            facts,
            writerPrompt,
            confirmedSupply,
          ]),
        )
        .digest('hex')
    : null;
}

function productMatch(product, evidence) {
  const terms = [
    ...new Set(
      [product.englishName, product.name, ...array(product.aliases)].map(text).filter(Boolean),
    ),
  ];
  const matches = [];
  for (const fact of evidence.filter((entry) => productFields.has(entry.field))) {
    // Roll shutters share a broad category but are not plantation shutters.
    if (
      product.englishName.toLowerCase() === 'plantation shutters' &&
      ![fact.value, fact.quote].every((value) => /plantation\s+shutters?|透气窗/iu.test(value))
    )
      continue;
    for (const term of terms) {
      // Both the extracted value and original quotation must support the family.
      const target = { product_scope: 'specific', product: term };
      const valueMatch = businessProductRelation([fact.value], target);
      const quoteMatch = businessProductRelation([fact.quote], target);
      if (valueMatch.status !== 'matched' || quoteMatch.status !== 'matched') continue;
      const directions = windowProductDirections(fact.value + ' ' + fact.quote);
      if (!directions.includes(product.direction)) continue;
      // Merely retailing a finished product does not establish an inputs business.
      if (
        product.direction === 'materials' &&
        (valueMatch.kind === 'potential_input' || quoteMatch.kind === 'potential_input')
      )
        continue;
      const normalizedTerm = compact(term).normalize('NFKC').toLowerCase();
      const normalizedValue = compact(fact.value).normalize('NFKC').toLowerCase();
      const normalizedQuote = compact(fact.quote).normalize('NFKC').toLowerCase();
      const score =
        (normalizedValue === normalizedTerm
          ? 10
          : normalizedValue.includes(normalizedTerm)
            ? 7
            : 3) +
        (normalizedQuote.includes(normalizedTerm) ? 3 : 0) +
        (fact.field === 'demand_products' ? 2 : 0) +
        Math.min(normalizedTerm.length, 80) / 1000;
      matches.push({ evidence: fact, term, score });
    }
  }
  matches.sort(
    (a, b) =>
      b.score - a.score ||
      a.evidence.id.localeCompare(b.evidence.id) ||
      a.term.localeCompare(b.term),
  );
  return matches[0] || null;
}

export function selectOutreachCandidates({
  leads = [],
  mailboxes = [],
  products = [],
  campaign = {},
  suppressed = [],
  contacted = [],
  now = new Date(),
} = {}) {
  const eligible = [],
    blocked = [];
  const suppressedKeys = identitySet(suppressed),
    contactedKeys = identitySet(contacted);
  const selectedDomains = new Set(),
    selectedIds = new Set(),
    selectedRecipients = new Set();
  const selectedProducts = array(campaign.filters?.products);
  const selectedCategories = array(campaign.filters?.categories);
  const selectedMailboxes = array(campaign.mailboxIds);
  const selectedCustomers = array(campaign.customerIds);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
    new Date(now),
  );
  const availableProducts = products.filter(
    (product) =>
      product.status === 'approved' &&
      (!product.effectiveDate || product.effectiveDate <= today) &&
      (!selectedCategories.length || selectedCategories.includes(product.category)) &&
      (!selectedProducts.length || selectedProducts.includes(product.id)),
  );
  const senders = mailboxes.filter(
    (mailbox) => !selectedMailboxes.length || selectedMailboxes.includes(mailbox.id),
  );
  const allocated = new Map();
  const workload = (mailbox) => {
    const existing = mailbox.workload === undefined ? 0 : mailbox.workload;
    return Number.isSafeInteger(existing) && existing >= 0
      ? existing + (allocated.get(mailbox.id) || 0)
      : Number.POSITIVE_INFINITY;
  };
  for (const raw of [...leads].sort((a, b) => Number(b.grade === 'A') - Number(a.grade === 'A'))) {
    const lead = normalizeOutreachLead(raw);
    const assignment = array(campaign.senderAssignments).find(
      (row) => row.customerId === lead.customerId,
    );
    if (selectedCustomers.length && !selectedCustomers.includes(lead.customerId)) continue;
    if (
      array(campaign.filters?.markets).length &&
      countryMatches(marketName(lead.market), campaign.filters.markets.map(marketName)) !==
        'matched'
    )
      continue;
    const base = {
      customerId: lead.customerId,
      companyName: lead.companyName,
      companyDomain: lead.companyDomain,
      to: '',
      mailboxId: null,
    };
    const reject = (reasonCode, reason) =>
      blocked.push({ ...base, reasonCode, reason, leadSnapshot: lead });
    const grades = array(campaign.filters?.grades);
    if (grades.length && !grades.includes(lead.grade)) continue;
    if (lead.matchLevel === '不匹配' || ['待核实', '待补全', '暂不开发'].includes(lead.grade)) {
      reject('match_unverified', '客户匹配依据待核实或已明确不匹配，暂缓自动首封');
      continue;
    }
    if (assessmentSummaryFields(raw.assessment)['待确认事项']) {
      reject('assessment_conflict', '客户经营事实仍有冲突，暂缓自动首封');
      continue;
    }
    const identities = [lead.customerId, lead.companyDomain, ...lead.emails]
      .filter(Boolean)
      .map((v) => v.toLowerCase());
    if (!lead.customerId || !lead.companyName || !lead.companyDomain) {
      reject('identity_incomplete', '企业身份或官网信息尚未确认');
      continue;
    }
    if (
      identities.some((value) => suppressedKeys.has(value)) ||
      Object.entries(lead.suppression).some(([key, value]) => key !== 'reason' && value === true)
    ) {
      reject('suppressed', '该企业或联系地址已标记为勿再联系');
      continue;
    }
    if (
      identities.some((value) => contactedKeys.has(value)) ||
      !untouched.has(lead.status) ||
      lead.humanOwned ||
      lead.openConversation
    ) {
      reject('already_contacted_or_unknown', '客户已联系、已由人工接手或联系历史尚未明确');
      continue;
    }
    if (!lead.business) {
      reject('business_unverified', '缺少有来源的企业经营主体依据');
      continue;
    }
    const contactResult = recipient(lead.contacts);
    if (contactResult.error) {
      reject(contactResult.error, contactResult.reason);
      continue;
    }
    base.to = contactResult.contact.email;
    if (
      selectedDomains.has(lead.companyDomain) ||
      selectedIds.has(lead.customerId) ||
      selectedRecipients.has(base.to)
    ) {
      reject('duplicate_company', '同一企业或收件地址已在本次首封名单中');
      continue;
    }
    const matches = [];
    let missingScope = false;
    for (const product of availableProducts) {
      if (assignment && assignment.productId !== product.id) continue;
      if (
        array(product.markets).length &&
        !product.markets.some((market) =>
          ['all', 'global', '全部', '不限'].includes(text(market).toLowerCase()),
        ) &&
        countryMatches(marketName(lead.market), product.markets.map(marketName)) !== 'matched'
      )
        continue;
      const match = productMatch(product, lead.evidence);
      if (!match) continue;
      if (!eligibleOutreachFacts(product, campaign, now).length) {
        missingScope = true;
        continue;
      }
      matches.push({ product, match });
    }
    if (!matches.length) {
      reject(
        missingScope ? 'product_scope_unconfirmed' : 'product_match_unconfirmed',
        missingScope
          ? '匹配产品不在当前计划的已确认产品范围内，请核对计划与发件邮箱'
          : '尚无已审核且有客户经营证据支持的产品匹配',
      );
      continue;
    }
    // Evidence selects the product before workload is considered. A sender may
    // represent only its explicitly assigned products; capacity cannot change
    // the product or move a customer to an unrelated business identity.
    matches.sort(
      (a, b) => b.match.score - a.match.score || a.product.id.localeCompare(b.product.id),
    );
    const chosen = matches[0];
    const permittedSenders = senders.filter(
      (mailbox) =>
        array(mailbox.productIds).includes(chosen.product.id) &&
        (!assignment || assignment.mailboxId === mailbox.id),
    );
    if (!permittedSenders.length) {
      reject('mailbox_product_unassigned', '计划中尚无获准介绍该产品的发件邮箱');
      continue;
    }
    const connectedSenders = permittedSenders.filter(
      (mailbox) => mailbox.configured && !mailbox.paused && mailbox.smtpStatus === 'connected',
    );
    if (!connectedSenders.length) {
      reject('mailbox_unavailable', '该产品对应的邮箱已暂停或尚未通过连接验证');
      continue;
    }
    const readySenders = connectedSenders.filter(
      (mailbox) => text(mailbox.signature) && text(mailbox.displayName),
    );
    if (!readySenders.length) {
      reject('sender_identity_incomplete', '请先填写可用邮箱的发件人名称和固定签名');
      continue;
    }
    const availableSenders = readySenders.filter(
      (mailbox) =>
        Number.isSafeInteger(mailbox.dailyLimit) && mailbox.dailyLimit > workload(mailbox),
    );
    availableSenders.sort(
      (a, b) =>
        workload(a) - workload(b) ||
        text(a.email).toLowerCase().localeCompare(text(b.email).toLowerCase()) ||
        a.id.localeCompare(b.id),
    );
    const mailbox = availableSenders[0];
    if (!mailbox) {
      reject('mailbox_capacity_exhausted', '该产品对应邮箱的当日额度已用完或已分配给待发邮件');
      continue;
    }
    base.mailboxId = mailbox.id;
    allocated.set(mailbox.id, (allocated.get(mailbox.id) || 0) + 1);
    selectedIds.add(lead.customerId);
    selectedDomains.add(lead.companyDomain);
    selectedRecipients.add(base.to);
    eligible.push({
      ...base,
      productId: chosen.product.id,
      productVersion: chosen.product.version,
      materialVersion: outreachMaterialVersion(chosen.product, campaign, now),
      evidence: [
        chosen.match.evidence,
        ...lead.evidence
          .filter(
            (entry) =>
              entry.id !== chosen.match.evidence.id && productMatch(chosen.product, [entry]),
          )
          .slice(0, 2),
      ],
      contactEvidence: contactResult.contact,
      matchReason: `客户官网记录“${chosen.match.evidence.value}”，匹配${chosen.product.name}（${{ finished: '成品', materials: '材料配件', samples: '样本展示' }[chosen.product.direction] || chosen.product.direction}）；由获准介绍该产品的${mailbox.email}发送`,
      leadSnapshot: lead,
    });
  }
  return { eligible, blocked };
}

function parseGenerated(response, schema) {
  const choice = response?.choices?.[0];
  let content;
  if (choice?.finish_reason === 'stop') content = choice.message?.content;
  else if (response?.status === 'completed')
    content = array(response.output)
      .flatMap((item) => array(item.content))
      .filter((item) => item.type === 'output_text')
      .map((item) => item.text)
      .join('');
  if (typeof content !== 'string' || content.length > 24000)
    throw fail(502, '开发信生成未完整返回，请重新生成', 'outreach_generation_incomplete');
  try {
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*|```\s*$/gu, ''));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).some((key) => !Object.hasOwn(schema.properties, key)) ||
      schema.required.some((key) => !Object.hasOwn(parsed, key))
    )
      throw new Error();
    return parsed;
  } catch {
    throw fail(502, '开发信生成格式不正确，请重新生成', 'outreach_generation_invalid');
  }
}

// Only selected approved facts reach the model; credentials and full records stay local.
export function createOutreachGenerator({ env = {}, fetchImpl = fetch } = {}) {
  let provider,
    configured = false,
    configurationError;
  try {
    const modelEnv = {
      ...env,
      RESEARCH_MODEL_MAX_OUTPUT_TOKENS: '4096',
      RESEARCH_MODEL_REASONING_EFFORT: 'none',
    };
    const config = researchProviderConfig(modelEnv).model;
    configured = Boolean(config.apiKey && config.baseUrl && config.model);
    if (configured) provider = createResearchProviders({ env: modelEnv, fetchImpl }).model;
  } catch {
    configurationError = '请先在连接设置中配置可用的研究模型';
  }
  return {
    configured,
    configurationError: configured ? null : configurationError || '请先在连接设置中配置研究模型',
    async generate({ candidate, mailbox, product, campaign, now = new Date() }) {
      if (!configured)
        throw fail(503, '请先在连接设置中配置开发信使用的研究模型', 'outreach_model_unconfigured');
      const facts = eligibleOutreachFacts(product, campaign, now);
      const materialVersion = outreachMaterialVersion(product, campaign, now);
      if (
        !facts.length ||
        !materialVersion ||
        candidate.productId !== product.id ||
        candidate.productVersion !== product.version ||
        candidate.mailboxId !== mailbox.id ||
        !array(mailbox.productIds).includes(product.id) ||
        (candidate.materialVersion && candidate.materialVersion !== materialVersion)
      )
        throw fail(
          409,
          '产品或发件身份已变化，请重新匹配客户并审核计划',
          'outreach_snapshot_stale',
        );
      const evidence = array(candidate.evidence).filter(
        (entry) => entry.id && entry.quote && entry.sourceUrl,
      );
      if (!evidence.length)
        throw fail(409, '缺少客户经营依据，无法生成开发信', 'outreach_evidence_missing');
      const confirmed = confirmedWriterProduct(product);
      const manufacturingConfirmed = Boolean(
        confirmed &&
          mailbox.brandName === confirmed.brand &&
          domainKey(mailbox.website) === confirmed.domain &&
          text(mailbox.email).toLowerCase().split('@')[1] === confirmed.domain,
      );
      const writerFacts = manufacturingConfirmed ? facts : facts.slice(0, 1);
      const matchedTypes = manufacturingConfirmed
        ? confirmed.types.filter((type) =>
            [evidence[0].value, evidence[0].quote].every((value) =>
              text(value).toLowerCase().includes(type.toLowerCase()),
            ),
          )
        : [];
      const schema = {
        type: 'object',
        additionalProperties: false,
        required: ['subject', 'body_text', 'source_ids'],
        properties: {
          subject: { type: 'string' },
          body_text: {
            type: 'string',
            description:
              '55–85 English words in exactly three paragraphs separated by two newline characters: customer observation, sender brand and product supply introduction, then one easy question about a brief overview or introduction. No greeting or signature.',
          },
          source_ids: { type: 'array', items: { type: 'string' } },
        },
      };
      const input = {
        customer: {
          name: candidate.companyName,
          country: candidate.leadSnapshot?.market,
          business: candidate.leadSnapshot?.type,
          general_inbox:
            /^(?:info|contact|reception|help|hello|office|enquiries|inquiries|admin|support|sales)(?:[._+-].*)?$/iu.test(
              text(candidate.to).split('@')[0],
            ),
          evidence,
        },
        sender: {
          brand: mailbox.brandName,
          product: product.englishName,
          focus_product: matchedTypes.length === 1 ? matchedTypes[0] : product.englishName,
          manufacturing_confirmed: manufacturingConfirmed,
          origin_country: manufacturingConfirmed ? confirmedSupply.originCountry : null,
          confirmed_product_types: manufacturingConfirmed ? confirmed.types : [],
          facts: writerFacts,
        },
      };
      const messages = [
        {
          role: 'system',
          content: writerPrompt,
        },
        { role: 'user', content: JSON.stringify(input) },
      ];
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await provider.research({ schema, messages });
        const draft = parseGenerated(response, schema);
        const subject = text(draft.subject),
          bodyText = text(draft.body_text).replace(
            /^(?:hello|hi|dear)(?:\s+(?:there|team|all))?\s*[,!:]\s*/iu,
            '',
          );
        if (
          !subject ||
          subject.length > 150 ||
          /[\r\n\u0000-\u001f\u007f]/u.test(subject) ||
          /^\s*(?:re|fwd?)\s*:/iu.test(subject) ||
          !bodyText ||
          bodyText.length > 6000 ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(bodyText) ||
          !Array.isArray(draft.source_ids) ||
          !draft.source_ids.length ||
          draft.source_ids.length > 3 ||
          new Set(draft.source_ids).size !== draft.source_ids.length ||
          draft.source_ids.some((id) => !evidence.some((e) => e.id === id))
        )
          throw fail(502, '开发信内容或客户依据不完整，请重试', 'outreach_generation_invalid');
        if (
          /https?:\/\/|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|[$€£¥]|\b(?:USD|EUR|MOQ|stock|certif\w*|guarantee\w*|lead[ -]?time|pricing|prices?|discounts?|delivery|freight|payment|attached|attachments?)\b/iu.test(
            subject + '\n' + bodyText,
          ) ||
          (!manufacturingConfirmed &&
            /\b(?:manufactur\w*|factor(?:y|ies))\b|\bfrom China\b/iu.test(
              subject + '\n' + bodyText,
            )) ||
          confirmedSupply.brands.some(
            (brand) =>
              brand.name !== mailbox.brandName &&
              (subject + '\n' + bodyText).toLowerCase().includes(brand.name.toLowerCase()),
          ) ||
          /\b(?:we\s+(?:focus|speciali[sz]e)\s+on|our\s+(?:focus|specialt(?:y|ies)|speciali[sz]ation))\b/iu.test(
            bodyText,
          ) ||
          /\b(?:you(?:'re| are)?\s+(?:looking\s+for|seeking|ready\s+to\s+buy)|your\s+(?:purchase\s+request|inquiry|enquiry|order))\b/iu.test(
            bodyText,
          )
        )
          throw fail(502, '开发信包含未确认的商务信息，请重试', 'outreach_unsupported_claim');
        const wordCount = bodyText.split(/\s+/u).length;
        const paragraphs = bodyText.split(/\n\s*\n/u);
        if (
          wordCount < 50 ||
          wordCount > 90 ||
          paragraphs.length !== 3 ||
          /\b(?:terms(?: and conditions)?|privacy|cookie|legal)\s+(?:page|policy|notice)\b|\bterms and conditions\b/iu.test(
            paragraphs[0],
          ) ||
          paragraphs[0].toLowerCase().includes(mailbox.brandName.toLowerCase()) ||
          !paragraphs[1].toLowerCase().includes(mailbox.brandName.toLowerCase()) ||
          !/\b(?:suppl(?:y|ier|iers)|manufactur\w*)\b/iu.test(paragraphs[1]) ||
          (bodyText.match(/\?/gu) || []).length !== 1 ||
          !bodyText.endsWith('?') ||
          /^(?:hello|hi|dear)\b|\bI hope this email finds you well\b|(?:^|\n)\s*(?:(?:best|kind|warm)\s+)?(?:regards|sincerely|yours (?:truly|sincerely)|thank you)(?:\s*[,!]|$)|\bconfirmed (?:range|types?|product types?)\b/iu.test(
            bodyText,
          )
        ) {
          if (attempt === 0) {
            messages.push(
              { role: 'assistant', content: JSON.stringify(draft) },
              {
                role: 'user',
                content: `Revise the draft's writing format only, using the same supplied facts and focus_product. It currently has ${wordCount} words and ${paragraphs.length} paragraphs. Return 60–75 English words in exactly three paragraphs separated by two newlines: paragraph 1 describes the customer's matching product as an offer or activity, without naming a terms, privacy or legal page; paragraph 2 names the sender brand, states its approved product supply and explains the contact purpose plainly; paragraph 3 is one easy question about a brief overview or introduction, optionally for the sourcing colleague if this is a general inbox. Add no filler, invented customer facts or counts inferred from a bare number in a source excerpt. No greeting, signature, generic well-wishes or internal phrases such as confirmed range/types. Keep customer source IDs valid and supplier claims grounded. Return the same JSON fields.`,
              },
            );
            continue;
          }
          throw fail(
            502,
            '开发信应约 55–85 词，依次写客户观察、品牌供货介绍和一个容易回复的问题，请重试',
            'outreach_generation_invalid',
          );
        }
        return {
          subject,
          bodyText: `Hi ${candidate.companyName} team,\n\n${bodyText}`,
          sourceIds: draft.source_ids,
          factIds: writerFacts.map((f) => f.id),
          materialVersion,
        };
      }
    },
  };
}
