import { websiteTextExcerpt } from './website-metadata.mjs';
export function researchPageText(content, limit = 16000) {
  let text = String(content || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(?:title|noscript|p|div|li|section|h[1-6])>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) =>
      String.fromCodePoint(
        Math.min(0x10ffff, n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)),
      ),
    )
    .replace(/[\t ]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
  return websiteTextExcerpt(text, limit);
}

// Collection quality is independent of product relevance and page length.
export function hasUsableResearchText(text, content = text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim().replace(/^[#>*\s]+|[*_\s]+$/g, ''))
    .filter((line) => /[\p{L}\p{N}]/u.test(line));
  if (!lines.length) return false;
  const blocker = (line) =>
    /^(?:(?:you need to|please)\s+)?enable javascript(?: and cookies)?(?:\s+(?:to|in)\b[^.!?]*)?[.!]*$/i.test(
      line,
    ) ||
    /^(?:checking your browser|verifying (?:you are human|your browser)|verify you are human|performing security verification)\b[^.!?]*[.!?]*$/i.test(
      line,
    ) ||
    /^(?:access denied|sorry,? you have been blocked)[.!]*$/i.test(line);
  const placeholder = (line) =>
    /^(?:loading|please wait|just a moment)[\s.!…]*$/i.test(line) || blocker(line);
  const markers = lines.filter(placeholder).length;
  if (!markers) return true;
  const controls = (line) =>
    /^(?:skip to (?:main )?content|cancel|close|edit|success|return to ticket|(?:start|complete) order editing|(?:add|remove)(?: original order)? discount|your order has been edited successfully|your request completed successfully|the replacement order will be charged at full price\..*)[.!]*$/i.test(
      line,
    );
  const remaining = lines.filter((line) => !placeholder(line) && !controls(line));
  if (!remaining.length) return false;
  // shortcut: unknown shells are retained; add a fixture when another placeholder is observed.
  const controlCount = lines.filter(controls).length;
  const independentProse =
    remaining.some((line) => /[\p{L}\p{N}][.。?？](?:\s|$)/u.test(line)) ||
    [...content.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)].some((match) =>
      remaining.includes(researchPageText(match[2], match[2].length)),
    );
  const headings = [...content.matchAll(/<(title|h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((match) =>
    researchPageText(match[2], match[2].length),
  );
  if (lines.some(blocker) && remaining.every((line) => headings.includes(line))) return false;
  return !(markers > 1 && controlCount > remaining.length && !independentProse);
}
