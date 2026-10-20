import { websiteTextExcerpt } from './website-metadata.mjs';
// Keep n8n Code helpers self-contained: their source is deployed into its sandbox.
export function improveCandidateSelection(original) {
  if (original.includes('candidate_urls:')) return original;
  if (
    !original.includes('const MAX = 1;') ||
    !original.includes('return selected.length ? selected :')
  )
    throw new Error('候选筛选节点结构已变化，请人工检查后再更新');
  return original.replace('const MAX = 1;', 'const MAX = 3;').replace(
    'return selected.length ? selected :',
    `return selected.length ? [{ json: {
  ...selected[0].json,
  candidates: selected.map(item => item.json),
  candidate_urls: selected.map(item => item.json.source_url),
  skipped_existing_count: skippedExisting.length,
  skipped_existing: skippedExisting,
}, pairedItem: selected[0].pairedItem }] :`,
  );
}

export function checkExtractedCandidates(selection, responses) {
  const candidates = selection.candidates || [selection];
  const pages = responses.flatMap((response) => {
    const data = response.body || response;
    return Array.isArray(data.results) ? data.results : [];
  });
  const failures = responses.flatMap((response) => {
    const data = response.body || response;
    return Array.isArray(data.failed_results) ? data.failed_results : [];
  });
  const normalize = (value) =>
    String(value || '')
      .replace(/^https?:\/\//i, '')
      .replace(/^www\./i, '')
      .replace(/\/+$/, '');
  const checkedUrls = candidates.map((candidate) => candidate.source_url).filter(Boolean);
  const failedPages = [];
  for (const candidate of candidates) {
    const page = pages.find((item) => normalize(item.url) === normalize(candidate.source_url));
    const raw = typeof page?.raw_content === 'string' ? page.raw_content.trim() : '';
    const excerpt = websiteTextExcerpt(raw);
    if (excerpt) {
      return {
        has_text: true,
        source_url: candidate.source_url,
        source_title: candidate.source_title,
        page_text: excerpt,
        page_text_length: raw.length,
        checked_urls: checkedUrls,
        extract_failures: failedPages,
      };
    }
    const failure = failures.find(
      (item) => normalize(item.url) === normalize(candidate.source_url),
    );
    failedPages.push({
      source_url: candidate.source_url,
      reason: failure?.error || '未返回正文或正文为空',
    });
  }
  const requestError = responses
    .map((response) => response.body || response)
    .find((response) => response.error || response.detail || response.message);
  return {
    has_text: false,
    stage: 'extract',
    reason: requestError
      ? 'Tavily Extract 请求出错：' +
        JSON.stringify(requestError.error || requestError.detail || requestError.message)
      : '本次候选网页均未能读取正文：' +
        failedPages.map((page) => page.source_url + ' - ' + page.reason).join('; '),
    source_url: selection.source_url || null,
    checked_urls: checkedUrls,
    extract_failures: failedPages,
  };
}

export function summarizeAcquisition(inputs, research, selection, executionId) {
  const rows = inputs.filter((item) => item && typeof item.result === 'string');
  const count = (kind) => rows.filter((item) => item.result === kind).length;
  const inserted = count('inserted');
  const updated = count('updated');
  const failed = count('failed');
  const review = count('manual_review');
  const success = inserted + updated;
  const outcome = success
    ? failed || review
      ? 'partial'
      : 'completed'
    : failed
      ? 'failed'
      : review
        ? 'review'
        : research.stage === 'select'
          ? 'no_new_candidates'
          : 'failed';
  return {
    outcome,
    execution_id: String(executionId || ''),
    新增: inserted,
    更新: updated,
    失败: failed,
    待人工查重: review,
    reason: success
      ? `飞书已新增 ${inserted} 条、更新 ${updated} 条。`
      : research.reason ||
        rows.find((row) => row.reason)?.reason ||
        '未获得可入库的客户，请检查执行记录。',
    stage: rows.length ? 'persist' : research.stage || 'unknown',
    skipped_existing_count: selection.skipped_existing_count || 0,
    skipped_existing: selection.skipped_existing || [],
    checked_urls: research.checked_urls || selection.candidate_urls || selection.checked_urls || [],
    research,
    明细: rows,
  };
}

export const extractCheckCode = `${websiteTextExcerpt.toString()}\n${checkExtractedCandidates.toString()}
return [{json: checkExtractedCandidates($('选择一个独立企业官网').first().json, $input.all().map(i => i.json))}];`;

export const acquisitionSummaryCode = `${summarizeAcquisition.toString()}
let extraction = {};
try { const page = $('检查正文').first().json; extraction = { checked_urls: page.checked_urls, extract_failures: page.extract_failures }; } catch (_) {}
return [{json: summarizeAcquisition($input.all().map(i => i.json), {...$('最终结果').first().json, ...extraction}, $('选择一个独立企业官网').first().json, $execution.id)}];`;
