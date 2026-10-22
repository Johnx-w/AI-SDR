import { randomUUID } from 'node:crypto';
import { acquisitionConfig, platformJson } from './acquisition-config.mjs';
import { AcquisitionStore } from './acquisition-store.mjs';
import { FeishuClient, encodeResearchFields, recordsForDomain } from './feishu-direct.mjs';
import { fieldText } from './feishu.mjs';
import { domainKey } from './website-identity.mjs';
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
];

export function selectWebsiteCandidates(results, knownDomains = [], limit = 20) {
  const known = new Set(knownDomains),
    seen = new Set(),
    candidates = [],
    skipped = [];
  for (const result of results) {
    const url = websiteUrl(result?.url);
    if (!url) continue;
    const domain = domainKey(url.href);
    if (
      blockedHosts.test(url.hostname) ||
      /gazette|herald|tribune|chronicle|newspaper|news\.co/i.test(url.hostname) ||
      blockedMedia.some((host) => domain === host || domain.endsWith('.' + host)) ||
      /directory|findglocal|word-of-mouth|superpages/i.test(url.hostname) ||
      /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar)$/i.test(url.pathname) ||
      /\/(jobs?|careers?|vacanc[^/]*|employment|news|wiki|directory|listings?)(\/|$)/i.test(
        url.pathname,
      )
    )
      continue;
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

export class NativeAcquisition {
  constructor({
    env,
    fetchImpl = fetch,
    readPage = readPublicHtml,
    feishu,
    store,
    assessments,
  } = {}) {
    this.env = env;
    this.fetch = fetchImpl;
    this.readPage = readPage;
    this.feishu = feishu || new FeishuClient({ env, fetchImpl });
    this.store =
      store ||
      new AcquisitionStore(
        env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH || ':memory:',
        String(env.FEISHU_APP_TOKEN) + '/' + String(env.FEISHU_TABLE_ID),
      );
    this.active = new Set();
    this.assessments = assessments || new AssessmentService({ env, feishu: this.feishu });
  }
  assessmentInfo() {
    return { ruleVersion: ASSESSMENT_RULE_VERSION, markets, customs: 'not_connected' };
  }
  decorateLeads(data) {
    this.assessments.start();
    return {
      ...data,
      leads: data.leads.map((lead) => {
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
          return lead;
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
        ].map(readable);
        const manualOverride = assessmentRating(stored) !== lead.grade;
        return {
          ...lead,
          score: stored.score,
          ratingReason: lead.ratingReason || stored.reason,
          facts,
          assessment: {
            id: stored.id,
            ruleVersion: stored.ruleVersion,
            evaluatedAt: stored.evaluatedAt,
            score: stored.score,
            grade: manualOverride ? (lead.grade === '未评级' ? null : lead.grade) : stored.grade,
            status: manualOverride ? '主表评级已修改；原自动结果保留在历史中' : stored.status,
            complete: stored.complete,
            manualOverride,
            product: stored.product,
            direction: stored.direction,
            evidenceReason: formatAssessmentEvidence(stored),
            incompleteReason: stored.incompleteReason,
            missing: stored.missing,
            dimensions: Object.fromEntries(
              Object.entries(stored.dimensions).map(([k, d]) => [
                k,
                { score: d.score, maximum: d.maximum, missing: d.missing },
              ]),
            ),
            sync: stored.sync,
          },
        };
      }),
    };
  }
  async assessRecord(recordId, body, operationId) {
    const definitions = await this.feishu.fields();
    for (const [name, type] of [
      ['用户评级', 3],
      ['最近研究时间', 5],
    ])
      if (!definitions.some((field) => field.field_name === name && field.type === type))
        throw Object.assign(new Error('请先完成T2评分字段配置：' + name), { status: 503 });
    await this.assessments.table();
    const pending = this.assessments.store
      .history(recordId)
      .find((entry) => entry.historyStatus !== 'synced');
    if (pending && pending.id !== assessmentId(this.assessments.scope, operationId))
      throw Object.assign(new Error('该客户上次T12历史尚待同步，请在评估历史中先核对'), {
        status: 409,
      });
    const record = await this.feishu.record(recordId);
    const countryValue = body.country || fieldText(record.fields?.['国家']);
    const country = markets.find(
      (m) => normalizeCountry(m.value) === normalizeCountry(countryValue),
    )?.value;
    if (!country)
      throw Object.assign(new Error('请在研究评级表单中选择已支持的企业国家'), { status: 400 });
    const product =
      body.product ||
      fieldText(record.fields?.['相关产品']).split('\n').filter(Boolean).slice(0, 4).join(', ');
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
    const source_url = fieldText(record.fields?.['来源链接']);
    return this.research(input, {
      source_url,
      operation_id: operationId,
      target_record_id: recordId,
    });
  }
  assessmentHistory(recordId) {
    return { assessments: this.assessments.history(recordId) };
  }
  async retryAssessment(recordId, id) {
    const result = await this.assessments.retry(recordId, id);
    const operation = this.store.byAssessment(id);
    if (operation && operation.recordId === recordId && operation.state !== 'completed')
      await this.status(operation.id);
    return result;
  }
  ensureConfigured() {
    const config = acquisitionConfig(this.env);
    if (!config.nativeReady)
      throw Object.assign(new Error('后端直连配置缺失：' + config.missing.join('、')), {
        status: 503,
      });
  }
  async tavily(path, body) {
    const data = await platformJson(
      this.fetch,
      'https://api.tavily.com/' + path,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + this.env.TAVILY_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(path === 'extract' ? 60000 : 30000),
      },
      'Tavily',
    );
    if (!Array.isArray(data.results))
      throw Object.assign(new Error('Tavily 未返回有效结果'), { status: 502 });
    return data;
  }
  async discover(input, search, seen = []) {
    input = { ...input, ...validateTarget(input) };
    if (search?.country && !input.market_countries.includes(search.country))
      throw Object.assign(new Error('搜索国家不在当前支持的市场范围内'), { status: 400 });
    this.ensureConfigured();
    const records = await this.feishu.records();
    const known = records.map((r) => domainKey(fieldText(r.fields?.['来源链接']))).filter(Boolean);
    const excluded = [...new Set([...known, ...seen])];
    const data = await this.tavily('search', {
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
      source: 'tavily',
      usage: data.usage,
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
        extracted = await this.tavily('extract', {
          urls: [...new Set(selected)].slice(0, 5),
          extract_depth: 'basic',
          format: 'markdown',
        });
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
      const text = researchPageText(page.content, 16000);
      if (text && !researchPages.has(page.url))
        researchPages.set(page.url, { source_url: page.url, text });
    }
    if (!researchPages.size) throw new Error('官网页面均未取得正文，未调用模型或写入');
    return {
      source_url: initial.href,
      research_pages: [...researchPages.values()],
      page_text: [...researchPages.values()].map((p) => p.text).join('\n'),
      website_metadata: combineWebsiteEvidence(pages),
      checked_urls: [...researchPages.keys()],
    };
  }
  output(operation, { research = {}, row, reason, outcome, skipped = [] } = {}) {
    const inserted = row?.result === 'inserted' ? 1 : 0;
    const updated = row?.result === 'updated' ? 1 : 0;
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
      if (matching.length && !item.target_record_id) {
        const output = this.output(op, {
          outcome: 'no_new_candidates',
          reason: '该企业已在飞书收录',
          skipped: [{ domain, url: item.source_url }],
        });
        this.store.complete(op, output);
        return output;
      }
      if (item.target_record_id && blockedHosts.test(new URL(item.source_url).hostname))
        return await this.persistIncompleteAssessment(
          op,
          input,
          item,
          '现有来源为第三方平台页面，尚未核实企业独立官网，本轮不据此判定高等级',
          [],
        );
      op.stage = 'extract';
      this.store.save(op);
      const page = await this.collect(item.source_url);
      op.stage = 'research';
      op.checked_urls = page.checked_urls;
      op.research_pages = page.research_pages;
      op.evidence = page.website_metadata;
      this.store.save(op);
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
      const prompt = companyResearchRequest(page, input);
      const response = await platformJson(
        this.fetch,
        'https://api.deepseek.com/responses',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + this.env.DEEPSEEK_API_KEY,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(180000),
          body: JSON.stringify({
            model: this.env.DEEPSEEK_MODEL || 'deepseek-flash',
            input: prompt.messages,
            max_output_tokens: 16000,
            reasoning: { effort: 'none' },
            temperature: 0,
            store: false,
            text: {
              format: {
                type: 'json_schema',
                name: 'company_research',
                strict: true,
                schema: companyResearchSchema,
              },
            },
          }),
        },
        'DeepSeek',
      );
      op.research_response = response;
      this.store.save(op);
      const research = {
        ...parseCompanyResearch(response, page, input),
        checked_urls: page.checked_urls,
      };
      op.research = research;
      op.evidence = page.website_metadata;
      op.research_pages = page.research_pages;
      op.usage = response.usage;
      this.store.save(op);
      if (
        (!research.ok || research.eligibility?.status !== 'eligible' || !research.company_name) &&
        !item.target_record_id
      ) {
        const output = this.output(op, {
          research,
          ...(research.review_required ? { outcome: 'review' } : {}),
          reason: research.reason || '官网企业名称缺乏可验证证据',
        });
        this.store.complete(op, output);
        return output;
      }
      if (item.target_record_id && !research.company_name)
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
        ...researchFields(research, page.website_metadata, old?.fields || {}, page.research_pages),
        来源链接: item.source_url,
        最近研究时间: Date.now(),
      };
      if (old) raw = mergeResearchFields(old.fields, raw);
      else
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
        definitions.some((f) => f.field_name === '用户评级' && f.type === 3)
      ) {
        await this.assessments.table();
        op.assessment = assessCompany({
          research,
          target: input,
          id: assessmentId(this.assessments.scope, op.id),
        });
        if (definitions.some((f) => f.field_name === '评级依据' && f.type === 1))
          raw['评级依据'] = op.assessment.reason;
        // Unknowns have an explicit status rather than a blank or a fabricated C grade.
        raw['用户评级'] = assessmentRating(op.assessment);
      }
      const fields = item.phone_only
        ? Object.fromEntries(
            Object.entries(raw).filter(([key]) =>
              definitions.some((f) => f.field_name === key && f.type === 1),
            ),
          )
        : encodeResearchFields(raw, definitions);
      if (op.assessment) fields['用户评级'] = assessmentRating(op.assessment);
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
            ? 'T2已更新，T12历史同步待核对；完整评估已保存，勿重复研究'
            : '飞书写入结果待核对，已暂停且未自动重试',
        );
      }
      if (item.target_record_id && ['extract', 'research'].includes(op.stage))
        return await this.persistIncompleteAssessment(
          op,
          input,
          item,
          op.research_response?.status === 'incomplete'
            ? 'AI研究输出达到长度上限，未取得完整可验证结果'
            : error.status
              ? error.message
              : '官网采集或研究未完成，本轮未取得足够评分依据',
          op.checked_urls || [],
        );
      const output = this.output(op, {
        research: op.research || {},
        reason: error.status ? error.message : '官网采集或研究失败，未写入飞书',
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
      domainKey(fieldText(customer.fields?.['来源链接'])) !== domainKey(item.source_url)
    )
      throw conflict('未完成研究的客户主体不一致，停止写入');
    await this.assessments.table();
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
    op.assessment = assessCompany({
      research: op.research,
      target: input,
      id: assessmentId(this.assessments.scope, op.id),
    });
    op.action = 'update';
    op.recordId = item.target_record_id;
    op.source_url = item.source_url;
    op.fields = {
      用户评级: assessmentRating(op.assessment),
      最近研究时间: Date.parse(op.assessment.evaluatedAt),
    };
    const fields = await this.feishu.fields();
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
          ? 'T2已更新，T12历史同步待核对；勿重复研究'
          : '飞书写入结果待核对，未自动重复写入',
      );
    }
  }
  async verify(op) {
    if (!op.recordId) return false;
    const record = await this.feishu.record(op.recordId);
    if (domainKey(fieldText(record.fields?.['来源链接'])) !== domainKey(op.source_url))
      return false;
    return Object.entries(op.fields).every(([key, value]) => {
      if (value === null) return fieldText(record.fields?.[key]) === '';
      const expected = typeof value === 'object' ? value.link || value.text : value;
      if (typeof expected === 'number') return Number(record.fields?.[key]) === expected;
      return fieldText(record.fields?.[key]) === expected;
    });
  }
  async finishWritten(op) {
    op.recordVerifiedAt ||= new Date().toISOString();
    if (op.assessment) {
      op.stage = 'assessment';
      this.store.save(op);
      this.assessments.start();
      await this.assessments.sync(op.assessment, op.recordId);
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
          ? '研究资料不足，已记录待核实评级与T12历史并读回'
          : '企业研究、T2评级与T12评估历史均已完成并读回'
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
      const found = await this.discover(input, searchPlan(input)[0]);
      if (!found.candidates.length) {
        const output = this.output(op, {
          outcome: 'no_new_candidates',
          skipped: found.skipped_existing,
          reason: '本次搜索没有新的独立企业官网',
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
    this.assessments.close();
    this.store.close();
  }
}
