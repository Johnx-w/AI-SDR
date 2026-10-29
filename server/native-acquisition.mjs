import { randomUUID } from 'node:crypto';
import { acquisitionConfig } from './acquisition-config.mjs';
import { createResearchProviders } from './research-providers.mjs';
import { researchCacheKey } from './research-reuse.mjs';
import { boundedResearchPages } from './research-input.mjs';
import { CustomsDiscovery, customsConfig } from './customs-discovery.mjs';
import { matchShipmentBuyer } from './shipment-evidence.mjs';
import { AcquisitionStore } from './acquisition-store.mjs';
import { FeishuClient, encodeResearchFields, recordsForDomain } from './feishu-direct.mjs';
import { fieldText } from './feishu.mjs';
import { updateLeadContacts, applyContactCorrections } from './lead-contacts.mjs';
import { LeadSupplementStore } from './lead-supplement-store.mjs';
import {
  saveLeadSupplement,
  decorateDossierConfirmations,
  resolveConfirmedPending,
} from './lead-supplement-service.mjs';
import { applySupplementsToResearch } from './lead-supplements.mjs';
import { domainKey, thirdPartyCompanySource } from './website-identity.mjs';
import { calculateHandoffReadiness } from './handoff-readiness.mjs';
import { searchPlan } from './search-plan.mjs';
import { readPublicHtml, websiteUrl } from './branding.mjs';
import { planWebsitePages, combineWebsiteEvidence, websiteScope } from './website-metadata.mjs';
import { researchPageText } from './research-pages.mjs';
import {
  companyResearchRequest,
  companyResearchSchema,
  parseCompanyResearch,
  researchFields,
  mergeResearchFields,
} from './company-research.mjs';
import { pageRelevance } from './relevance.mjs';
import { validateTarget } from './search-target.mjs';
import { normalizeCountry } from './relevance.mjs';
import { markets } from './markets.mjs';
import {
  assessCompany,
  assessmentId,
  assessmentRating,
  formatAssessmentEvidence,
  ASSESSMENT_RULE_VERSION,
} from './customer-assessment.mjs';
import { AssessmentService } from './assessment-service.mjs';
import {
  BUSINESS_SCHEMA_VERSION,
  assessmentSummaryFields,
  canonicalCustomerFields,
  customerSource,
  customerWebsite,
  fieldValue,
  resolveCustomerField,
} from './customer-fields.mjs';

const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const blockedHosts =
  /(?:^|\.)(?:facebook|instagram|linkedin|youtube|youtu|tiktok|twitter|x|pinterest|reddit|quora|wikipedia|alibaba|made-in-china|seek|indeed|jora|glassdoor|careerone|adzuna|jobsora|jooble|talent|careerjet|simplyhired|ziprecruiter|workforceaustralia|hipages|oneflare|yellowpages|truelocal|localsearch|hotfrog|yelp|houzz|gumtree|airtasker|serviceseeking|startlocal|aussieweb|dlook|brownbook|boombusinessdirectory|cylex|yably|bark|google|bing|amazon|ebay|eventbrite|medium)\./i;
const blockedMedia = [
  'abc.net.au',
  'smh.com.au',
  'news.com.au',
  'dailytelegraph.com.au',
  'theguardian.com',
  '9news.com.au',
  '7news.com.au',
  'ctvnews.ca',
];
// Apply the same source qualification to discovery and queued/direct research.
// A third-party company profile is not the company's independently verified site.
function companyWebsiteSourceUrl(value, evidence = {}) {
  const url = websiteUrl(value);
  if (!url) return null;
  const domain = domainKey(url.href);
  if (
    blockedHosts.test(url.hostname) ||
    thirdPartyCompanySource({ ...evidence, url: url.href }) ||
    /gazette|herald|tribune|chronicle|newspaper|news\.co/i.test(url.hostname) ||
    blockedMedia.some((host) => domain === host || domain.endsWith('.' + host)) ||
    /directory|findglocal|word-of-mouth|superpages/i.test(url.hostname) ||
    /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar)$/i.test(url.pathname) ||
    /\/(jobs?|careers?|vacanc[^/]*|employment|news|wiki|directory|listings?)(\/|$)/i.test(
      url.pathname,
    )
  )
    return null;
  return url;
}

export function selectWebsiteCandidates(results, knownDomains = [], limit = 20) {
  const known = new Set(knownDomains),
    seen = new Set(),
    candidates = [],
    skipped = [];
  for (const result of results) {
    const url = companyWebsiteSourceUrl(result?.url, {
      title: result?.title,
      text: [result?.content, result?.raw_content].filter(Boolean).join(' '),
    });
    if (!url) continue;
    const domain = domainKey(url.href);
    if (known.has(domain)) {
      skipped.push({ domain, url: url.href });
      continue;
    }
    if (seen.has(domain)) continue;
    seen.add(domain);
    candidates.push({
      source_url: url.href,
      source_title: result.title || '',
      source_kind: 'website',
      domain,
    });
    if (candidates.length >= limit) break;
  }
  return { candidates, skipped_existing: skipped, skipped_existing_count: skipped.length };
}

// Name evidence is necessary to queue a customs website, not proof of identity.
// Keep the later official-page/party/address match as the final association gate.
function shipmentWebsiteNameScore(result, buyerName) {
  const normalized = (value) =>
    String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const name = normalized(buyerName)
    .replace(
      /\b(?:incorporated|corporation|limited|inc|corp|ltd|llc|company|co|gmbh|pty|the)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
  const words = name.split(' ').filter(Boolean);
  const distinctive = words.filter(
    (word) =>
      word.length >= 3 &&
      !/^(?:blinds?|shades?|shutters?|windows?|coverings?|fabrics?|components?|products?|distribution|group|international|home|and|for|to|go)$/.test(
        word,
      ),
  );
  const text = normalized(
    [result.title, result.content, result.raw_content].filter(Boolean).join(' '),
  );
  const host = domainKey(result.url).replace(/[^\p{L}\p{N}]/gu, '');
  const inHost = (word) => host.includes(word.replace(/ /g, ''));
  const contains = (word) => (' ' + text + ' ').includes(' ' + word + ' ') || inHost(word);
  const evidence = distinctive.length ? distinctive : [name];
  if ((!distinctive.length && (words.length < 2 || name.length < 6)) || !evidence.every(contains))
    return 0;
  // A dealer mentioning a supplier is not the supplier's official site. Keep
  // normal brand/legal-name relations for the later verbatim identity audit.
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (
    evidence.some((word) =>
      new RegExp(
        '\\b(?:dealers?|distributors?|resellers?|retailers?|stockists?|partners?)' +
          '(?:\\s+\\w+){0,2}\\s+(?:for|of)\\s+' +
          escaped(word) +
          '\\b',
      ).test(text),
    )
  )
    return 0;
  // A brand's own domain is a stronger locator than a dealer mentioning it.
  // Neither is sufficient to bypass the later official-page identity check.
  return evidence.every(inHost) ? 2 : 1;
}

// Provider-reported billing only: an attempted call without valid usage makes
// the total unknown, rather than silently treating its missing credits as zero.
function webUsageCounter(operation) {
  let calls = 0,
    reported = 0,
    credits = 0;
  return {
    start() {
      calls++;
    },
    observe(response) {
      const value = response?.usage?.credits;
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        reported++;
        credits += value;
      }
    },
    snapshot() {
      return {
        ['web_' + operation + '_calls']: calls,
        ...(calls > 0 && reported === calls && Number.isFinite(credits)
          ? { ['web_' + operation + '_credits']: credits }
          : {}),
      };
    },
  };
}

export class NativeAcquisition {
  constructor({
    env,
    fetchImpl = fetch,
    readPage = readPublicHtml,
    feishu,
    store,
    assessments,
    providers,
    customs,
  } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.readPage = readPage;
    this.providers = providers || createResearchProviders({ env, fetchImpl });
    this.customs = customs;
    this.feishu = feishu || new FeishuClient({ env, fetchImpl });
    this.store =
      store ||
      new AcquisitionStore(
        env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH || ':memory:',
        String(env.FEISHU_APP_TOKEN) + '/' + String(env.FEISHU_TABLE_ID),
      );
    this.active = new Set();
    this.assessments = assessments || new AssessmentService({ env });
    this.supplements = new LeadSupplementStore(
      env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH || ':memory:',
      String(env.FEISHU_APP_TOKEN) + '/' + String(env.FEISHU_TABLE_ID),
    );
  }
  assessmentInfo() {
    return {
      ruleVersion: ASSESSMENT_RULE_VERSION,
      markets,
      customs: customsConfig(this.env).configured ? 'discovery_connected' : 'not_connected',
      customsIncludedInInitialScore: false,
      assessmentStorage: 'latest_only',
      businessSchemaVersion: BUSINESS_SCHEMA_VERSION,
    };
  }
  decorateLeads(data) {
    return {
      ...data,
      leads: data.leads.map((lead) => {
        lead = applyContactCorrections(lead, this.store.contactCorrections(lead.id));
        const currentEmails = new Set(
          String(lead.email || '')
            .split(/[\s,;，；、]+/u)
            .filter(Boolean)
            .map((value) => value.toLowerCase()),
        );
        const contactEvidence = [
          ...new Map(
            [
              ...(lead.contactEvidence || []),
              ...(this.store.researchEmailEvidence?.(lead.id, lead.website) || []),
            ]
              .filter(
                (contact) =>
                  contact.kind !== 'email' ||
                  currentEmails.has(String(contact.value).toLowerCase()),
              )
              .map((contact) => [
                JSON.stringify([contact.kind, contact.value, contact.source_url, contact.quote]),
                contact,
              ]),
          ).values(),
        ];
        lead = {
          ...lead,
          contactEvidence,
          companyIdentity: this.store.companyIdentity(lead.id, lead.website, lead.name),
          customsEvidence: this.store.customsEvidence(lead.website),
        };
        const stored = lead.assessment?.id
          ? this.assessments.summary(lead.assessment.id)
          : !lead.ratingReason
            ? this.assessments.latest(lead.id)
            : null;
        if (
          !stored ||
          stored.recordId !== lead.id ||
          domainKey(stored.website) !== domainKey(lead.website) ||
          (lead.ratingReason && stored.reason !== lead.ratingReason)
        )
          return decorateDossierConfirmations(
            lead,
            this.supplements.confirmations(lead.id, lead.website),
          );
        const readable = (fact) => ({
          ...fact,
          value:
            typeof fact.value === 'object' && fact.value !== null
              ? Object.values(fact.value).filter(Boolean).join(', ')
              : String(fact.value ?? ''),
        });
        const facts = [
          ...stored.facts,
          ...stored.opportunities.flatMap((o) => o.facts.map((f) => ({ ...f, field: f.kind }))),
        ]
          .filter((fact) => fact.origin !== 'manual')
          .map(readable);
        const manualOverride = assessmentRating(stored) !== lead.grade;
        const summaries = assessmentSummaryFields(stored);
        return decorateDossierConfirmations(
          {
            ...lead,
            supplyOpportunity: summaries['主要供货机会'],
            pendingQuestions: summaries['待确认事项'],
            score: stored.score,
            ratingReason: lead.ratingReason || stored.reason,
            facts,
            assessment: {
              id: stored.id,
              ruleVersion: stored.ruleVersion,
              evaluatedAt: stored.evaluatedAt,
              score: stored.score,
              grade: manualOverride ? (lead.grade === '未评级' ? null : lead.grade) : stored.grade,
              status: manualOverride ? '主表评级已修改；后台保留最新自动评估供核对' : stored.status,
              complete: stored.complete,
              manualOverride,
              product: stored.product,
              direction: stored.direction,
              supplyOpportunity: stored.supplyOpportunity,
              opportunities: stored.opportunities.map((o) => ({
                direction: o.direction,
                product: o.product,
              })),
              evidenceReason: formatAssessmentEvidence(stored),
              incompleteReason: stored.incompleteReason,
              missing: stored.missing,
              dimensions: Object.fromEntries(
                Object.entries(stored.dimensions).map(([k, d]) => [
                  k,
                  {
                    score: d.score,
                    maximum: d.maximum,
                    missing: d.missing,
                    facts: (Array.isArray(d.facts) ? d.facts : []).map((fact) => ({
                      kind: fact.kind,
                      value: readable(fact).value,
                      quote: fact.quote,
                      source_url: fact.source_url,
                      ...(fact.origin === 'manual'
                        ? {
                            origin: 'manual',
                            confirmationId: fact.confirmationId,
                            confirmedBy: fact.confirmedBy,
                            confirmedAt: fact.confirmedAt,
                          }
                        : {}),
                    })),
                    ...(d.conflict ? { conflict: true } : {}),
                  },
                ]),
              ),
            },
          },
          this.supplements.confirmations(lead.id, lead.website),
        );
      }),
    };
  }
  updateContacts(id, input) {
    return updateLeadContacts({ feishu: this.feishu, store: this.store, id, input });
  }
  supplementRecord(id, input, key, business) {
    return saveLeadSupplement({ engine: this, id, input, key, business });
  }
  async pendingSupplement(id) {
    const pending = this.supplements.pending(id);
    if (!pending) return { pending: null };
    const record = await this.feishu.record(id);
    if (domainKey(customerWebsite(record)) !== domainKey(pending.website)) {
      this.supplements.supersede(pending);
      return { pending: null };
    }
    return { pending: { input: pending.input, key: pending.key } };
  }
  async assessRecord(recordId, body, operationId) {
    const definitions = await this.feishu.fields();
    for (const [name, type] of [
      ['用户评级', 3],
      ['最近研究时间', 5],
    ])
      if (
        !definitions.some(
          (field) =>
            field.field_name === resolveCustomerField(definitions, name) && field.type === type,
        )
      )
        throw Object.assign(new Error('请先完成T2评分字段配置：' + name), { status: 503 });
    const record = await this.feishu.record(recordId);
    const countryValue = body.country || fieldText(record.fields?.['国家']);
    const country = markets.find(
      (m) => normalizeCountry(m.value) === normalizeCountry(countryValue),
    )?.value;
    if (!country)
      throw Object.assign(new Error('请在研究评级表单中选择已支持的企业国家'), { status: 400 });
    const product =
      body.product ||
      fieldText(fieldValue(record.fields, '相关产品'))
        .split('\n')
        .filter(Boolean)
        .slice(0, 4)
        .join(', ');
    if (!product) throw Object.assign(new Error('请填写本次评价的具体产品'), { status: 400 });
    const input = validateTarget({
      country,
      region: '',
      product,
      audience: 'BC',
      customer_type: '',
      customer_profile: 'all',
      acquisition_channel: 'tavily_web',
    });
    const source_url = customerWebsite(record);
    return this.research(input, {
      source_url,
      operation_id: operationId,
      target_record_id: recordId,
    });
  }
  assessmentHistory(recordId) {
    const assessment = this.assessments.latest(recordId);
    // Keep the established read route compatible while returning only current data.
    return { assessment, assessments: assessment ? [assessment] : [] };
  }
  ensureConfigured() {
    const config = acquisitionConfig(this.env);
    if (!config.nativeReady)
      throw Object.assign(new Error('后端直连配置缺失：' + config.missing.join('、')), {
        status: 503,
      });
  }
  async discover(input, search, seen = []) {
    input = { ...input, ...validateTarget(input) };
    if (search?.country && !input.market_countries.includes(search.country))
      throw Object.assign(new Error('搜索国家不在当前支持的市场范围内'), { status: 400 });
    this.ensureConfigured();
    if (search.source_kind === 'customs') return this.discoverShipments(input, search, seen);
    const records = await this.feishu.records();
    const known = records.map((r) => domainKey(customerWebsite(r))).filter(Boolean);
    const excluded = [...new Set([...known, ...seen])];
    const data = await this.providers.web.search({
      query: search.query.slice(0, 395),
      search_depth: 'basic',
      max_results: 20,
      include_answer: false,
      include_raw_content: false,
      auto_parameters: false,
      exclude_domains: excluded.slice(-150),
    });
    return {
      ...selectWebsiteCandidates(data.results, excluded),
      stage: 'select',
      source: this.providers.web.provider,
      usage: data.usage,
    };
  }
  async discoverShipments(input, search, seen) {
    this.customs ||= new CustomsDiscovery({ env: this.env, fetchImpl: this.fetch });
    const found = await this.customs.discover(input, search);
    const candidates = [],
      reviews = [];
    const webUsage = webUsageCounter('search');
    const records = await this.feishu.records();
    for (const buyer of found.buyers) {
      // A provider URL is only a candidate; never skip website verification.
      let sites = buyer.source_url
        ? selectWebsiteCandidates(
            [{ url: buyer.source_url }].filter((r) => shipmentWebsiteNameScore(r, buyer.name)),
            [],
            1,
          ).candidates
        : [];
      if (!sites.length) {
        webUsage.start();
        const result = await this.providers.web.search({
          query: [
            '"' + buyer.name.replace(/["\r\n]/g, ' ') + '"',
            buyer.address || '',
            input.country || search.country || '',
            'official website',
          ]
            .join(' ')
            .slice(0, 395),
          search_depth: 'basic',
          max_results: 5,
          include_answer: false,
          include_raw_content: false,
          auto_parameters: false,
        });
        webUsage.observe(result);
        sites = selectWebsiteCandidates(
          result.results
            .map((r) => ({ result: r, score: shipmentWebsiteNameScore(r, buyer.name) }))
            .filter((entry) => entry.score)
            .sort((a, b) => b.score - a.score)
            .map((entry) => entry.result),
          [],
          3,
        ).candidates;
      }
      if (!sites.length) {
        reviews.push({
          name: buyer.name,
          buyer_id: buyer.id,
          source_kind: 'customs',
          reason: '找到相关货运记录，尚未找到名称可对应海关买方的独立官网，待人工核实',
          customs_evidence: buyer,
        });
        continue;
      }
      // Search evidence is a locator only. Retain bounded alternatives so an
      // incorrect first result cannot consume the buyer without a second try.
      // This key groups retries, not independently verified company identities.
      const buyerKey = JSON.stringify([
        buyer.provider || buyer.records?.[0]?.provider || this.customs.provider?.id || 'customs',
        buyer.id || buyer.name,
        buyer.id ? '' : buyer.address || '',
      ]);
      for (const site of sites) {
        const priorResearch = this.store.websiteResearch(site.source_url);
        const evidence = this.store.saveCustomsEvidence(
          site.source_url,
          buyer,
          priorResearch ? matchShipmentBuyer(buyer, priorResearch, site.source_url) : null,
          priorResearch?.record_id,
        );
        const matching = recordsForDomain(records, site.domain);
        candidates.push({
          ...site,
          source_kind: 'customs',
          customs_buyer_key: buyerKey,
          customs_evidence: evidence,
          ...(matching.length === 1 ? { target_record_id: matching[0].record_id } : {}),
        });
      }
    }
    return {
      candidates,
      review_candidates: reviews,
      usage: { ...found.usage, ...webUsage.snapshot() },
      next_search: found.next_search,
      source: 'customs',
      stage: 'select',
      skipped_existing: [],
    };
  }
  async collect(sourceUrl) {
    const initial = websiteUrl(sourceUrl);
    if (!initial) throw new Error('官网地址无效，仅接受公网 HTTPS 企业网站');
    const domain = domainKey(initial.href),
      pages = [],
      failures = [];
    const queue = [initial.href],
      planned = new Set(queue),
      visited = new Set();
    const webUsage = webUsageCounter('extract');
    const enqueue = (url, content) => {
      for (const next of planWebsitePages(url, content)) {
        if (planned.size >= 5) break;
        if (!planned.has(next)) {
          planned.add(next);
          queue.push(next);
        }
      }
    };
    // Discover contact/about/service links from complete HTML before limiting AI input.
    const readPlanned = async () => {
      while (queue.length && visited.size < 5) {
        const original = queue.shift();
        if (visited.has(original)) continue;
        visited.add(original);
        let url = websiteUrl(original),
          content = '';
        try {
          for (let hop = 0; hop < 4; hop++) {
            const response = await this.readPage(url, AbortSignal.timeout(12000));
            if (response.redirect) {
              const next = websiteUrl(response.redirect, url);
              if (!next || domainKey(next.href) !== domain) throw new Error('官网跳转到其他域名');
              url = next;
            } else {
              content = response.html || '';
              break;
            }
          }
          if (!content || !researchPageText(content)) throw new Error('官网未返回有效正文');
          pages.push({ url: url.href, content });
          enqueue(url.href, content);
        } catch {
          failures.push(original);
        }
      }
    };
    await readPlanned();
    // Supplement failed or dynamically rendered pages, bounded to the same five URLs.
    const extractedUrls = new Set();
    for (let batch = 0; batch < 2; batch++) {
      const urls = failures.filter((url) => !extractedUrls.has(url));
      if (!urls.length && pages.length) break;
      const selected = urls.length ? urls : [initial.href];
      for (const url of selected) extractedUrls.add(url);
      let extracted;
      try {
        webUsage.start();
        extracted = await this.providers.web.extract({
          urls: [...new Set(selected)].slice(0, 5),
          extract_depth: 'basic',
          format: 'markdown',
        });
        webUsage.observe(extracted);
      } catch (error) {
        if (!pages.length) throw error;
        extracted = { results: [] };
      }
      for (const p of extracted.results) {
        if (domainKey(p.url) !== domain || !planned.has(p.url) || !p.raw_content) continue;
        pages.push({ url: p.url, content: p.raw_content });
        enqueue(p.url, p.raw_content);
      }
      await readPlanned();
    }
    const researchPages = new Map();
    for (const page of pages) {
      const text = researchPageText(page.content, page.content.length);
      if (text && !researchPages.has(page.url))
        researchPages.set(page.url, { source_url: page.url, text });
    }
    if (!researchPages.size) throw new Error('官网页面均未取得正文，未调用模型或写入');
    const bounded = boundedResearchPages([...researchPages.values()]);
    return {
      source_url: initial.href,
      research_pages: bounded.pages,
      page_text: bounded.pages.map((p) => p.text).join('\n'),
      input_stats: bounded.stats,
      web_usage: webUsage.snapshot(),
      website_metadata: combineWebsiteEvidence(pages),
      checked_urls: [...researchPages.keys()],
    };
  }
  output(operation, { research = {}, row, reason, outcome, skipped = [] } = {}) {
    const inserted = row?.result === 'inserted' ? 1 : 0;
    const updated = row?.result === 'updated' ? 1 : 0;
    operation.handoff = calculateHandoffReadiness({
      research,
      assessment: operation.assessment,
      contacts: operation.evidence?.contacts || [],
      researchPages: operation.research_pages || [],
    });
    return {
      outcome: outcome || (inserted || updated ? 'completed' : 'failed'),
      execution_id: 'native-' + operation.id,
      新增: inserted,
      更新: updated,
      失败: row?.result === 'failed' ? 1 : 0,
      待人工查重: row?.result === 'manual_review' ? 1 : 0,
      stage: operation.stage,
      reason: reason || research.reason || '企业未达到入库条件',
      skipped_existing_count: skipped.length,
      skipped_existing: skipped,
      research,
      handoff: operation.handoff,
      assessment: operation.assessment
        ? {
            id: operation.assessment.id,
            score: operation.assessment.score,
            grade: operation.assessment.grade,
            status: operation.assessment.status,
            complete: operation.assessment.complete,
            ruleVersion: operation.assessment.ruleVersion,
          }
        : null,
      checked_urls: research.checked_urls || [],
      ...(operation.research_usage ? { research_usage: operation.research_usage } : {}),
      明细: row ? [row] : [],
    };
  }
  async research(input, item) {
    // Also validate restored tasks and callers that bypass HTTP validation.
    input = { ...input, ...validateTarget(input) };
    this.ensureConfigured();
    const id = item.operation_id;
    if (typeof id !== 'string' || !/^[\w-]{8,150}$/.test(id)) throw conflict('研究操作编号无效');
    const { operation: op, existing } = this.store.begin(id, { input, item });
    if (existing) {
      const settled = await this.status(id);
      if (settled.settled) return settled.output;
      throw conflict('该企业操作尚待确认，未重复研究或写入');
    }
    op.research_usage = { model_calls: 0, cache_hits: 0, input_chars: 0 };
    this.active.add(id);
    try {
      const domain = domainKey(item.source_url);
      if (!websiteScope(item.source_url) || !domain) throw new Error('企业网址无效');
      let matching = recordsForDomain(await this.feishu.records(), domain);
      if (
        matching.length > 1 ||
        (item.target_record_id &&
          (matching.length !== 1 || matching[0].record_id !== item.target_record_id))
      ) {
        const output = this.output(op, {
          outcome: 'review',
          reason: '官网对应记录不唯一或指定记录不匹配',
          row: { result: 'manual_review', source_url: item.source_url },
        });
        this.store.complete(op, output);
        return output;
      }
      if (!companyWebsiteSourceUrl(item.source_url)) {
        const reason =
          '现有来源为第三方贸易/平台档案或其他非官网页面，不是企业官网；尚未核实企业独立官网，本轮不据此判定高等级';
        if (item.target_record_id)
          return await this.persistIncompleteAssessment(op, input, item, reason, []);
        const output = this.output(op, {
          outcome: 'review',
          reason,
          row: { result: 'manual_review', source_url: item.source_url },
        });
        this.store.complete(op, output);
        return output;
      }
      if (matching.length && !item.target_record_id) {
        const output = this.output(op, {
          outcome: 'no_new_candidates',
          reason: '该企业已在飞书收录',
          skipped: [{ domain, url: item.source_url }],
        });
        this.store.complete(op, output);
        return output;
      }
      op.stage = 'extract';
      this.store.save(op);
      const page = await this.collect(item.source_url);
      op.web_usage = page.web_usage;
      op.research_usage.omitted_pages = page.input_stats?.omittedPages || 0;
      op.research_usage.truncated_pages = page.input_stats?.truncatedPages || 0;
      op.stage = 'research';
      op.checked_urls = page.checked_urls;
      op.research_pages = page.research_pages;
      op.evidence = page.website_metadata;
      this.store.save(op);
      if (
        thirdPartyCompanySource({
          url: item.source_url,
          title: item.source_title,
          text: page.page_text,
        })
      ) {
        const reason =
          '采集正文表明当前页面为第三方贸易档案或B2B平台商家资料，尚未取得企业独立官网';
        if (item.target_record_id)
          return await this.persistIncompleteAssessment(op, input, item, reason, page.checked_urls);
        const output = this.output(op, {
          outcome: 'review',
          reason,
          research: {
            source_url: item.source_url,
            checked_urls: page.checked_urls,
            review_required: true,
          },
        });
        this.store.complete(op, output);
        return output;
      }
      // Cheap keyword screen before the paid model call: keep only pages that
      // actually mention the target products or the window-shading industry.
      const relevance = pageRelevance(page.page_text, input);
      if (!relevance.relevant) {
        if (item.target_record_id)
          return await this.persistIncompleteAssessment(
            op,
            input,
            item,
            '本轮官网正文未取得目标品类的评分依据',
            page.checked_urls,
          );
        const research = {
          ok: false,
          stage: 'done',
          reason:
            input.query_mode === 'auto'
              ? '本轮官网正文未取得目标品类依据，待补充核实'
              : '官网内容与目标产品不相关，已预筛排除',
          source_url: item.source_url,
          product_match: 'not_matched',
          relevance,
          checked_urls: page.checked_urls,
          review_required: input.query_mode === 'auto',
        };
        op.research = research;
        this.store.save(op);
        const output = this.output(op, {
          research,
          reason: research.reason,
          ...(research.review_required ? { outcome: 'review' } : {}),
        });
        this.store.complete(op, output);
        return output;
      }
      op.research_usage.input_chars =
        page.input_stats?.inputChars ??
        page.research_pages.reduce((sum, p) => sum + p.text.length, 0);
      const prompt = companyResearchRequest(page, input);
      const request = {
        messages: prompt.messages,
        schema: companyResearchSchema,
      };
      const cacheKey = researchCacheKey({
        ...request,
        identity: this.providers.model.cacheIdentity,
      });
      let response, parsed;
      if (cacheKey && typeof this.store.modelResponse === 'function') {
        try {
          response = this.store.modelResponse(cacheKey);
          // Replay through today's evidence and policy checks, never cached
          // eligibility, scores, customer writes or a prior operation result.
          if (response) parsed = parseCompanyResearch(response, page, input);
        } catch {
          // Corrupt/obsolete cache data is not research evidence. A fresh
          // request may replace it; cache failure must not block valid research.
          response = undefined;
        }
      }
      if (parsed) {
        op.research_usage.cache_hits = 1;
        op.research_usage.input_tokens = 0;
        op.research_usage.output_tokens = 0;
      } else {
        // Count attempts before the network call, including an unknown remote
        // outcome; this is not a claim that the provider charged a given amount.
        op.research_usage.model_calls = 1;
        this.store.save(op);
        response = await this.providers.model.research(request);
        op.research_response = response;
        const usage = response.usage || response.body?.usage || {};
        for (const [key, value] of [
          ['input_tokens', usage.input_tokens ?? usage.prompt_tokens],
          ['output_tokens', usage.output_tokens ?? usage.completion_tokens],
        ])
          if (Number.isSafeInteger(value) && value >= 0) op.research_usage[key] = value;
        this.store.save(op);
        parsed = parseCompanyResearch(response, page, input);
        if (cacheKey && typeof this.store.saveModelResponse === 'function') {
          try {
            this.store.saveModelResponse(cacheKey, response);
          } catch {
            // Reuse is an optimization, not a prerequisite for completing the
            // current validated result or a reason to repeat its model call.
            op.research_usage.cache_unavailable = true;
          }
        }
      }
      op.research_response = response;
      this.store.save(op);
      const research = {
        ...parsed,
        checked_urls: page.checked_urls,
      };
      op.research = research;
      if (item.source_kind === 'customs') {
        const associations = this.store
          .customsEvidence(item.source_url)
          .map((buyer) =>
            this.store.saveCustomsEvidence(
              item.source_url,
              buyer,
              matchShipmentBuyer(buyer, research, item.source_url),
              item.target_record_id,
            ),
          );
        research.customs_evidence = associations;
        const matchingBuyer = associations.some(
          (b) =>
            b.match.status !== 'conflict' &&
            (!item.customs_evidence ||
              (b.id === item.customs_evidence.id &&
                b.product_family === item.customs_evidence.product_family)),
        );
        if (!matchingBuyer) {
          const output = this.output(op, {
            research,
            outcome: 'review',
            reason: '海关买方与官网经营主体不一致，待人工消歧',
          });
          this.store.complete(op, output);
          return output;
        }
      }
      op.evidence = page.website_metadata;
      op.research_pages = page.research_pages;
      op.usage = op.research_usage.cache_hits ? undefined : response.usage;
      this.store.save(op);
      const identityVerified =
        research.company_identity?.name &&
        ['legal_name_self_reported', 'website_name_only'].includes(
          research.company_identity.status,
        ) &&
        research.company_identity.status !== 'identity_conflict';
      const hardMismatch =
        research.entity_type === 'individual' ||
        research.product_match === 'not_matched' ||
        research.country_match === 'not_matched' ||
        research.audience_match === 'not_matched' ||
        research.customer_type_match === 'not_matched' ||
        research.profile_match === 'not_matched' ||
        research.required_match === 'not_matched' ||
        research.eligibility?.status === 'rejected';
      const broadAdmissionReady =
        research.entity_type === 'business' &&
        Boolean(research.company_name) &&
        Boolean(identityVerified) &&
        research.product_match === 'matched' &&
        research.required_match !== 'not_matched' &&
        !hardMismatch;
      if (!broadAdmissionReady && !item.target_record_id) {
        const output = this.output(op, {
          research,
          outcome: hardMismatch ? 'rejected' : 'review',
          reason:
            research.reason ||
            (hardMismatch
              ? '官网主体与目标市场或产品范围不匹配'
              : '官网主体或窗饰产品关联尚未核实'),
        });
        this.store.complete(op, output);
        return output;
      }
      if (
        item.target_record_id &&
        (!research.company_name || research.company_identity?.status === 'identity_conflict')
      )
        return await this.persistIncompleteAssessment(
          op,
          input,
          item,
          '当前官网未取得可验证的企业名称，主体身份待核实',
          page.checked_urls,
          research,
        );
      op.stage = 'prepare';
      this.store.save(op);
      // Recheck identity immediately before writing, including all record pages.
      matching = recordsForDomain(await this.feishu.records(), domain);
      if (
        matching.length > 1 ||
        (item.target_record_id &&
          (matching.length !== 1 || matching[0].record_id !== item.target_record_id))
      ) {
        const output = this.output(op, {
          research,
          outcome: 'review',
          reason: '写入前身份核对失败',
          row: { result: 'manual_review', source_url: item.source_url },
        });
        this.store.complete(op, output);
        return output;
      }
      if (matching.length && !item.target_record_id) {
        const output = this.output(op, {
          research,
          outcome: 'no_new_candidates',
          skipped: [{ domain, url: item.source_url }],
          reason: '研究期间已被其他任务收录',
        });
        this.store.complete(op, output);
        return output;
      }
      const old = matching[0];
      let raw = {
        ...researchFields(
          research,
          page.website_metadata,
          canonicalCustomerFields(old?.fields || {}),
          page.research_pages,
        ),
        来源链接: customerSource(old?.fields || {}) || item.source_url,
        企业官网: item.source_url,
        最近研究时间: Date.now(),
      };
      if (old) {
        raw = mergeResearchFields(old.fields, raw);
        const corrections = this.store.contactCorrections(old.record_id);
        for (const [key, name] of Object.entries({
          contact: '联系人',
          email: '邮箱',
          phone: '电话',
        }))
          if (typeof corrections[key]?.value === 'string') raw[name] = corrections[key].value;
      } else
        Object.assign(raw, {
          customer_id: 'web_' + domain,
          首次发现时间: Date.now(),
          开发状态: '待开发',
        });
      if (item.phone_only) {
        if (!old) throw new Error('仅更新电话需要明确的已有记录');
        raw = raw['电话'] ? { 电话: raw['电话'] } : {};
      }
      const definitions = await this.feishu.fields();
      if (
        !item.phone_only &&
        definitions.some(
          (f) => f.field_name === resolveCustomerField(definitions, '用户评级') && f.type === 3,
        )
      ) {
        op.assessment = assessCompany({
          research: old
            ? applySupplementsToResearch(
                research,
                this.supplements.confirmations(old.record_id, item.source_url),
              )
            : research,
          target: input,
          id: assessmentId(this.assessments.scope, op.id),
        });
        if (old)
          resolveConfirmedPending(
            op.assessment,
            this.supplements.confirmations(old.record_id, item.source_url),
          );
        if (definitions.some((f) => f.field_name === '评级依据' && f.type === 1))
          raw['评级依据'] = op.assessment.reason;
        // The initial priority uses verified business facts; missing research is retained separately.
        raw['用户评级'] = assessmentRating(op.assessment);
        Object.assign(raw, assessmentSummaryFields(op.assessment));
      }
      const fields = item.phone_only
        ? Object.fromEntries(
            Object.entries(raw).filter(([key]) =>
              definitions.some((f) => f.field_name === key && f.type === 1),
            ),
          )
        : encodeResearchFields(raw, definitions);
      if (op.assessment) {
        fields[resolveCustomerField(definitions, '用户评级')] = assessmentRating(op.assessment);
        for (const [key, value] of Object.entries(assessmentSummaryFields(op.assessment)))
          if (definitions.some((field) => field.field_name === key && field.type === 1))
            fields[key] = value || null;
      }
      if (!Object.keys(fields).length) throw new Error('没有可更新字段');
      // Persist intent before the remote side effect. Never auto-repeat an uncertain write.
      op.stage = 'persist';
      op.action = old ? 'update' : 'insert';
      op.recordId = old?.record_id;
      op.fields = fields;
      op.source_url = item.source_url;
      return await this.writePreparedAssessment(op);
    } catch (error) {
      if (['persist', 'assessment'].includes(op.stage)) {
        op.state = 'uncertain';
        this.store.save(op);
        throw conflict(
          op.stage === 'assessment'
            ? '客户资料已更新，最新评估保存待核对；勿重复研究'
            : '飞书写入结果待核对，已暂停且未自动重试',
        );
      }
      const modelResponse = op.research_response?.body || op.research_response;
      const modelFailure =
        op.stage !== 'research'
          ? null
          : modelResponse?.status === 'incomplete'
            ? modelResponse.incomplete_details?.reason === 'max_output_tokens'
              ? '模型输出达到额度上限，未取得完整可验证JSON；本轮未写入客户资料'
              : '模型研究未完整返回，未取得完整可验证JSON；本轮未写入客户资料'
            : modelResponse
              ? '模型研究结果未通过完整JSON或证据校验；本轮未写入客户资料'
              : null;
      if (item.target_record_id && ['extract', 'research'].includes(op.stage))
        return await this.persistIncompleteAssessment(
          op,
          input,
          item,
          modelFailure ||
            (error.status ? error.message : '官网采集或研究未完成，本轮未取得足够评分依据'),
          op.checked_urls || [],
        );
      const output = this.output(op, {
        research: op.research || {},
        reason: modelFailure || (error.status ? error.message : '官网采集或研究失败，未写入飞书'),
      });
      this.store.complete(op, output);
      return output;
    } finally {
      this.active.delete(id);
    }
  }
  async persistIncompleteAssessment(op, input, item, reason, checkedUrls, partialResearch = {}) {
    const customer = await this.feishu.record(item.target_record_id);
    if (
      !domainKey(item.source_url) ||
      domainKey(customerWebsite(customer)) !== domainKey(item.source_url)
    )
      throw conflict('未完成研究的客户主体不一致，停止写入');
    op.research = {
      ...partialResearch,
      ok: false,
      source_url: item.source_url,
      company_name: null,
      entity_type: 'unknown',
      assessment_opportunities: partialResearch.assessment_opportunities || [],
      facts: partialResearch.facts || [],
      checked_urls: checkedUrls,
      incomplete_reason: reason,
    };
    const previous = this.assessments.latest(item.target_record_id);
    const retainPriorEvidence =
      !op.research.assessment_opportunities.length &&
      previous &&
      domainKey(previous.website) === domainKey(item.source_url) &&
      this.supplements
        .confirmations(item.target_record_id, item.source_url)
        .some((c) => c.category === 'assessment');
    if (retainPriorEvidence)
      Object.assign(op.research, {
        company_name: previous.companyName,
        entity_type: previous.entityType,
        assessment_opportunities: previous.opportunities,
        facts: previous.facts,
        ...(previous.supplyOpportunity
          ? {
              product_relation: {
                kind: 'potential_input',
                basis_product: previous.supplyOpportunity.basisProduct,
              },
            }
          : {}),
        incomplete_reason: '本轮官网研究未完成，沿用此前官网证据与人工确认资料。' + reason,
      });
    op.assessment = assessCompany({
      research: applySupplementsToResearch(
        op.research,
        this.supplements.confirmations(item.target_record_id, item.source_url),
      ),
      target: input,
      id: assessmentId(this.assessments.scope, op.id),
    });
    resolveConfirmedPending(
      op.assessment,
      this.supplements.confirmations(item.target_record_id, item.source_url),
    );
    op.action = 'update';
    op.recordId = item.target_record_id;
    op.source_url = item.source_url;
    op.fields = {
      用户评级: assessmentRating(op.assessment),
      ...(!retainPriorEvidence ? { 最近研究时间: Date.parse(op.assessment.evaluatedAt) } : {}),
    };
    const fields = await this.feishu.fields();
    for (const [key, value] of Object.entries(assessmentSummaryFields(op.assessment)))
      if (fields.some((field) => field.field_name === key && field.type === 1))
        op.fields[key] = value || null;
    if (fields.some((f) => f.field_name === '评级依据' && f.type === 1))
      op.fields['评级依据'] = op.assessment.reason;
    return this.writePreparedAssessment(op);
  }
  async writePreparedAssessment(op) {
    op.stage = 'persist';
    this.store.save(op);
    try {
      const written = await this.feishu.write(op.action, op.fields, op.recordId, op.clientToken);
      op.recordId = written.record_id;
      this.store.save(op);
      if (!(await this.verify(op))) throw new Error('飞书写入后读回不一致');
      return await this.finishWritten(op);
    } catch (error) {
      op.state = 'uncertain';
      this.store.save(op);
      throw conflict(
        op.stage === 'assessment'
          ? '客户资料已更新，最新评估保存待核对；勿重复研究'
          : '飞书写入结果待核对，未自动重复写入',
      );
    }
  }
  async verify(op) {
    if (!op.recordId) return false;
    const record = await this.feishu.record(op.recordId);
    if (domainKey(customerWebsite(record)) !== domainKey(op.source_url)) return false;
    return Object.entries(op.fields).every(([key, value]) => {
      if (['公司名称', '客户名称'].includes(key))
        return (
          fieldText(record.fields?.['公司名称'] || record.fields?.['客户名称']) === fieldText(value)
        );
      if (value === null) return fieldText(fieldValue(record.fields, key)) === '';
      const expected = typeof value === 'object' ? value.link || value.text : value;
      if (typeof expected === 'number') return Number(fieldValue(record.fields, key)) === expected;
      return fieldText(fieldValue(record.fields, key)) === expected;
    });
  }
  async finishWritten(op) {
    op.recordVerifiedAt ||= new Date().toISOString();
    if (op.research?.company_name && op.recordId) {
      this.store.saveWebsiteResearch(op.source_url, op.research, op.recordId);
      for (const buyer of this.store.customsEvidence(op.source_url))
        this.store.saveCustomsEvidence(
          op.source_url,
          buyer,
          matchShipmentBuyer(buyer, op.research, op.source_url),
          op.recordId,
        );
    }
    if (op.research?.company_identity && op.recordId) {
      const name = op.fields?.['公司名称'] || op.fields?.['客户名称'];
      if (name)
        this.store.saveCompanyIdentity(
          op.recordId,
          op.source_url,
          name,
          op.research.company_identity,
        );
    }
    if (op.assessment) {
      op.stage = 'assessment';
      this.store.save(op);
      this.assessments.save(op.assessment, await this.feishu.record(op.recordId));
    }
    const output = this.output(op, {
      research: op.research,
      row: {
        result: op.action === 'insert' ? 'inserted' : 'updated',
        source_url: op.source_url,
        record_id: op.recordId,
      },
      reason: op.assessment
        ? op.assessment.incompleteReason
          ? '研究资料不足，已保存待核实评级与最新依据并核对'
          : '企业资料与当前评级已读回，最新评估依据已保存'
        : op.action === 'insert'
          ? '飞书新增并读回核验成功'
          : '飞书更新并读回核验成功',
    });
    this.store.complete(op, output);
    return output;
  }
  async status(id) {
    const op = this.store.get(id);
    if (!op) return { settled: false, reason: '操作记录不存在，未自动重放' };
    if (op.state === 'completed') return { settled: true, output: op.output };
    if (this.active.has(id)) return { settled: false, reason: '仍在执行' };
    if (op.child) {
      const result = await this.status(op.child);
      if (result.settled) this.store.complete(op, result.output);
      return result;
    }
    if (['persist', 'assessment'].includes(op.stage)) {
      try {
        if (op.stage === 'assessment' && op.recordVerifiedAt)
          return { settled: true, output: await this.finishWritten(op) };
        if (!op.recordId && op.action === 'insert') {
          const candidates = recordsForDomain(
            await this.feishu.records(),
            domainKey(op.source_url),
          );
          if (candidates.length === 1) {
            op.recordId = candidates[0].record_id;
            this.store.save(op);
          }
        }
        if (await this.verify(op)) return { settled: true, output: await this.finishWritten(op) };
      } catch {
        /* Preserve uncertainty when the read-back service is unavailable. */
      }
      return { settled: false, reason: '写入尚未确认，未自动重试' };
    }
    const output = this.output(op, { reason: '服务在写入前中断；本次企业未入库' });
    this.store.complete(op, output);
    return { settled: true, output };
  }
  async run(input, id = randomUUID()) {
    this.ensureConfigured();
    const { operation: op, existing } = this.store.begin(id, { input, mode: 'run' });
    if (existing) {
      const result = await this.status(id);
      if (result.settled) return result.output;
      throw conflict('该单次操作尚待核对，未重复执行');
    }
    this.active.add(id);
    try {
      const found = await this.discover(input, {
        ...searchPlan(input)[0],
        run_id: id,
        remaining_budget: input.customs_record_budget || 300,
      });
      if (!found.candidates.length) {
        const output = this.output(op, {
          outcome: found.review_candidates?.length ? 'review' : 'no_new_candidates',
          skipped: found.skipped_existing,
          research: { review_candidates: found.review_candidates || [] },
          reason: found.review_candidates?.length
            ? '相关货运买方尚未取得可核实官网，已保留待核实项'
            : '本次搜索没有新的独立企业官网',
        });
        this.store.complete(op, output);
        return output;
      }
      op.child = id + '-research';
      this.store.save(op);
      const output = await this.research(input, { ...found.candidates[0], operation_id: op.child });
      this.store.complete(op, output);
      return output;
    } finally {
      this.active.delete(id);
    }
  }
  close() {
    this.customs?.close?.();
    this.assessments.close();
    this.supplements.close();
    this.store.close();
  }
}
