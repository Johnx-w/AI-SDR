import { researchPageText } from './research-pages.mjs';
import { compactResearchText, RESEARCH_GAP } from './research-text.mjs';

const budget = 16000;
const anchor =
  /\b(?:operat\w+|legal|registered|suppl\w*|manufactur\w+|purchase|distribut\w+|install\w+|produc\w+|custom|solely|exhibitor|third[- ]party|site|not|no|blinds?|shades?|curtains?|drapery|awnings?|shutters?)\b|经营|法人|制造|生产|经销|安装|采购|展商|第三方|窗帘|遮阳|没有|不提供/i;

export const acquisitionEvidenceVersion = 'acquisition-evidence-v1';

export function selectAcquisitionEvidence(source_url, content) {
  const raw = researchPageText(content, content.length);
  const text = compactResearchText(raw, source_url);
  if (text.length <= budget) return { source_url, text };
  const lines = text.split('\n');
  const chosen = new Set();
  let available = budget;
  const add = (index) => {
    if (chosen.has(index) || !lines[index]) return true;
    const length = lines[index].length + RESEARCH_GAP.length;
    if (length > available) return false;
    available -= length;
    chosen.add(index);
    return true;
  };
  // Keep unfiltered bookends for unfamiliar evidence, then retain context around
  // promising middle-page evidence without joining across an omission.
  for (let index = 0; index < lines.length && available > 11000; index++) {
    if (!add(index)) break;
  }
  for (let index = lines.length - 1; index >= 0 && available > 8500; index--) {
    if (!add(index)) break;
  }
  let recovered = false;
  for (let index = 0; index < lines.length; index++) {
    if (chosen.has(index) || !anchor.test(lines[index]) || !add(index)) continue;
    recovered = true;
    for (let neighbor = index - 2; neighbor <= index + 2; neighbor++) add(neighbor);
  }
  if (!recovered) return { source_url, text };
  const spans = [];
  let previous = -2;
  for (const index of [...chosen].sort((a, b) => a - b)) {
    if (previous + 1 === index) spans[spans.length - 1] += '\n' + lines[index];
    else spans.push(lines[index]);
    previous = index;
  }
  return { source_url, text: spans.join(RESEARCH_GAP) };
}
