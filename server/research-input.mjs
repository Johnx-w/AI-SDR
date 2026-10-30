import { websiteTextExcerpt } from './website-metadata.mjs';
import { RESEARCH_GAP } from './research-text.mjs';

const CEILINGS = { maxPages: 5, maxPageChars: 16000, maxTotalChars: 80000 };
const highSurrogate = (value) => value >= 0xd800 && value <= 0xdbff;
const lowSurrogate = (value) => value >= 0xdc00 && value <= 0xdfff;
function safeHead(text, length) {
  let end = length;
  if (highSurrogate(text.charCodeAt(end - 1)) && lowSurrogate(text.charCodeAt(end))) end--;
  return text.slice(0, end);
}
function safeTail(text, length) {
  let start = text.length - length;
  if (lowSurrogate(text.charCodeAt(start)) && highSurrogate(text.charCodeAt(start - 1))) start++;
  return text.slice(start);
}
function excerpt(text, limit) {
  if (text.length <= limit) return text;
  if (limit <= RESEARCH_GAP.length + 1) return safeHead(text, limit);
  // Match websiteTextExcerpt's head/tail policy, with safe UTF-16 cut points.
  const tailLength = Math.min(4000, Math.floor(limit / 3));
  const head = safeHead(text, limit - tailLength - RESEARCH_GAP.length);
  const tail = safeTail(text, tailLength);
  return head && tail ? head + RESEARCH_GAP + tail : head || tail || safeHead(text, limit);
}
function urlKey(source) {
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

// This is a text budget, not a relevance filter or website fetcher. Consumers
// must use returned pages for both the model request and its quote audit; full
// website/contact metadata stays outside this module and is never overwritten.
// Counts and ceilings use UTF-16 code units, never split a valid surrogate pair.
export function boundedResearchPages(pages, options = {}) {
  if (!Array.isArray(pages)) throw new TypeError('研究页面必须是数组');
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new TypeError('研究正文预算必须是配置对象');
  const limits = { ...CEILINGS, ...options };
  for (const [key, maximum] of Object.entries(CEILINGS))
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum)
      throw new RangeError(`${key} 必须为 1–${maximum} 的整数`);
  const result = [];
  const seen = new Set();
  let inputChars = 0;
  let truncatedPages = 0;
  for (const page of pages) {
    if (result.length >= limits.maxPages || inputChars >= limits.maxTotalChars) break;
    if (!page || typeof page.source_url !== 'string' || typeof page.text !== 'string') continue;
    const source = page.source_url.trim();
    const key = urlKey(source);
    if (!key || seen.has(key)) continue;
    const text = websiteTextExcerpt(page.text, page.text.length);
    if (!text) continue;
    seen.add(key);
    const selected = excerpt(
      text,
      Math.min(limits.maxPageChars, limits.maxTotalChars - inputChars),
    );
    if (!selected) continue;
    if (selected.length < text.length) truncatedPages++;
    result.push({ source_url: source, text: selected });
    inputChars += selected.length;
  }
  return {
    pages: result,
    stats: {
      sourcePages: pages.length,
      selectedPages: result.length,
      inputChars,
      omittedPages: pages.length - result.length,
      truncatedPages,
    },
  };
}
