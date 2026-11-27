import { createHash, randomUUID } from 'node:crypto';
import { acquisitionConfig } from './acquisition-config.mjs';
import { addModelTokens, createResearchProviders } from './research-providers.mjs';
import { createMapsDiscovery } from './maps-discovery.mjs';
import { canonicalJson, researchCacheKey } from './research-reuse.mjs';
import {
  acquisitionIdentityVersion,
  acquisitionUrl,
  identityIntegrityCode,
  subjectName,
  verifiedRegistration,
} from './acquisition-subject.mjs';
import { activitySources, verifyCompanyActivity } from './activity-verification.mjs';
import { exclusionConditionsKey } from './exclusion-conditions.mjs';
import { boundedResearchPages } from './research-input.mjs';
import { compactResearchText, RESEARCH_GAP } from './research-text.mjs';
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
import {
  businessDirectoryEvidence,
  domainKey,
  thirdPartyCompanySource,
  thirdPartySupplierProfile,
} from './website-identity.mjs';
import { calculateHandoffReadiness } from './handoff-readiness.mjs';
import { readPublicHtml, websiteRedirectUrl, websiteUrl } from './branding.mjs';
import {
  planWebsitePages,
  combineWebsiteEvidence,
  websitePagePriority,
  websiteScope,
} from './website-metadata.mjs';
import { researchPageText, hasUsableResearchText } from './research-pages.mjs';
import { collectScraplingPage } from './scrapling-collector.mjs';
import {
  acquisitionEvidenceVersion,
  selectAcquisitionEvidence,
} from './acquisition-evidence-selection.mjs';
import {
  companyResearchRequest,
  companyResearchSchema,
  parseCompanyResearch,
  researchFields,
  mergeResearchFields,
  websiteAdmissionResearchSchema,
} from './company-research.mjs';
import { websiteAdmissionVersion } from './customer-eligibility.mjs';
import { pageRelevance } from './relevance.mjs';
import { validateTarget } from './search-target.mjs';
import {
  acquisitionMarkets,
  countryFor,
  WORLDWIDE_COUNTRY,
} from '../src/domain/country-catalog.ts';
import { unifiedExecutionVersion } from './search-plan.mjs';
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
  encodeCustomerFields,
} from './customer-fields.mjs';

const conflict = (message) => Object.assign(new Error(message), { status: 409 });
const interrupted = () =>
  Object.assign(new Error('执行已在安全边界暂停'), { code: 'ACQUISITION_INTERRUPTED' });
const paidUnknown = () =>
  Object.assign(new Error('付费请求结果待供应商核对'), { code: 'ACQUISITION_PAID_UNKNOWN' });
const paidFailed = () =>
  Object.assign(new Error('已确认供应商请求失败'), { code: 'ACQUISITION_PAID_FAILED' });
const recoverySignal = (error) =>
  ['ACQUISITION_INTERRUPTED', 'ACQUISITION_PAID_UNKNOWN', identityIntegrityCode].includes(
    error.code,
  );
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
  'fginsight.com',
];
// Apply the same source qualification to discovery and queued/direct research.
// A third-party company profile is not the company's independently verified site.
function companyWebsiteSource(value, evidence = {}) {
  const url = websiteUrl(value);
  if (!url) return { url: null, reason: '网址无效或不安全' };
  if (thirdPartySupplierProfile({ ...evidence, url: url.href }))
    return { url: null, profileUrl: url, reason: '第三方供应商档案' };
  const domain = domainKey(url.href);
  if (
    blockedHosts.test(url.hostname) ||
    thirdPartyCompanySource({ ...evidence, url: url.href }) ||
    /directory|findglocal|word-of-mouth|superpages/i.test(url.hostname)
  )
    return { url: null, reason: '第三方平台或目录' };
  if (
    /gazette|herald|tribune|chronicle|newspaper|news\.co/i.test(url.hostname) ||
    blockedMedia.some((host) => domain === host || domain.endsWith('.' + host))
  )
    return { url: null, reason: '新闻媒体' };
  if (/\.(?:pdf|docx?|xlsx?|pptx?|zip|rar)$/i.test(url.pathname))
    return { url: null, reason: '非网页文件' };
  if (
    /\/(jobs?|careers?|vacanc[^/]*|employment|wiki|directory|listings?)(\/|$)/i.test(url.pathname)
  )
    return { url: null, reason: '招聘或目录页面' };
  const description = `${url.pathname} ${evidence.title || ''}`;
  if (
    /(?:^|\.)gov(?:\.[a-z]{2})?$/.test(url.hostname) &&
    /safety|regulat(?:ion|ory)|statistics?|census|classification|naics|guidance/i.test(
      description,
    ) &&
    !/procurement|tender|\brfp\b|solicitation|supplier registration/i.test(description)
  )
    return { url: null, reason: '监管或统计资料' };
  return { url };
}

function companyWebsiteSourceUrl(value, evidence = {}) {
  return companyWebsiteSource(value, evidence).url;
}

export function selectWebsiteCandidates(
  results,
  knownDomains = [],
  limit = 20,
  byUrl = false,
  retainSupplierProfiles = false,
) {
  const known = new Set(knownDomains),
    seen = new Set(),
    candidates = [],
    skipped = [],
    filtered = [];
  for (const result of results) {
    const source = companyWebsiteSource(result?.url, {
      title: result?.title,
      text: [result?.content, result?.raw_content].filter(Boolean).join(' '),
    });
    const url = source.url || (retainSupplierProfiles ? source.profileUrl : null);
    if (!url) {
      filtered.push({ url: result?.url || '', reason: source.reason });
      continue;
    }
    const domain = domainKey(url.href);
    const candidateKey = byUrl ? acquisitionUrl(url.href) : domain;
    if (known.has(candidateKey)) {
      skipped.push({ domain, url: url.href });
      continue;
    }
    if (seen.has(candidateKey)) continue;
    seen.add(candidateKey);
    candidates.push({
      source_url: url.href,
      source_title: result.title || '',
      source_kind: 'website',
      domain,
      ...(source.profileUrl ? { third_party_profile_url: url.href } : {}),
    });
    if (candidates.length >= limit) break;
  }
  return {
    candidates,
    skipped_existing: skipped,
    skipped_existing_count: skipped.length,
    filtered_sources: filtered,
  };
}

function compareMapDiscovery(selected, lookup, context) {
  const { maps, places } = lookup;
  if (!places.length && !context.mapOnlyUrls.size) return { ...selected, maps };
  const candidates = new Map(selected.candidates.map((c) => [acquisitionUrl(c.source_url), c]));
  const discovered_at = new Date().toISOString();
  const common = { job_id: context.jobId, discovered_at };
  const observations = new Map();
  const review_candidates = [];
  for (const candidate of candidates.values()) {
    candidate.discovery_sources = [{ ...common, kind: 'web', source_url: candidate.source_url }];
  }
  for (const { id, name, website } of places) {
    const sourceUrl = name && companyWebsiteSourceUrl(website);
    const source = {
      ...common,
      kind: 'maps',
      provider: maps.provider,
      reference: id,
      ...(name ? { mentioned_company: name } : {}),
      ...(sourceUrl ? { source_url: sourceUrl.href } : {}),
    };
    const reference = `${maps.provider}:${id}`;
    const previous = observations.get(reference) || context.references.get(reference);
    if (previous) {
      if (
        (source.source_url &&
          previous.source_url &&
          acquisitionUrl(source.source_url) !== acquisitionUrl(previous.source_url)) ||
        (name &&
          previous.mentioned_company &&
          subjectName(name) !== subjectName(previous.mentioned_company))
      ) {
        return {
          ...selected,
          maps: { ...maps, status: 'paused', reason: 'conflicting_reference' },
        };
      }
      if (!source.source_url || previous.source_url) continue;
    }
    observations.set(reference, source);
  }
  for (const source of observations.values()) {
    if (!source.source_url) {
      review_candidates.push({
        source_kind: 'maps',
        name: source.mentioned_company,
        reason: '地图地点尚未定位可独立核验的企业官网',
        discovery_sources: [source],
      });
      continue;
    }
    const key = acquisitionUrl(source.source_url);
    if (!candidates.has(key)) {
      candidates.set(key, {
        source_url: source.source_url,
        source_kind: 'maps',
        discovery_sources: [],
      });
    }
    candidates.get(key).discovery_sources.push(source);
    maps.resolved++;
  }
  return { ...selected, maps, candidates: [...candidates.values()], review_candidates };
}

function checkMapBinding(op, item, identity) {
  if (!item.discovery_sources?.some(({ kind }) => kind === 'maps')) return true;
  const verifiedNames = new Set(
    [identity?.name, identity?.website_name, ...(identity?.aliases || [])]
      .map(subjectName)
      .filter(Boolean),
  );
  op.discovery_sources = item.discovery_sources.filter(
    (source) =>
      source.kind === 'web' ||
      (identity?.status !== 'identity_conflict' &&
        verifiedNames.has(subjectName(source.mentioned_company))),
  );
  if (op.discovery_sources.length !== item.discovery_sources.length) {
    op.maps_binding =
      verifiedNames.size && identity?.status !== 'identity_conflict' ? 'mismatch' : 'unverified';
  }
  return !op.maps_binding || op.discovery_sources.some(({ kind }) => kind === 'web');
}

function admissionGap(research) {
  if (
    research.eligibility?.status === 'rejected' ||
    research.eligibility?.code === 'official_site_missing' ||
    [research.country_match, research.customer_type_match, research.profile_match].includes(
      'not_matched',
    )
  )
    return null;
  if (!research.company_identity?.name || research.company_identity.status === 'identity_conflict')
    return 'missing_company_identity';
  if (research.eligibility?.status !== 'eligible' || research.product_match === 'unknown')
    return 'missing_operating_evidence';
  return null;
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
const paidRequestSummaries = (op) =>
  Object.values(op.paid_requests || {}).map(
    ({ id, kind, provider, status, started_at, usage }) => ({
      id,
      kind,
      provider,
      status,
      started_at,
      ...(usage === undefined ? {} : { usage }),
    }),
  );

export class NativeAcquisition {
  constructor({
    env,
    fetchImpl = fetch,
    readPage = readPublicHtml,
    readScraplingPage = collectScraplingPage,
    feishu,
    store,
    assessments,
    providers,
    mapsProvider,
    admissionVersion = websiteAdmissionVersion,
  } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.readPage = readPage;
    this.readScraplingPage = readScraplingPage;
    this.admissionVersion = admissionVersion;
    this.providers = providers || createResearchProviders({ env, fetchImpl });
    this.discoverMaps = mapsProvider ? createMapsDiscovery(mapsProvider) : null;
    this.feishu = feishu || new FeishuClient({ env, fetchImpl });
    this.store =
      store ||
      new AcquisitionStore(
        env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH || ':memory:',
        String(env.FEISHU_APP_TOKEN) + '/' + String(env.FEISHU_TABLE_ID),
      );
    this.active = new Set();
    this.researchByDomain = new Map();
    this.assessments = assessments || new AssessmentService({ env });
    this.supplements = new LeadSupplementStore(
      env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH || ':memory:',
      String(env.FEISHU_APP_TOKEN) + '/' + String(env.FEISHU_TABLE_ID),
    );
  }
  assessmentInfo() {
    return {
      ruleVersion: ASSESSMENT_RULE_VERSION,
      markets: acquisitionMarkets,
      assessmentStorage: 'latest_only',
      businessSchemaVersion: BUSINESS_SCHEMA_VERSION,
    };
  }
  assertAutomaticIdentityIntegrity() {
    this.store.assertAutomaticIdentityIntegrity();
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
        const factSummary = (fact) => ({
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
        });
        const dimensionSummary = (dimensions) =>
          Object.fromEntries(
            Object.entries(dimensions || {}).map(([key, dimension]) => [
              key,
              {
                score: dimension.score,
                maximum: dimension.maximum,
                missing: dimension.missing,
                facts: (Array.isArray(dimension.facts) ? dimension.facts : []).map(factSummary),
                ...(dimension.conflict ? { conflict: true } : {}),
              },
            ]),
          );
        const facts = [
          ...stored.facts,
          ...stored.opportunities.flatMap((o) => o.facts.map((f) => ({ ...f, field: f.kind }))),
        ]
          .filter((fact) => fact.origin !== 'manual')
          .map(readable);
        const summaries = assessmentSummaryFields(stored);
        return decorateDossierConfirmations(
          {
            ...lead,
            supplyOpportunity: summaries['主要供货机会'],
            pendingQuestions: summaries['待确认事项'],
            score: stored.score,
            grade: stored.grade || '未评级',
            ratingReason: lead.ratingReason || stored.reason,
            facts,
            assessment: {
              id: stored.id,
              entityType: stored.entityType,
              ruleVersion: stored.ruleVersion,
              evaluatedAt: stored.evaluatedAt,
              score: stored.score,
              grade: stored.grade,
              status: stored.status,
              complete: stored.complete,
              matchLevel: stored.matchLevel,
              prioritySignals: stored.prioritySignals,
              product: stored.product,
              direction: stored.direction,
              supplyOpportunity: stored.supplyOpportunity,
              opportunities: stored.opportunities.map((o) => ({
                direction: o.direction,
                product: o.product,
                relationship: o.relationship,
                ...(o.relationship === 'potential_input'
                  ? {
                      basisProduct: o.product,
                      targetProduct:
                        stored.target?.product || stored.supplyOpportunity?.targetProduct,
                    }
                  : {}),
                grade: o.grade,
                status: o.status,
                matchLevel: o.matchLevel,
                prioritySignals: o.prioritySignals,
                facts: (o.facts || []).map(factSummary),
                dimensions: dimensionSummary(o.dimensions),
                missing: o.missing || [],
              })),
              evidenceReason: formatAssessmentEvidence(stored),
              incompleteReason: stored.incompleteReason,
              missing: stored.missing,
              dimensions: dimensionSummary(stored.dimensions),
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
    const countryValue = body.country || fieldText(fieldValue(record.fields, '国家'));
    const country = countryFor(countryValue)?.name;
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
  async discover(
    input,
    search,
    seen = [],
    {
      admissionVersion = this.admissionVersion,
      identityVersion,
      mapsContext,
      discoveryRequestId,
    } = {},
  ) {
    input = { ...input, ...validateTarget(input) };
    const conditionsKey = exclusionConditionsKey(input);
    this.store.backfillExclusions();
    const globalTerritory =
      input.country === WORLDWIDE_COUNTRY &&
      search?.scope === WORLDWIDE_COUNTRY &&
      countryFor(search.country);
    if (search?.country && !globalTerritory && !input.market_countries.includes(search.country))
      throw Object.assign(new Error('搜索国家不在当前支持的市场范围内'), { status: 400 });
    this.ensureConfigured();
    const byUrl = identityVersion === acquisitionIdentityVersion;
    const known = byUrl
      ? []
      : (await this.feishu.records()).map((r) => domainKey(customerWebsite(r))).filter(Boolean);
    const paired =
      this.discoverMaps && byUrl && admissionVersion === websiteAdmissionVersion && mapsContext;
    const recent = new Set(paired ? seen.filter((url) => !mapsContext.mapOnlyUrls.has(url)) : seen);
    const excluded = [...new Set(known.filter((domain) => !recent.has(domain))), ...recent];
    const query = search.query.slice(0, 395);
    const request = {
      query,
      search_depth: 'basic',
      max_results: 20,
      include_answer: false,
      include_raw_content: false,
      auto_parameters: false,
      exclude_domains: byUrl ? [] : excluded.slice(-150),
    };
    let data;
    if (discoveryRequestId) {
      const { operation } = this.store.begin(discoveryRequestId, { request });
      data = await this.paidRequest(
        operation,
        'web_search',
        this.providers.web,
        request,
        null,
        (id) => this.providers.web.search(request, { requestId: id }),
      );
    } else data = await this.providers.web.search(request);
    const selected = selectWebsiteCandidates(
      data.results,
      excluded,
      20,
      byUrl,
      admissionVersion === websiteAdmissionVersion,
    );
    selected.candidates = selected.candidates.filter((candidate) => {
      const prior =
        admissionVersion === 'legacy' && this.store.exclusion(conditionsKey, candidate.source_url);
      if (!prior) return true;
      selected.filtered_sources.push({
        url: candidate.source_url,
        reason: `历史排除：${prior.reason}`,
        operation_id: prior.operation_id,
      });
      return false;
    });
    const result = {
      ...selected,
      stage: 'select',
      source: this.providers.web.provider,
      usage: data.usage,
    };
    if (!paired) return result;
    const lookup = await this.discoverMaps(
      { query, country: search.country, searchRegion: search.searchRegion },
      mapsContext,
    );
    return compareMapDiscovery(result, lookup, mapsContext);
  }
  async collect(
    sourceUrl,
    {
      unified = false,
      now,
      refresh = false,
      previousAttempts = [],
      restoring = false,
      onAttempt,
      onCollectionQueue,
      evidenceUrl,
      op,
      operationId,
      signal,
      check = () => {},
    } = {},
  ) {
    const initial = websiteUrl(sourceUrl);
    if (!initial) throw new Error('官网地址无效，仅接受公网 HTTPS 企业网站');
    if (unified) this.store.maintainPageSnapshots();
    const domain = domainKey(initial.href),
      pages = [],
      failures = new Set(),
      researchPages = new Map();
    const queue = [
        ...new Set([initial.href, ...(domainKey(evidenceUrl) === domain ? [evidenceUrl] : [])]),
      ],
      planned = new Set(queue),
      visited = new Set();
    const webUsage = webUsageCounter('extract');
    const collection_attempts = [];
    const blocked = new Set();
    const diskDeferred = new Set();
    const browserVisited = new Set();
    const resolved = new Set();
    const enqueue = (url, content) => {
      const candidates = planWebsitePages(url, content, { includeProducts: unified });
      if (unified) {
        const priority = (next) =>
          next === initial.href || next === evidenceUrl ? 9 : websitePagePriority(next, true);
        const pending = [...new Set([...queue, ...candidates])]
          .filter((next) => !visited.has(next) && !resolved.has(next))
          .sort((a, b) => priority(b) - priority(a));
        queue.splice(0, queue.length, ...pending.slice(0, Math.max(0, 5 - visited.size)));
        return;
      }
      for (const next of candidates) {
        if (planned.size >= 5) break;
        if (!planned.has(next)) {
          planned.add(next);
          queue.push(next);
        }
      }
    };
    let browsesProfiles = false,
      publishesListings = false,
      managesCandidateProfile = false;
    const isBusinessDirectory = () =>
      browsesProfiles && (publishesListings || managesCandidateProfile);
    const addPage = (url, content, snapshotId, requestedUrl = url) => {
      // Keep complete HTML for independent contact/metadata extraction, even on shells.
      pages.push({ url, content });
      if (unified) resolved.add(url);
      enqueue(url, content);
      const text = researchPageText(content, content.length);
      if (!hasUsableResearchText(text, content)) return false;
      const custody = businessDirectoryEvidence(text);
      if (requestedUrl === initial.href) managesCandidateProfile ||= custody.manageProfile;
      // The candidate's description can be supplied by a listed business.
      if (requestedUrl !== initial.href || new URL(url).pathname === '/') {
        browsesProfiles ||= custody.browseProfiles;
        publishesListings ||= custody.publishListings;
      }
      if (unified) {
        const page = researchPages.get(url) || {
          source_url: url,
          text: '',
          selected: [],
          origins: [],
        };
        const selected = selectAcquisitionEvidence(url, content).text;
        if (!page.selected.includes(selected)) {
          page.text += text;
          page.selected.push(selected);
          page.origins.push({ text, snapshotId });
        }
        researchPages.set(url, page);
      } else researchPages.set(url, { source_url: url, text });
      return true;
    };
    const retain = ({ content, raw_content, links, ...attempt }, reused = false) => {
      if (reused && operationId) this.store.referencePageSnapshot(operationId, attempt.snapshot_id);
      if (attempt.status === 'ok') {
        addPage(attempt.final_url, content, attempt.snapshot_id, attempt.requested_url);
        if (raw_content && raw_content !== content)
          pages.push({ url: attempt.final_url, content: raw_content });
        if (links?.length) enqueue(attempt.final_url, links.map((url) => `[](${url})`).join('\n'));
      }
      const trace = {
        ...attempt,
        evidence_version: acquisitionEvidenceVersion,
        reused,
      };
      collection_attempts.push(trace);
      onAttempt?.(trace);
    };
    const attempted = { basic: new Set(), advanced: new Set() };
    const pinned =
      restoring && operationId
        ? new Map(
            this.store.referencedPageSnapshots(operationId).map((page) => [page.snapshot_id, page]),
          )
        : new Map();
    for (const attempt of previousAttempts) {
      const stored =
        pinned.get(attempt.snapshot_id) ||
        this.store.snapshotById(attempt.snapshot_id, { verify: true });
      pinned.delete(attempt.snapshot_id);
      if (stored?.status === 'ok' && domainKey(stored.final_url) === domain) {
        visited.add(stored.requested_url);
        retain(stored, true);
      } else collection_attempts.push(attempt);
      if (attempt.method === 'scrapling' && attempt.status !== 'deferred')
        browserVisited.add(attempt.requested_url);
      if (attempt.status === 'blocked') {
        blocked.add(attempt.requested_url);
        visited.add(attempt.requested_url);
      }
      if (attempt.extract_depth) attempted[attempt.extract_depth]?.add(attempt.requested_url);
    }
    for (const page of pinned.values()) {
      if (page.status === 'ok') visited.add(page.requested_url);
      retain(page, true);
    }
    const record = ({
      requested_url,
      final_url,
      method,
      status,
      reason,
      content = '',
      raw_content = content,
      acquired_at = new Date(now ?? Date.now()).toISOString(),
      links,
      versions,
      resource_wait,
      extract_depth,
      failure_reason,
      resources,
      paid_request_id,
    }) => {
      const snapshot = this.store.savePageSnapshot(
        {
          requested_url,
          final_url,
          acquired_at,
          method,
          status,
          reason,
          content,
          raw_content,
          content_hash: content ? createHash('sha256').update(content).digest('hex') : null,
          evidence_version: acquisitionEvidenceVersion,
          gaps: status === 'ok' ? [] : ['page_body'],
          ...(links ? { links } : {}),
          ...(versions ? { versions } : {}),
          ...(resource_wait ? { resource_wait } : {}),
          ...(extract_depth ? { extract_depth } : {}),
          ...(failure_reason ? { failure_reason } : {}),
          ...(resources ? { resources } : {}),
          ...(paid_request_id ? { paid_request_id } : {}),
        },
        { operationId },
      );
      retain(snapshot);
      return snapshot.status;
    };
    // Discover contact/about/service links from complete HTML before limiting AI input.
    const readPlanned = async () => {
      while (queue.length && visited.size < 5) {
        check();
        const original = queue.shift();
        if (visited.has(original) || resolved.has(original)) continue;
        visited.add(original);
        if (blocked.has(original)) continue;
        let url = websiteUrl(original),
          content = '',
          status = 'failed';
        if (unified && !refresh) {
          const cached = this.store
            .pageSnapshots(original, { now })
            .filter((page) => domainKey(page.final_url) === domain);
          if (cached.length) {
            cached.forEach((page) => retain(page, true));
            continue;
          }
        }
        if (unified && !this.store.canPersistPageBodies()) {
          failures.add(original);
          diskDeferred.add(original);
          record({
            requested_url: original,
            final_url: null,
            method: 'node',
            status: 'deferred',
            reason: 'initial_read',
            failure_reason: 'snapshot_capacity',
          });
          continue;
        }
        try {
          for (let hop = 0; hop < 4; hop++) {
            const timeout = AbortSignal.timeout(12000);
            const response = await this.readPage(
              url,
              signal ? AbortSignal.any([timeout, signal]) : timeout,
            );
            if (response.redirect) {
              const next = unified
                ? websiteRedirectUrl(response.redirect, url)
                : websiteUrl(response.redirect, url);
              if (!next || domainKey(next.href) !== domain) {
                if (unified) {
                  status = 'blocked';
                  blocked.add(original);
                  record({
                    requested_url: original,
                    final_url: next?.href ?? null,
                    method: 'node',
                    status,
                    reason: 'off_site_redirect',
                  });
                }
                throw new Error('官网跳转到其他域名');
              }
              url = next;
            } else {
              content = response.html || '';
              status = hasUsableResearchText(researchPageText(content, content.length), content)
                ? 'ok'
                : 'empty';
              break;
            }
          }
          if (!unified && !addPage(url.href, content, undefined, original)) failures.add(original);
        } catch (error) {
          failures.add(original);
          if (unified && error.code === 'WEBSITE_NOT_PUBLIC') {
            status = 'blocked';
            blocked.add(original);
            record({
              requested_url: original,
              final_url: url?.href ?? null,
              method: 'node',
              status,
              reason: 'non_public_source',
            });
          }
        }
        if (unified && status !== 'blocked') {
          status = record({
            requested_url: original,
            final_url: url?.href ?? null,
            method: 'node',
            status,
            reason: 'initial_read',
            content,
          });
          if (status !== 'ok') {
            failures.add(original);
            enqueue(url.href, content);
          }
        }
      }
    };
    const recoverBrowser = async (original, reason) => {
      check();
      if (
        browserVisited.size >= 2 ||
        blocked.has(original) ||
        browserVisited.has(original) ||
        diskDeferred.has(original) ||
        !this.store.canPersistPageBodies()
      )
        return false;
      browserVisited.add(original);
      const result = await this.readScraplingPage(original, {
        reason,
        python: this.env.SCRAPLING_PYTHON,
        signal,
        onQueue: onCollectionQueue && ((state) => onCollectionQueue(state, original)),
      }).catch(() => ({ status: 'failed', failure_reason: 'worker_failed' }));
      const final = websiteUrl(result.final_url);
      const content = typeof result.content === 'string' ? result.content : '';
      const sameSite = final && domainKey(final.href) === domain;
      const status =
        result.status === 'ok'
          ? !sameSite
            ? 'blocked'
            : hasUsableResearchText(researchPageText(content, content.length), content)
              ? 'ok'
              : 'empty'
          : result.status;
      const storedStatus = record({
        ...result,
        requested_url: original,
        final_url: final?.href ?? null,
        method: 'scrapling',
        status,
        reason,
        content: sameSite ? content : '',
        raw_content: sameSite ? result.raw_content : '',
      });
      if (storedStatus === 'ok') failures.delete(original);
      if (storedStatus === 'blocked') blocked.add(original);
      return storedStatus === 'ok';
    };
    const recordExtract = (selected, depth, reason, extracted, failureReason, requestId) => {
      for (const url of selected) {
        const found = (extracted?.results || []).find((page) => websiteUrl(page.url)?.href === url);
        const content = [found?.raw_content, found?.content].find(
          (value) =>
            typeof value === 'string' &&
            hasUsableResearchText(researchPageText(value, value.length), value),
        );
        const status = record({
          requested_url: url,
          final_url: found ? url : null,
          method: 'external',
          status: content
            ? 'ok'
            : found
              ? 'empty'
              : failureReason === 'provider_request_unknown'
                ? 'unknown'
                : 'failed',
          reason,
          extract_depth: depth,
          failure_reason: failureReason,
          paid_request_id: requestId,
          content: content ?? found?.raw_content ?? found?.content ?? '',
        });
        if (status === 'ok') {
          failures.delete(url);
          if (restoring) visited.add(url);
        }
      }
    };
    if (restoring) {
      for (const entry of Object.values(op.paid_requests || {})) {
        if (entry.kind !== 'web_extract' || !entry.source) continue;
        const { urls, extract_depth, reason } = entry.source;
        for (const url of urls) attempted[extract_depth].add(url);
        const failure =
          entry.status === 'completed'
            ? undefined
            : entry.status === 'failed'
              ? 'provider_extract_failed'
              : 'provider_request_unknown';
        const missing = urls.filter(
          (url) =>
            !collection_attempts.some(
              (attempt) =>
                attempt.paid_request_id === entry.id &&
                attempt.requested_url === url &&
                (!entry.response || attempt.status !== 'unknown'),
            ),
        );
        if (missing.length)
          recordExtract(missing, extract_depth, reason, entry.response, failure, entry.id);
      }
    }
    const extractSelected = async (selected, depth, reason) => {
      check();
      for (const url of selected) attempted[depth].add(url);
      if (unified && !this.store.canPersistPageBodies()) return;
      let extracted;
      let failureReason;
      let requestId;
      try {
        const request = {
          urls: selected,
          extract_depth: depth,
          format: 'markdown',
        };
        if (op) {
          extracted = await this.paidRequest(
            op,
            'web_extract',
            this.providers.web,
            request,
            null,
            (id) => {
              requestId = id;
              return this.providers.web.extract(request, { requestId: id });
            },
            { urls: selected, extract_depth: depth, reason },
          );
        } else {
          webUsage.start();
          extracted = await this.providers.web.extract(request);
          webUsage.observe(extracted);
        }
      } catch (error) {
        failureReason =
          error.code === 'ACQUISITION_PAID_UNKNOWN'
            ? 'provider_request_unknown'
            : 'provider_extract_failed';
        extracted = { results: [] };
      }
      if (unified) {
        recordExtract(selected, depth, reason, extracted, failureReason, requestId);
      } else
        for (const p of extracted?.results || []) {
          const url = websiteUrl(p?.url);
          if (
            !url ||
            domainKey(url.href) !== domain ||
            !selected.includes(url.href) ||
            !planned.has(url.href)
          )
            continue;
          for (const content of [p.raw_content, p.content]) {
            if (typeof content !== 'string') continue;
            if (addPage(url.href, content)) {
              failures.delete(url.href);
              break;
            }
          }
        }
    };
    await readPlanned();
    check();
    // Supplement failed or dynamically rendered pages, bounded to the same five URLs.
    while (!isBusinessDirectory()) {
      if (unified) {
        for (const original of failures) await recoverBrowser(original, 'missing_page_body');
        if (queue.length) {
          await readPlanned();
          continue;
        }
      }
      const recoverable = [...failures].filter(
        (url) => !blocked.has(url) && !diskDeferred.has(url),
      );
      const depth = (
        !unified && this.providers.web.provider !== 'deepseek' ? ['basic', 'advanced'] : ['basic']
      ).find((level) => recoverable.some((url) => !attempted[level].has(url)));
      if (!depth) break;
      const selected = recoverable.filter((url) => !attempted[depth].has(url));
      if (op && this.providers.web.provider === 'deepseek') {
        for (const url of selected) await extractSelected([url], depth, 'missing_page_body');
      } else await extractSelected(selected, depth, 'missing_page_body');
      await readPlanned();
    }
    check();
    if (!researchPages.size)
      throw Object.assign(new Error('官网页面均未取得有效正文，采集未完成，未调用模型或写入'), {
        web_usage: op?.web_usage || webUsage.snapshot(),
        collection_attempts,
        incomplete_urls: [...failures],
      });
    const result = () => {
      const captured = [...researchPages.values()];
      const originalChars = captured.reduce((sum, page) => sum + page.text.length, 0);
      const compacted = captured.map((page) => ({
        source_url: page.source_url,
        text: unified
          ? page.selected.join(RESEARCH_GAP)
          : compactResearchText(page.text, page.source_url),
      }));
      const bounded = boundedResearchPages(compacted);
      bounded.stats.originalChars = originalChars;
      bounded.stats.compactedChars =
        originalChars - compacted.reduce((sum, page) => sum + page.text.length, 0);
      return {
        source_url: initial.href,
        research_pages: bounded.pages,
        page_text: bounded.pages.map((page) => page.text).join('\n'),
        input_stats: bounded.stats,
        web_usage: op?.web_usage || webUsage.snapshot(),
        incomplete_urls: [...failures],
        website_metadata: combineWebsiteEvidence(pages),
        is_business_directory: isBusinessDirectory(),
        checked_urls: [...researchPages.keys()],
        ...(unified ? { collection_attempts, evidence_by_url: researchPages } : {}),
      };
    };
    const first = result();
    if (unified)
      first.supplement = async (reason) => {
        const preferredPath =
          reason === 'missing_company_identity'
            ? /about|contact|legal|terms|privacy|impressum/i
            : /products?|collections?|services?|blinds|shutters|curtains|awnings/i;
        const candidates = [...visited]
          .filter((url) => !blocked.has(url) && !browserVisited.has(url))
          .sort(
            (a, b) =>
              Number(preferredPath.test(new URL(b).pathname)) -
              Number(preferredPath.test(new URL(a).pathname)),
          );
        for (const url of candidates.slice(0, Math.max(0, 2 - browserVisited.size))) {
          const previousSize = researchPages.get(url)?.selected.length;
          if (
            !(await recoverBrowser(url, reason)) &&
            !blocked.has(url) &&
            !attempted.basic.has(url)
          )
            await extractSelected([url], 'basic', reason);
          await readPlanned();
          if (researchPages.get(url)?.selected.length !== previousSize) break;
        }
        return result();
      };
    return first;
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
            matchLevel: operation.assessment.matchLevel,
            prioritySignals: operation.assessment.prioritySignals,
            complete: operation.assessment.complete,
            ruleVersion: operation.assessment.ruleVersion,
          }
        : null,
      checked_urls: research.checked_urls || [],
      ...(operation.research_usage ? { research_usage: operation.research_usage } : {}),
      ...(operation.web_usage ? { web_usage: operation.web_usage } : {}),
      ...(operation.paid_requests ? { paid_requests: paidRequestSummaries(operation) } : {}),
      ...(operation.collection_attempts
        ? { collection_attempts: operation.collection_attempts }
        : {}),
      ...(operation.collection_gaps?.length ? { collection_gaps: operation.collection_gaps } : {}),
      ...(operation.research_trace ? { research_trace: operation.research_trace } : {}),
      ...(operation.discovery_sources ? { discovery_sources: operation.discovery_sources } : {}),
      ...(operation.maps_binding ? { maps_binding: operation.maps_binding } : {}),
      明细: row ? [row] : [],
    };
  }
  rejectNewCandidate(operation, reason) {
    const research = operation.research || {};
    const minimal = {
      id: operation.id,
      scope: operation.scope,
      stage: operation.stage,
      createdAt: operation.createdAt,
      input: {
        input: validateTarget(operation.input.input),
        item: { source_url: operation.input.item.source_url },
      },
      checked_urls: operation.checked_urls,
      incomplete_urls: operation.incomplete_urls,
      collection_complete: operation.collection_complete,
      collection_attempts: operation.collection_attempts,
      research_trace: operation.research_trace,
      admission_version: operation.admission_version,
      research_complete: operation.research_complete,
      research: Object.fromEntries(
        [
          'stage',
          'source_url',
          'entity_type',
          'product_match',
          'country_match',
          'customer_type_match',
          'profile_match',
          'review_required',
          'incomplete_reason',
        ]
          .filter((key) => research[key] !== undefined)
          .map((key) => [key, research[key]]),
      ),
      research_usage: operation.research_usage,
      web_usage: operation.web_usage,
      ...(operation.maps_binding ? { maps_binding: operation.maps_binding } : {}),
    };
    if (research.relevance) minimal.research.relevance = { relevant: research.relevance.relevant };
    if (research.eligibility)
      minimal.research.eligibility =
        operation.admission_version === websiteAdmissionVersion
          ? research.eligibility
          : { status: research.eligibility.status };
    if (operation.admission_version === websiteAdmissionVersion) {
      minimal.research.company_name = research.company_name;
      minimal.research.facts = research.facts?.filter((fact) =>
        ['company_name', 'legal_company_name', 'admission_facts', 'products'].includes(fact.field),
      );
    }
    const output = this.output(minimal, {
      research: { ...minimal.research, ok: false, reason },
      outcome: 'rejected',
      reason,
    });
    return this.store.completeResearch(
      minimal,
      output,
      exclusionConditionsKey(operation.input.input),
      operation.input.item.source_url,
    );
  }
  async research(input, item, options) {
    const domain = domainKey(item.source_url);
    if (!domain) return this.researchDomain(input, item, options);
    const previous = this.researchByDomain.get(domain);
    const current = (async () => {
      await previous?.catch(() => {});
      return this.researchDomain(input, item, options);
    })();
    this.researchByDomain.set(domain, current);
    try {
      return await current;
    } finally {
      if (this.researchByDomain.get(domain) === current) this.researchByDomain.delete(domain);
    }
  }
  async researchDomain(
    input,
    item,
    {
      bypassExclusion = false,
      admissionVersion = item.target_record_id ? 'legacy' : this.admissionVersion,
      identityVersion,
      executionVersion,
      onCollectionQueue,
      isMaintaining,
      signal,
      review,
    } = {},
  ) {
    // Also validate restored tasks and callers that bypass HTTP validation.
    const target = validateTarget(input);
    input = { ...input, ...target };
    const researchTarget =
      executionVersion === unifiedExecutionVersion
        ? { ...target, customer_types: [], customer_type: '', customer_profile: 'all' }
        : target;
    const conditionsKey = exclusionConditionsKey(input);
    this.ensureConfigured();
    const id = item.operation_id;
    if (typeof id !== 'string' || !/^[\w-]{8,150}$/.test(id)) throw conflict('研究操作编号无效');
    if (!review && !item.target_record_id) this.assertAutomaticIdentityIntegrity();
    const scopedIdentity = identityVersion === acquisitionIdentityVersion && this.feishu.localFirst;
    const { operation: op, existing } = this.store.begin(id, {
      input,
      item,
      ...(identityVersion ? { identityVersion } : {}),
      ...(executionVersion ? { executionVersion } : {}),
      ...(review ? { review } : {}),
    });
    const resumable = scopedIdentity && executionVersion === unifiedExecutionVersion;
    if (existing && !(resumable && this.beforeAcquisitionWrite(op) && !this.active.has(id))) {
      const settled = await this.status(id);
      if (settled.settled) return settled.output;
      throw conflict('该企业操作尚待确认，未重复研究或写入');
    }
    if (existing && !(await this.reconcilePaidRequests(op, { deferExternal: true })))
      throw paidUnknown();
    const unified = admissionVersion === websiteAdmissionVersion;
    if (resumable) op.recovery_version = 1;
    op.admission_version = admissionVersion;
    op.identity_version = identityVersion;
    op.research_usage ||= { model_calls: 0, cache_hits: 0, input_chars: 0 };
    const check = () => {
      if (resumable && (signal?.aborted || isMaintaining?.())) throw interrupted();
    };
    this.active.add(id);
    try {
      check();
      const domain = domainKey(item.source_url);
      const candidateUrl = websiteUrl(item.source_url)?.href;
      if (!websiteScope(item.source_url) || !domain) throw new Error('企业网址无效');
      let matching = scopedIdentity ? [] : recordsForDomain(await this.feishu.records(), domain);
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
      if (
        item.third_party_profile_url === candidateUrl ||
        !companyWebsiteSourceUrl(item.source_url, { title: item.source_title })
      ) {
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
      if (!unified && !item.target_record_id && !bypassExclusion) {
        const prior = this.store.exclusion(conditionsKey, item.source_url);
        if (prior) {
          const reason = `命中历史排除记录（原操作 ${prior.operation_id}）：${prior.reason}`;
          const output = this.output(op, {
            outcome: 'rejected',
            reason,
            research: {
              ok: false,
              stage: 'done',
              source_url: item.source_url,
              review_required: false,
              historical_exclusion: {
                operation_id: prior.operation_id,
                excluded_at: prior.excluded_at,
                summary: JSON.parse(prior.summary),
              },
            },
          });
          this.store.complete(op, output);
          return output;
        }
      }
      op.stage = 'extract';
      this.store.save(op);
      const page = await this.collect(item.source_url, {
        unified,
        check,
        signal,
        operationId: unified ? id : undefined,
        ...(resumable ? { op } : {}),
        refresh: bypassExclusion,
        evidenceUrl: review?.decision?.source_url,
        onCollectionQueue,
        ...(resumable && existing
          ? { previousAttempts: op.collection_attempts || [], restoring: true }
          : {}),
        onAttempt: (attempt) => {
          const attempts = (op.collection_attempts ||= []);
          const index = attempts.findIndex(
            ({ snapshot_id }) => snapshot_id === attempt.snapshot_id,
          );
          if (index === -1) attempts.push(attempt);
          else attempts[index] = attempt;
          this.store.save(op);
        },
      });
      page.admission_version = admissionVersion;
      page.source_title = item.source_title;
      op.web_usage = page.web_usage;
      op.incomplete_urls = page.incomplete_urls;
      op.research_usage.omitted_pages = page.input_stats?.omittedPages || 0;
      op.research_usage.truncated_pages = page.input_stats?.truncatedPages || 0;
      op.research_usage.original_chars = page.input_stats?.originalChars || 0;
      op.research_usage.compacted_chars = page.input_stats?.compactedChars || 0;
      op.stage = 'research';
      op.checked_urls = page.checked_urls;
      op.research_pages = page.research_pages;
      op.collection_complete = page.research_pages.length > 0;
      op.evidence = page.website_metadata;
      this.store.save(op);
      check();
      const reviewThirdParty = async () => {
        const reason = '采集正文表明当前页面为第三方档案、平台或目录，尚未取得企业独立官网';
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
      };
      if (
        page.is_business_directory ||
        op.collection_attempts?.some(
          ({ requested_url, final_url }) =>
            requested_url === candidateUrl && thirdPartySupplierProfile({ url: final_url }),
        ) ||
        thirdPartyCompanySource({
          url: item.source_url,
          title: item.source_title,
          text: page.page_text,
        })
      )
        return await reviewThirdParty();
      if (scopedIdentity && !review) {
        const known = this.previouslyVerifiedSubject(page, item, op, researchTarget);
        if (known) {
          check();
          return await this.finishAcquisitionMatch(op, { record_id: known });
        }
      }
      // Cheap keyword screen before the paid model call: keep only pages that
      // actually mention the target products or the window-shading industry.
      const relevance = pageRelevance(page.page_text, input);
      if (!unified && !relevance.relevant) {
        const incomplete = page.incomplete_urls.length > 0;
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
          reason: incomplete
            ? '官网部分页面未取得有效正文，采集未完成，待补充核实'
            : input.query_mode === 'auto'
              ? '本轮官网正文未取得目标品类依据，待补充核实'
              : '官网内容与目标产品不相关，已预筛排除',
          source_url: item.source_url,
          product_match: incomplete ? 'unknown' : 'not_matched',
          relevance,
          checked_urls: page.checked_urls,
          review_required: incomplete || input.query_mode === 'auto',
        };
        op.research = research;
        this.store.save(op);
        if (!research.review_required && research.product_match === 'not_matched')
          return this.rejectNewCandidate(op, research.reason);
        const output = this.output(op, { research, reason: research.reason, outcome: 'review' });
        return this.store.completeResearch(
          op,
          output,
          exclusionConditionsKey(input),
          item.source_url,
        );
      }
      const context = {
        input,
        researchTarget,
        item,
        domain,
        conditionsKey,
        admissionVersion,
        unified,
        bypassExclusion,
        identityVersion,
        review,
        check,
      };
      let { response, parsed, cacheKey, extractionFromCache } = await this.researchPageEvidence(
        page,
        op,
        context,
      );
      if (unified) {
        const gap = admissionGap(parsed);
        if (gap) {
          op.collection_gaps = [gap];
          const supplemented = await page.supplement(gap);
          op.web_usage = supplemented.web_usage;
          op.incomplete_urls = supplemented.incomplete_urls;
          if (supplemented.is_business_directory || supplemented.page_text !== page.page_text) {
            Object.assign(page, supplemented);
            op.research_pages = page.research_pages;
            op.checked_urls = page.checked_urls;
            op.evidence = page.website_metadata;
            if (page.is_business_directory) return await reviewThirdParty();
            this.store.save(op);
            ({ response, parsed, cacheKey, extractionFromCache } = await this.researchPageEvidence(
              page,
              op,
              context,
            ));
            op.collection_gaps = [admissionGap(parsed)].filter(Boolean);
          }
        }
      }
      op.research_response = response;
      this.store.save(op);
      check();
      const research = {
        ...parsed,
        checked_urls: page.checked_urls,
      };
      if (
        page.incomplete_urls.length &&
        research.product_match === 'not_matched' &&
        ![research.country_match, research.customer_type_match, research.profile_match].includes(
          'not_matched',
        ) &&
        research.eligibility?.status !== 'rejected'
      ) {
        research.product_match = 'unknown';
        research.product_relation = { ...research.product_relation, status: 'unknown' };
        research.review_required = true;
        research.reason = '官网部分页面未取得有效正文，采集未完成，待补充核实';
      }
      op.research = research;
      op.research_complete = true;
      op.evidence = page.website_metadata;
      op.research_pages = page.research_pages;
      op.usage = extractionFromCache ? undefined : response.usage;
      this.store.save(op);
      const identityVerified =
        research.company_identity?.name &&
        ['legal_name_self_reported', 'website_name_only'].includes(
          research.company_identity.status,
        ) &&
        research.company_identity.status !== 'identity_conflict';
      const hardMismatch =
        !(
          unified &&
          ((!identityVerified && research.entity_type !== 'individual') ||
            research.eligibility?.code === 'official_site_missing')
        ) &&
        (research.entity_type === 'individual' ||
          research.product_match === 'not_matched' ||
          research.country_match === 'not_matched' ||
          research.customer_type_match === 'not_matched' ||
          research.profile_match === 'not_matched' ||
          research.eligibility?.status === 'rejected');
      const broadAdmissionReady =
        research.entity_type === 'business' &&
        Boolean(research.company_name) &&
        Boolean(identityVerified) &&
        research.product_match === 'matched' &&
        !hardMismatch &&
        (!unified || research.eligibility?.status === 'eligible');
      if (
        !scopedIdentity &&
        hardMismatch &&
        cacheKey &&
        typeof this.store.discardModelResponse === 'function'
      ) {
        try {
          this.store.discardModelResponse(cacheKey);
        } catch {
          op.research_usage.cache_unavailable = true;
        }
      }
      if (hardMismatch && !item.target_record_id && !scopedIdentity) {
        const reason =
          unified && research.eligibility?.status === 'rejected'
            ? research.eligibility.reason
            : research.entity_type === 'individual'
              ? '官网主体不是经营企业'
              : research.product_match === 'not_matched'
                ? '官网产品与本次目标不相关'
                : research.country_match === 'not_matched'
                  ? '官网所在国家与目标市场不符'
                  : research.customer_type_match === 'not_matched'
                    ? '官网客户类型与本次筛选不符'
                    : research.profile_match === 'not_matched'
                      ? '官网业务画像与本次筛选不符'
                      : '官网经营资格与本次目标不符';
        return this.rejectNewCandidate(op, reason);
      }
      if (
        (!hardMismatch || scopedIdentity) &&
        !extractionFromCache &&
        cacheKey &&
        typeof this.store.saveModelResponse === 'function'
      ) {
        try {
          this.store.saveModelResponse(cacheKey, response);
        } catch {
          // Reuse is an optimization, not a prerequisite for completing the
          // current validated result or a reason to repeat its model call.
          op.research_usage.cache_unavailable = true;
        }
      }
      if (identityVerified && !checkMapBinding(op, item, research.company_identity)) {
        const output = this.output(op, {
          research,
          outcome: 'review',
          reason: '地图地点与独立官网的经营主体不一致，暂停地图路径待核实',
        });
        return this.store.complete(op, output).output;
      }
      if (scopedIdentity && hardMismatch && !item.target_record_id) {
        return this.rejectNewCandidate(op, research.reason || '官网经营资格与本次目标不符');
      }
      if (!broadAdmissionReady && !item.target_record_id) {
        if (unified) research.review_required = true;
        op.reviewRequestKey = cacheKey;
        const output = this.output(op, {
          research,
          outcome: 'review',
          reason: research.reason || '官网主体或窗饰产品关联尚未核实',
        });
        return this.store.completeResearch(
          op,
          output,
          exclusionConditionsKey(input),
          item.source_url,
        );
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
      check();
      if (scopedIdentity && !item.target_record_id) {
        const registration = verifiedRegistration(research.company_identity, research.facts);
        op.acquisition = {
          operation_id: id,
          source_url: item.source_url,
          source_kind: item.source_kind || 'website',
          name: research.company_identity.name,
          registration,
          ...(op.content_key && registration ? { content_key: op.content_key } : {}),
          mode: review ? 'manual' : 'automatic',
          job_id: review?.job_id || item.job_id,
          ...(review ? { review } : {}),
        };
        const matched = this.feishu.acquisitionMatch(op.acquisition);
        if (matched.record_id || matched.conflict)
          return await this.finishAcquisitionMatch(op, matched);
      }
      // Recheck identity immediately before writing, including all record pages.
      matching = scopedIdentity ? [] : recordsForDomain(await this.feishu.records(), domain);
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
        return this.store.completeResearch(
          op,
          output,
          exclusionConditionsKey(input),
          item.source_url,
        );
      }
      if (matching.length && !item.target_record_id) {
        const output = this.output(op, {
          research,
          outcome: 'no_new_candidates',
          skipped: [{ domain, url: item.source_url }],
          reason: '研究期间已被其他任务收录',
        });
        return this.store.completeResearch(
          op,
          output,
          exclusionConditionsKey(input),
          item.source_url,
        );
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
          customer_id: 'web_' + (op.acquisition?.registration?.key || domain),
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
        : this.feishu.localFirst
          ? encodeCustomerFields(raw, definitions)
          : encodeResearchFields(raw, definitions);
      if (op.assessment) {
        fields[resolveCustomerField(definitions, '用户评级')] = assessmentRating(op.assessment);
        for (const [key, value] of Object.entries(assessmentSummaryFields(op.assessment)))
          if (definitions.some((field) => field.field_name === key && field.type === 1))
            fields[key] = value || null;
      }
      if (!Object.keys(fields).length) throw new Error('没有可更新字段');
      check();
      if (!old && !review) this.assertAutomaticIdentityIntegrity();
      // Persist intent before the remote side effect. Never auto-repeat an uncertain write.
      op.stage = 'persist';
      op.action = old ? 'update' : 'insert';
      op.recordId = old?.record_id;
      op.fields = fields;
      op.source_url = item.source_url;
      return await this.writePreparedAssessment(op);
    } catch (error) {
      if (error.code === 'ACQUISITION_INTERRUPTED' && signal?.reason === 'stopped') {
        return this.store.complete(
          op,
          this.output(op, {
            outcome: 'review',
            reason: '任务已停止，此候选保留已采集证据，等待核实',
          }),
        ).output;
      }
      if (recoverySignal(error)) throw error;
      if (op.stage === 'extract' && error.web_usage) op.web_usage = error.web_usage;
      if (unified && op.stage === 'extract' && error.collection_attempts) {
        op.collection_attempts = error.collection_attempts;
        op.incomplete_urls = error.incomplete_urls;
        op.research = {
          source_url: item.source_url,
          review_required: true,
          incomplete_reason: error.message,
        };
        return this.store.complete(
          op,
          this.output(op, {
            research: op.research,
            reason: error.message,
            outcome: 'review',
          }),
        ).output;
      }
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
        reason:
          modelFailure ||
          (error.status
            ? error.message
            : op.stage === 'extract'
              ? '官网采集未完成，未取得有效正文，未写入飞书'
              : '官网采集或研究失败，未写入飞书'),
      });
      this.store.complete(op, output);
      return output;
    } finally {
      this.active.delete(id);
    }
  }
  async paidRequest(op, kind, provider, request, onDispatch, send, source) {
    const key = createHash('sha256')
      .update(JSON.stringify([op.id, op.scope, kind, provider.provider, request]))
      .digest('hex');
    const requests = (op.paid_requests ||= {});
    const previous = requests[key];
    if (previous?.status === 'completed') return previous.response;
    if (previous?.status === 'failed') throw paidFailed();
    if (previous) throw paidUnknown();
    const entry = {
      id: key,
      kind,
      provider: provider.provider,
      status: 'pending',
      started_at: new Date().toISOString(),
      ...(source ? { source } : {}),
    };
    requests[key] = entry;
    if (kind === 'web_extract') {
      op.web_usage ||= { web_extract_calls: 0 };
      op.web_usage.web_extract_calls++;
      delete op.web_usage.web_extract_credits;
    }
    onDispatch?.();
    this.store.save(op);
    let response;
    try {
      response = await send(key);
    } catch (error) {
      const knownFailure =
        error.upstreamStatus >= 400 && error.upstreamStatus < 500 && error.upstreamStatus !== 408;
      entry.status = knownFailure ? 'failed' : 'unknown';
      this.store.save(op);
      if (!knownFailure) throw paidUnknown();
      throw paidFailed();
    }
    this.confirmPaidRequest(op, entry, response);
    return response;
  }
  confirmPaidRequest(op, entry, response) {
    entry.status = 'completed';
    entry.response = response;
    if (entry.kind.startsWith('model_')) addModelTokens(op.research_usage, response);
    if (Number.isFinite(response?.usage?.credits) && response.usage.credits >= 0)
      entry.usage = { credits: response.usage.credits };
    if (entry.kind === 'web_extract') {
      const extracts = Object.values(op.paid_requests).filter(({ kind }) => kind === 'web_extract');
      if (extracts.every(({ usage }) => usage))
        op.web_usage.web_extract_credits = extracts.reduce(
          (sum, { usage }) => sum + usage.credits,
          0,
        );
    }
    this.store.save(op);
  }
  async reconcilePaidRequests(op, { deferExternal = false } = {}) {
    for (const entry of Object.values(op.paid_requests || {})) {
      if (!['pending', 'unknown'].includes(entry.status)) continue;
      const service = entry.kind.startsWith('model_') ? this.providers.model : this.providers.web;
      if (entry.provider !== service.provider) {
        if (deferExternal && entry.kind === 'web_extract') continue;
        return false;
      }
      const lookup = await Promise.resolve()
        .then(() =>
          service.reconcile?.({
            id: entry.id,
            kind: entry.kind,
            signal: AbortSignal.timeout(3000),
          }),
        )
        .catch(() => null);
      if (lookup?.status === 'completed' && lookup.response) {
        this.confirmPaidRequest(op, entry, lookup.response);
      } else if (lookup?.status === 'failed') {
        entry.status = 'failed';
        this.store.save(op);
      } else {
        if (entry.status !== 'unknown') {
          entry.status = 'unknown';
          this.store.save(op);
        }
        if (!(deferExternal && entry.kind === 'web_extract')) return false;
      }
    }
    return true;
  }
  operationProgress(id) {
    const op = this.store.get(id);
    if (!op) return null;
    return {
      id: op.id,
      stage: op.stage,
      collection_attempts: op.collection_attempts || [],
      research_usage: op.research_usage,
      web_usage: op.web_usage,
      requests: paidRequestSummaries(op),
    };
  }
  async discoveryReady(id) {
    const op = this.store.get(id);
    return !op || this.reconcilePaidRequests(op);
  }
  async researchPageEvidence(
    page,
    op,
    {
      input,
      researchTarget,
      item,
      domain,
      conditionsKey,
      admissionVersion,
      unified,
      bypassExclusion,
      identityVersion,
      review,
      check = () => {},
    },
  ) {
    check();
    op.research_usage.input_chars += page.input_stats.inputChars;
    const prompt = companyResearchRequest(page, researchTarget);
    const request = {
      messages: prompt.messages,
      schema: unified ? websiteAdmissionResearchSchema : companyResearchSchema,
    };
    const cacheKey = researchCacheKey({
      ...request,
      identity:
        unified && this.providers.model.cacheIdentity
          ? {
              ...this.providers.model.cacheIdentity,
              admission_version: admissionVersion,
              evidence_version: acquisitionEvidenceVersion,
              ...(identityVersion
                ? { identity_version: identityVersion, subject: acquisitionUrl(item.source_url) }
                : {}),
              content_hashes: page.collection_attempts
                .filter((attempt) => attempt.status === 'ok')
                .map(({ final_url, content_hash }) => [final_url, content_hash]),
            }
          : this.providers.model.cacheIdentity,
    });
    if (identityVersion) {
      (op.research_trace ||= []).push({
        stage: 'extraction',
        request_key: cacheKey,
        admission_version: admissionVersion,
        identity_version: identityVersion,
        evidence_version: acquisitionEvidenceVersion,
        subject: acquisitionUrl(item.source_url),
        snapshot_ids: page.collection_attempts
          .filter((attempt) => attempt.status === 'ok')
          .map((attempt) => attempt.snapshot_id),
      });
    }
    let response, parsed;
    if (cacheKey && typeof this.store.modelResponse === 'function') {
      try {
        response = this.store.modelResponse(cacheKey);
        if (!response && !item.target_record_id && !bypassExclusion) {
          response = this.store.reviewResponse(conditionsKey, domain, cacheKey);
        }
        // Replay through today's evidence and policy checks, never cached
        // eligibility, scores, customer writes or a prior operation result.
        if (response) parsed = parseCompanyResearch(response, page, researchTarget);
      } catch {
        // Corrupt/obsolete cache data is not research evidence. A fresh
        // request may replace it; cache failure must not block valid research.
        response = undefined;
      }
    }
    const extractionFromCache = Boolean(parsed);
    if (identityVersion) op.research_trace.at(-1).reused = extractionFromCache;
    if (parsed) {
      op.research_usage.cache_hits++;
      op.research_usage.input_tokens ??= 0;
      op.research_usage.output_tokens ??= 0;
    } else {
      // Count attempts before the network call, including an unknown remote
      // outcome; this is not a claim that the provider charged a given amount.
      const start = () => {
        op.research_usage.model_calls++;
        if (item.target_record_id || bypassExclusion) this.store.save(op);
        else this.store.startModelAttempt(op, conditionsKey, domain);
      };
      if (op.recovery_version) {
        response = await this.paidRequest(
          op,
          'model_extraction',
          this.providers.model,
          [cacheKey, request],
          start,
          (id) => this.providers.model.research(request, { requestId: id }),
        );
      } else {
        start();
        response = await this.providers.model.research(request);
        addModelTokens(op.research_usage, response);
      }
      op.research_response = response;
      this.store.save(op);
      check();
      parsed = parseCompanyResearch(response, page, researchTarget);
    }
    let operatorFacts = [];
    if (review?.decision) {
      const { decision } = review;
      const { source_url, identity_quote, operating_quote, company_name, product, admission_fact } =
        decision;
      const normalize = (value) =>
        value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
      const origins = page.evidence_by_url?.get(source_url)?.origins || [];
      const contains = (quote) =>
        origins.some(({ text }) => normalize(text).includes(normalize(quote)));
      const identityMatches =
        !parsed.company_identity.name ||
        [
          parsed.company_identity.name,
          parsed.company_identity.website_name,
          ...parsed.company_identity.aliases,
        ].some((name) => subjectName(name) === subjectName(company_name));
      if (
        !contains(identity_quote) ||
        !contains(operating_quote) ||
        !identityMatches ||
        !normalize(identity_quote).includes(normalize(company_name)) ||
        !normalize(operating_quote).includes(normalize(product))
      ) {
        return {
          response,
          cacheKey,
          extractionFromCache,
          parsed: {
            ...parsed,
            product_match: 'unknown',
            review_required: true,
            reason: '人工裁定引文未能从本次官网快照核对，或与已取得的经营主体冲突',
          },
        };
      }
      const evidence = (field, value, quote) => ({
        field,
        value,
        quote,
        source_url,
        method: 'manual_review',
      });
      operatorFacts = [
        ...(!parsed.company_identity.name
          ? [evidence('company_name', company_name, identity_quote)]
          : []),
        ...(!parsed.company_identity.legal_name
          ? [evidence('legal_company_name', company_name, identity_quote)]
          : []),
        ...(parsed.entity_type === 'unknown'
          ? [evidence('entity_type', 'business', identity_quote)]
          : []),
        evidence('admission_facts', admission_fact, operating_quote),
        { ...evidence('products', product, operating_quote), window_use: 'window_covering' },
      ];
      parsed = parseCompanyResearch(response, page, researchTarget, undefined, operatorFacts);
    }
    if (
      parsed.product_match === 'matched' &&
      parsed.company_identity?.name &&
      ![parsed.customer_type_match, parsed.country_match, parsed.profile_match].includes(
        'not_matched',
      ) &&
      (unified
        ? parsed.eligibility?.status === 'eligible'
        : parsed.eligibility?.status !== 'rejected')
    ) {
      const sources = activitySources(parsed.facts, item.source_url, page.research_pages);
      let verdict = { result: 'uncertain', reason: '官网经营用途缺少可复核的原文', sources: [] };
      if (sources.length) {
        const trace = identityVersion && {
          stage: 'activity',
          versions: {
            admission_version: admissionVersion,
            identity_version: identityVersion,
            evidence_version: acquisitionEvidenceVersion,
            subject:
              verifiedRegistration(parsed.company_identity, parsed.facts)?.key ||
              acquisitionUrl(item.source_url),
          },
          snapshot_ids: [
            ...new Set(
              [
                ...sources,
                ...parsed.company_identity.evidence,
                ...parsed.facts.filter(({ field }) => field === 'admission_facts'),
              ]
                .map(({ snapshot_id }) => snapshot_id)
                .filter(Boolean),
            ),
          ],
        };
        if (trace) (op.research_trace ||= []).push(trace);
        try {
          verdict = await verifyCompanyActivity(
            this.providers.model,
            this.store,
            op.research_usage,
            sources,
            input,
            {
              name: parsed.company_identity.name,
              website: item.source_url,
              identity_evidence: parsed.company_identity.evidence
                .slice(0, 6)
                .map(({ value, quote, source_url }) => ({ value, quote, source_url })),
              ...(unified
                ? {
                    admission_evidence: parsed.facts
                      .filter((f) => f.field === 'admission_facts')
                      .map(({ value, quote, source_url }) => ({ value, quote, source_url })),
                  }
                : {}),
              homepage: page.research_pages
                .find(
                  (p) =>
                    domainKey(p.source_url) === domain && new URL(p.source_url).pathname === '/',
                )
                ?.text?.slice(0, 1200),
            },
            trace,
            op.recovery_version &&
              ((request, key) => {
                check();
                return this.paidRequest(
                  op,
                  'model_activity',
                  this.providers.model,
                  [key, request],
                  () => {
                    op.research_usage.model_calls++;
                    op.research_usage.input_chars += request.messages[1].content.length;
                  },
                  (id) => this.providers.model.research(request, { requestId: id }),
                );
              }),
          );
        } catch (error) {
          if (recoverySignal(error)) throw error;
          verdict.reason = '官网业务独立模型复核未完成，待重新核实';
        }
      }
      parsed = parseCompanyResearch(
        response,
        page,
        researchTarget,
        verdict.result === 'relevant' ? verdict.sources : [],
        operatorFacts,
      );
      parsed.activity_verification = {
        result: verdict.result,
        reason: verdict.reason,
        sources: verdict.sources.map(({ source_url, quote, snapshot_id, quote_offset }) => ({
          source_url,
          quote,
          ...(snapshot_id ? { snapshot_id, quote_offset } : {}),
        })),
      };
      if (verdict.result !== 'relevant' || parsed.product_match !== 'matched') {
        parsed.ok = false;
        parsed.product_match = verdict.result === 'unrelated' ? 'not_matched' : 'unknown';
        parsed.product_relation = { status: parsed.product_match, kind: null };
        parsed.review_required = parsed.product_match === 'unknown';
        parsed.reason = verdict.reason;
        parsed.assessment_opportunities = [];
      }
    }
    return { response, parsed, cacheKey, extractionFromCache };
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
    if (
      op.action === 'insert' &&
      op.admission_version === websiteAdmissionVersion &&
      (op.research?.eligibility?.status !== 'eligible' ||
        op.research?.product_match !== 'matched' ||
        op.research?.activity_verification?.result !== 'relevant' ||
        !['legal_name_self_reported', 'website_name_only'].includes(
          op.research?.company_identity?.status,
        ))
    )
      throw new Error('当前官网未通过主体与经营准入核对，停止入库');
    op.stage = 'persist';
    this.store.save(op);
    try {
      const written = await this.feishu.write(
        op.action,
        op.fields,
        op.recordId,
        op.clientToken,
        op.acquisition,
      );
      if (written.acquisition_conflict || written.acquisition_duplicate)
        return await this.finishAcquisitionMatch(op, {
          conflict: written.acquisition_conflict,
          record_id: written.record_id,
        });
      op.recordId = written.record_id;
      this.store.save(op);
      if (!(await this.verify(op))) throw new Error('客户档案保存后读回不一致');
      return await this.finishWritten(op);
    } catch (error) {
      if (error.code === identityIntegrityCode) throw error;
      if (this.feishu.localFirst && error.status >= 400 && error.status < 500)
        op.local_write_blocked = true;
      op.state = 'uncertain';
      this.store.save(op);
      throw conflict(
        op.stage === 'assessment'
          ? '客户资料已更新，最新评估保存待核对；勿重复研究'
          : this.feishu.localFirst
            ? '本地客户档案保存结果待核对，未重复保存'
            : '飞书写入结果待核对，未自动重复写入',
      );
    }
  }
  async verify(op) {
    if (!op.recordId) return false;
    const record = await this.feishu.record(op.recordId);
    if (op.acquisition && acquisitionUrl(customerWebsite(record)) !== acquisitionUrl(op.source_url))
      return false;
    if (domainKey(customerWebsite(record)) !== domainKey(op.source_url)) return false;
    const fields = this.feishu.localFirst
      ? op.fields
      : encodeCustomerFields(op.fields, await this.feishu.fields());
    return Object.entries(fields).every(([key, value]) => {
      if (['公司名称', '客户名称'].includes(key))
        return (
          fieldText(record.fields?.['公司名称'] || record.fields?.['客户名称']) === fieldText(value)
        );
      if (value === null) return fieldText(fieldValue(record.fields, key)) === '';
      const expected = Array.isArray(value)
        ? fieldText(value)
        : typeof value === 'object'
          ? value.link || value.text
          : value;
      if (typeof expected === 'number') return Number(fieldValue(record.fields, key)) === expected;
      return fieldText(fieldValue(record.fields, key)) === expected;
    });
  }
  async finishWritten(op) {
    op.recordVerifiedAt ||= new Date().toISOString();
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
    this.feishu.persist?.(op.recordId);
    const capture = op.acquisition && this.feishu.confirmAcquisition(op.recordId, op.id);
    if (capture) this.recordAcquisitionSource(op, op.recordId);
    const output = this.output(op, {
      research: op.research,
      row: {
        result: op.action === 'insert' ? 'inserted' : 'updated',
        source_url: op.source_url,
        record_id: op.recordId,
        ...(capture ? { capture } : {}),
      },
      reason: op.assessment
        ? op.assessment.incompleteReason
          ? '研究资料不足，已保存待核实评级与最新依据并核对'
          : '企业资料与当前评级已读回，最新评估依据已保存'
        : this.feishu.localFirst
          ? '客户档案已保存至本地数据库，飞书同步在后台核对'
          : op.action === 'insert'
            ? '飞书新增并读回核验成功'
            : '飞书更新并读回核验成功',
    });
    return this.store.completeResearch(
      op,
      output,
      exclusionConditionsKey(op.input.input),
      op.input.item.source_url,
    );
  }
  recordAcquisitionSource(op, recordId) {
    this.feishu.observeAcquisition(recordId, op.id, {
      ...op.acquisition,
      ...(op.discovery_sources?.length || op.input.item.discovery_sources?.length
        ? { discovery_sources: op.discovery_sources || op.input.item.discovery_sources }
        : {}),
      research_trace: op.research_trace,
      eligibility: op.research?.eligibility,
      activity: op.research?.activity_verification,
      opportunities: op.research?.assessment_opportunities,
      checked_at: new Date().toISOString(),
    });
  }
  previouslyVerifiedSubject(page, item, op, target) {
    const successful = page.collection_attempts.filter(({ status }) => status === 'ok');
    const hashes = [...new Set(successful.map(({ content_hash }) => content_hash))].sort();
    if (!hashes.length || !this.providers.model.cacheIdentity) return null;
    const key = researchCacheKey({
      messages: [hashes, target],
      schema: websiteAdmissionResearchSchema,
      identity: {
        ...this.providers.model.cacheIdentity,
        admission: op.admission_version,
        identity: op.identity_version,
        evidence: acquisitionEvidenceVersion,
        prompt: companyResearchRequest(page, target).messages[0].content,
      },
    });
    if (!key) return null;
    op.content_key = key;
    const domain = domainKey(item.source_url);
    for (const previous of this.feishu.acquisitionSourcesByContent(key)) {
      if (!previous.registration || domainKey(previous.source_url) === domain) continue;
      if (item.source_title && subjectName(item.source_title) !== subjectName(previous.name))
        continue;
      if (
        item.discovery_sources?.some(
          ({ kind, mentioned_company }) =>
            kind === 'maps' && subjectName(mentioned_company) !== subjectName(previous.name),
        )
      )
        continue;
      const locate = ({ quote, value, field }) =>
        [...page.evidence_by_url].flatMap(([source_url, page]) =>
          page.origins
            .filter(({ text }) => text.includes(quote))
            .map(({ text, snapshotId }) => ({
              field,
              value,
              quote,
              source_url,
              snapshot_id: snapshotId,
              quote_offset: text.indexOf(quote),
            })),
        )[0];
      const evidence = locate(previous.registration.evidence);
      const address = previous.registration.address_evidence;
      const address_evidence = address && locate(address);
      if (!evidence || (address && !address_evidence)) continue;
      op.acquisition = {
        operation_id: op.id,
        source_url: item.source_url,
        source_kind: item.source_kind || 'website',
        job_id: item.job_id,
        name: previous.name,
        registration: {
          ...previous.registration,
          evidence,
          ...(address_evidence ? { address_evidence } : {}),
        },
        content_key: key,
        mode: 'automatic',
      };
      op.research = {
        company_name: previous.name,
        facts: [evidence, address_evidence].filter(Boolean),
        checked_urls: page.checked_urls,
      };
      op.research_trace = [
        {
          stage: 'known_subject',
          request_key: key,
          subject: previous.registration.key,
          reused: true,
          snapshot_ids: successful.map(({ snapshot_id }) => snapshot_id),
        },
      ];
      op.research_usage.cache_hits++;
      return previous.record_id;
    }
    return null;
  }
  async finishAcquisitionMatch(op, match) {
    const source_url = op.acquisition.source_url;
    op.acquisition_match = match;
    this.store.save(op);
    if (match.record_id) {
      await this.feishu.record(match.record_id);
      if (op.acquisition.mode === 'automatic') this.assertAutomaticIdentityIntegrity();
      this.recordAcquisitionSource(op, match.record_id);
    } else {
      op.research.identity_conflict = match.conflict;
      op.research.review_required = true;
    }
    return this.store.complete(
      op,
      this.output(op, {
        research: op.research,
        outcome: match.record_id ? 'no_new_candidates' : 'review',
        reason: match.conflict || '经营主体已收录，已保留本次发现来源',
        row: {
          source_url,
          result: match.record_id ? 'duplicate' : 'manual_review',
          record_id: match.record_id,
        },
        skipped: match.record_id ? [{ url: source_url, domain: domainKey(source_url) }] : [],
      }),
    ).output;
  }
  async status(id, { isMaintaining = () => false, review, sourceUrl } = {}) {
    const op = this.store.get(id);
    if (!op) return { settled: false, missing: true, reason: '操作记录不存在，未自动重放' };
    if (op.state === 'completed') return { settled: true, output: op.output };
    if (this.active.has(id)) return { settled: false, reason: '仍在执行' };
    if (op.acquisition_match) {
      try {
        return {
          settled: true,
          output: await this.finishAcquisitionMatch(op, op.acquisition_match),
        };
      } catch {
        return { settled: false, reason: '既有本地档案尚未读回，未重复写入' };
      }
    }
    if (['persist', 'assessment'].includes(op.stage)) {
      this.active.add(id);
      try {
        if (op.stage === 'assessment' && op.recordVerifiedAt)
          return { settled: true, output: await this.finishWritten(op) };
        if (!op.recordId && op.acquisition) {
          op.recordId = this.feishu.acquisitionWrite(id);
          if (op.recordId) this.store.save(op);
          else if (
            op.stage === 'persist' &&
            this.feishu.localFirst &&
            op.recovery_version === 1 &&
            op.input.executionVersion === unifiedExecutionVersion &&
            op.identity_version === acquisitionIdentityVersion &&
            op.admission_version === websiteAdmissionVersion &&
            op.action === 'insert' &&
            (op.acquisition.mode === 'automatic' ||
              (op.acquisition.mode === 'manual' &&
                review &&
                sourceUrl === op.source_url &&
                op.acquisition.job_id === review.job_id &&
                canonicalJson(review) === canonicalJson(op.input.review || null) &&
                canonicalJson(review) === canonicalJson(op.acquisition.review || null))) &&
            op.acquisition.operation_id === id &&
            op.acquisition.source_url === op.source_url &&
            op.input.item?.source_url === op.source_url &&
            op.clientToken &&
            op.fields &&
            !op.local_write_blocked &&
            !isMaintaining()
          ) {
            if (op.acquisition.mode === 'automatic') this.assertAutomaticIdentityIntegrity();
            return { settled: true, output: await this.writePreparedAssessment(op) };
          }
        } else if (!op.recordId && op.action === 'insert') {
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
      } catch (error) {
        if (error.code === identityIntegrityCode) throw error;
        /* Preserve uncertainty when the read-back service is unavailable. */
      } finally {
        this.active.delete(id);
      }
      return { settled: false, reason: '写入尚未确认，未自动重试' };
    }
    if (this.beforeAcquisitionWrite(op)) {
      if (
        !op.recovery_version &&
        (op.research_usage?.model_calls > 0 || op.web_usage?.web_extract_calls > 0)
      )
        return {
          settled: false,
          paidUnknown: true,
          reason: '旧版付费请求缺少精确编号，结果待核对',
        };
      if (await this.reconcilePaidRequests(op, { deferExternal: true }))
        return { settled: false, resumeSafe: true, reason: '从原企业操作继续' };
      return { settled: false, paidUnknown: true, reason: '付费请求结果待供应商核对' };
    }
    const output = this.output(op, { reason: '服务在写入前中断；本次企业未入库' });
    if (['extract', 'research'].includes(op.stage) && !op.action && !op.fields)
      output.retryable_before_write = true;
    this.store.complete(op, output);
    return { settled: true, output };
  }
  beforeAcquisitionWrite(op) {
    return (
      op.input.executionVersion === unifiedExecutionVersion &&
      op.state !== 'completed' &&
      ['select', 'extract', 'research', 'prepare'].includes(op.stage) &&
      !op.acquisition_match &&
      !op.action &&
      !op.fields
    );
  }
  close() {
    this.assessments.close();
    this.supplements.close();
    this.store.close();
  }
}
