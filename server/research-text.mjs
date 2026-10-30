import { thirdPartyCompanySource } from './website-identity.mjs';

export const RESEARCH_GAP = '\n[...]\n';

// A quote must fit one retained source span, never cross a removed block.
export function researchEvidencePages(pages) {
  return pages.flatMap((page) =>
    String(page.text || '')
      .split(RESEARCH_GAP)
      .filter((text) => text.trim())
      .map((text) => ({ ...page, text })),
  );
}

export function compactResearchText(text, sourceUrl) {
  // Source disclaimers can span several paragraphs; do not hide them from the pre-screen.
  if (thirdPartyCompanySource({ url: sourceUrl, text })) return text;
  const lines = text.split('\n');
  const removed = new Set();
  const attributedLines = new Set();
  const legal =
    /\/(?:privacy(?:[-_/](?:policy|notice|statement))?|policies\/(?:privacy-policy|terms-of-service)|terms(?:[-_/](?:and|conditions|of|service|use))*|legal|impressum)\/?$/i.test(
      new URL(sourceUrl).pathname,
    );
  const attribution =
    /\b(?:news|articles?|partners?|competitors?|customer (?:says|reviews?|stories)|testimonials?|third[- ]party)\b|新闻|合作伙伴|客户评价|客户表示|竞争对手|第三方/i;
  const protectedText =
    /\b(?:company|ltd\.?|limited|llc|inc\.?|incorporated|corporation|trading as|dba|operated by|owned by|controller|registered|office|address|contact|we are|not|never|no longer|don['’]t|doesn['’]t|platform|supplier|suppl\w*|sell\w*|manufactur\w*|blinds?|shades?|curtains?|drapery|awnings?|shutters?|window|parts?|components?)\b|@|\+?\d[\d ()-]{6,}\d|公司|法人|经营|地址|联系|窗|帘|配件|不|未|第三方|平台/i;
  const postalText =
    /\b(?:write|mail|postal|street|avenue|boulevard|postcode|zip code)\b|\b\d{5}(?:-\d{4})?\b|\b[A-Z]\d[A-Z][ -]?\d[A-Z]\d\b|\b[A-Z]{1,2}\d[A-Z\d]?\s+\d[A-Z]{2}\b|邮寄|邮政|收件|路|街/i;
  const cookieControl =
    /^(?:accept all(?: cookies)?|reject all(?: cookies)?|cookie (?:settings|preferences)|manage (?:cookies|consent)|your privacy choices|同意所有Cookie|拒绝所有Cookie|Cookie设置)[.!。]*$/i;
  const legalTemplate =
    /\b(?:cookies?|personal (?:data|information)|browser|IP address|GDPR|CCPA|analytics|tracking technologies|data retention|opt[- ]out)\b|个人(?:信息|数据)|浏览器|数据保留|网站分析/i;
  let attributed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().replace(/^[#>*\s]+|[*_\s]+$/g, '');
    // Keep attribution headings with their following statement, even across controls.
    if (attribution.test(line)) attributed = true;
    if (attributed) attributedLines.add(i);
    if (
      !attributed &&
      !protectedText.test(line) &&
      !postalText.test(line) &&
      (cookieControl.test(line) || (legal && legalTemplate.test(line)))
    )
      removed.add(i);
    if (/[.!?。！？]$/.test(line)) attributed = false;
  }
  // Repeated short menu lists may surround different body sections. Keep one
  // copy per URL; never deduplicate statements, identity or attributed content.
  const menus = new Map();
  const menuLine = (i) =>
    i < lines.length &&
    !removed.has(i) &&
    !attributedLines.has(i) &&
    lines[i].trim().length > 0 &&
    lines[i].length <= 100 &&
    !/[.!?。！？@\d]/.test(lines[i]) &&
    !/\b(?:we|our|not|no|only|brand|company|ltd|inc|llc|registered|operated|owned|trading)\b|公司|品牌|法人|不|未/i.test(
      lines[i],
    );
  for (let i = 0; i + 2 < lines.length; i++) {
    if (![i, i + 1, i + 2].every(menuLine)) continue;
    const key = lines.slice(i, i + 3).join('\n');
    const prior = menus.get(key);
    if (prior === undefined) {
      menus.set(key, i);
      continue;
    }
    if (i - prior < 3) continue;
    let size = 3;
    while (prior + size < i && menuLine(i + size) && lines[prior + size] === lines[i + size])
      size++;
    for (let j = i; j < i + size; j++) removed.add(j);
    i += size - 1;
  }
  // Collapse only adjacent exact copies; unfamiliar or merely similar blocks stay intact.
  for (let i = 0; i < lines.length; i++) {
    if (removed.has(i)) continue;
    for (let size = 1; size <= Math.min(12, Math.floor((lines.length - i) / 2)); size++) {
      const block = lines.slice(i, i + size).join('\n');
      // Short repeated labels can be a parent category followed by its submenu.
      if (!block.trim() || (size === 1 && block.trim().length < 20) || attribution.test(block))
        continue;
      let end = i + size;
      while (end + size <= lines.length && lines.slice(end, end + size).join('\n') === block) {
        for (let j = end; j < end + size; j++) removed.add(j);
        end += size;
      }
      if (end > i + size) break;
    }
  }
  const spans = [];
  let span = [];
  for (let i = 0; i < lines.length; i++) {
    if (!removed.has(i)) span.push(lines[i]);
    else if (span.length) {
      spans.push(span.join('\n'));
      span = [];
    }
  }
  if (span.length) spans.push(span.join('\n'));
  const selected = spans.filter((part) => part.trim()).join(RESEARCH_GAP);
  return selected && selected.length < text.length ? selected : text;
}
