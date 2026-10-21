// Product-relevance gating shared by the pre-AI page screen and the post-AI audit.
// The broad page screen saves model calls; the final audit must match the target category.

// Strong industry phrases: unambiguous architectural shading terminology.
const strongPhrases = [
  /zip\s?[- ]?(?:screen|track|blind|shade|curtain)/i,
  /outdoor\s+(?:blind|screen|shade|shutter|awning|roller|curtain)/i,
  /external\s+(?:blind|screen|shade|shutter|awning|roller)/i,
  /exterior\s+(?:blind|screen|shade|shutter|awning|roller)/i,
  /patio\s+(?:screen|blind|shade|awning|cover|roller)/i,
  /retractable\s+(?:screen|blind|awning|shade|roof|awning)/i,
  /motori[sz]ed\s+(?:screen|blind|shade|awning|shutter|roller)/i,
  /electric\s+(?:blind|screen|shade|awning|shutter)/i,
  /remote\s?[- ]?controlled\s+(?:blind|screen|awning|shade)/i,
  /folding\s+arm/i,
  /full\s+cassette/i,
  /cassette\s+(?:awning|blind|shade)/i,
  /pergola/i,
  /shade\s?sail/i,
  /solar\s+(?:screen|shade|shading)/i,
  /roller\s+(?:shutter|blind)/i,
  /plantation\s+shutter/i,
  /(?:insect|fly|bug)\s+screen/i,
  /window\s+(?:shade|shutter|blind|screen|furnishing|covering)/i,
  /venetian\s+blind/i,
  /roman\s+(?:blind|shade)/i,
  /cellular\s+(?:blind|shade)/i,
  /zebra\s+blind/i,
  /vertical\s+blind/i,
  /conservatory\s+(?:blind|roof|shade)/i,
  /verand(?:a|ah)\s+(?:blind|screen|shade)/i,
  /alfresco\s+(?:blind|screen|shade)/i,
  /café?\s+blind/i,
  /outdoor\s+living\s+(?:space|area|solution)/i,
  /outdoor\s+(?:space|area|room)s?\s+(?:screen|shade|blind)/i,
  /lanai\s+(?:screen|shade|enclosure)/i,
  /hurricane\s+(?:screen|shade|shutter)/i,
  /security\s+(?:door\s+)?screen/i,
  /window\s+furnishing/i,
  /遮阳[篷棚帘网]|百叶[窗帘]?|窗帘|纱窗|卷帘|凉[亭棚]|拉链[帘轨]|防风帘|天幕/i,
];

// Generic single words that alone do not prove industry relevance.
const genericWords = new Set([
  'awning',
  'awnings',
  'blind',
  'blinds',
  'screen',
  'screens',
  'shade',
  'shades',
  'shading',
  'curtain',
  'curtains',
  'pergola',
  'pergolas',
  'canopy',
  'canopies',
  'shutter',
  'shutters',
  'furniture',
  'outdoor',
]);

const word = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Parse the comma-separated target product list into normalized phrases.
export function targetProductTerms(product = '') {
  return String(product)
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p && p.length <= 120);
}

// Match a target phrase inside text with whitespace tolerance and plural forms.
function phraseMatches(text, phrase) {
  const tokens = phrase.split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  const pattern = tokens
    .map(
      (t, i) =>
        word(t).replace(/(?:ies)$/, '(?:y|ies)') +
        (i === tokens.length - 1 && !/s$/.test(t) ? 's?' : /s$/.test(t) ? '?' : ''),
    )
    .join('\\s*');
  return new RegExp('(^|[^\\p{L}])' + pattern + '($|[^\\p{L}])', 'iu').test(text);
}

// Score page text against the target products and the industry lexicon.
export function pageRelevance(text, target = {}) {
  const content = String(text || '');
  if (content.length < 80) return { relevant: false, score: 0, matched: [] };
  const matched = [];
  const hit = (label) => {
    if (!matched.includes(label)) matched.push(label);
  };
  // 1. Strong industry phrase anywhere in the page.
  for (const pattern of strongPhrases) if (pattern.test(content)) hit(pattern.source);
  // 2. Target product phrases (multi-word phrases are specific enough to prove relevance).
  const terms = targetProductTerms(target.product);
  const multiWord = terms.filter((t) => t.includes(' '));
  const single = terms.filter((t) => !t.includes(' ') && !genericWords.has(t));
  for (const phrase of multiWord) if (phraseMatches(content, phrase)) hit(phrase);
  for (const term of single) if (phraseMatches(content, term)) hit(term);
  // 3. Generic target words (e.g. "awnings") count only in the plural-plus-one form:
  //    at least two distinct generic product words must appear together.
  const genericHits = terms
    .flatMap((t) => t.split(/\s+/))
    .filter((t) => genericWords.has(t))
    .filter((t) => phraseMatches(content, t));
  if (new Set(genericHits).size >= 2) hit(genericHits.join(' + '));
  return { relevant: matched.length > 0, score: matched.length, matched };
}

// Categories are separate: an indoor blind must not satisfy an outdoor zip screen target.
const categories = [
  ['zip', /zip\s*[- ]?(?:screen|track|blind|shade)|zipscreen|ziptrak|防风帘|拉链帘|防风卷帘/i],
  ['pergola', /pergola|凉亭|凉棚/i],
  ['cassette', /full\s+cassette|全盒曲臂/i],
  ['awning', /awning|shade\s*sail|天幕|遮阳[篷棚]/i],
  ['roman', /roman\s+(?:blind|shade)|罗马帘/i],
  ['zebra', /zebra\s+(?:blind|shade)|斑马帘/i],
  ['cellular', /(?:cellular|honeycomb)\s+(?:blind|shade)|蜂巢帘/i],
  ['venetian', /venetian\s+blind|百叶帘|威尼斯百叶/i],
  ['shutter', /(?:plantation\s+)?shutter|百叶窗|板式百叶/i],
  ['fabric', /(?:fabric\s+)?curtain|draper|布艺帘|窗帘布/i],
  ['roller', /roller\s+(?:blind|shade)|卷帘/i],
  ['shangrila', /shangri[- ]?la|香格里拉帘/i],
  ['dream', /dream\s+curtain|sheer\s+vertical|梦幻帘/i],
  ['vertical', /vertical\s+blind|垂直帘/i],
];
const partsPattern =
  /\b(?:components?|parts?|motors?|brackets?|headrails?|springs?)\b|配件|零件|电机|制头|弹簧|安装码/i;
function productCategories(text) {
  let found = categories.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
  if (/roller\s+shutter|rolling\s+shutter|卷闸|卷门/i.test(text))
    found = found.filter((id) => id !== 'shutter');
  if (/outdoor|exterior|external|室外|户外/i.test(text))
    found = found.filter((id) => !['roller', 'fabric', 'venetian', 'shutter'].includes(id));
  // Specific names override generic substrings in bilingual descriptions.
  if (found.includes('zip')) return ['zip'];
  if (found.includes('dream')) return ['dream'];
  if (found.includes('shangrila')) return ['shangrila'];
  if (found.includes('cassette')) return ['cassette', 'awning'];
  return found;
}

// Post-AI audit: only verified product facts enter here, never arbitrary page keywords.
export function productsRelevant(products, target = {}) {
  const list = (Array.isArray(products) ? products : []).filter(
    (p) => typeof p === 'string' && p.trim(),
  );
  const terms = targetProductTerms(target.product);
  // No target product constraint (e.g. direct unit-test calls) means unrestricted.
  if (!terms.length) return 'unrestricted';
  if (!list.length) return 'unknown';
  for (const term of terms) {
    const wanted = productCategories(term);
    const needsParts = partsPattern.test(term);
    const outdoorParts = needsParts && /outdoor|室外|户外/i.test(term);
    const indoorParts = needsParts && /indoor|室内/i.test(term);
    for (const product of list) {
      if (
        /\b(?:vehicle|caravan|4x4|camping|marine|boat|rv)\b|房车|车载|汽车/i.test(product) &&
        !/\b(?:vehicle|caravan|4x4|camping|marine|boat|rv)\b|房车|车载|汽车/i.test(term)
      )
        continue;
      if (partsPattern.test(product) !== needsParts) continue;
      const actual = productCategories(product);
      if (outdoorParts || indoorParts) {
        const outdoor =
          /outdoor|室外|户外/i.test(product) ||
          actual.some((c) => ['zip', 'pergola', 'awning', 'cassette'].includes(c));
        const indoor =
          /indoor|室内/i.test(product) ||
          actual.some((c) =>
            [
              'roman',
              'zebra',
              'cellular',
              'venetian',
              'fabric',
              'roller',
              'shangrila',
              'dream',
              'vertical',
            ].includes(c),
          );
        if (outdoorParts ? outdoor : indoor) return 'matched';
      } else if (wanted.length) {
        // A specific cassette target needs cassette evidence, not just any awning.
        if (
          wanted.includes('cassette')
            ? actual.includes('cassette')
            : wanted.some((c) => actual.includes(c))
        )
          return 'matched';
      } else if (phraseMatches(product, term)) return 'matched';
    }
  }
  return 'not_matched';
}

// Normalize country names for the market check; returns '' when unmappable.
const countryAliases = {
  usa: 'united states',
  'u.s.': 'united states',
  'u.s.a.': 'united states',
  'united states of america': 'united states',
  america: 'united states',
  uk: 'united kingdom',
  'great britain': 'united kingdom',
  australia: 'australia',
  澳大利亚: 'australia',
  澳洲: 'australia',
  美国: 'united states',
  加拿大: 'canada',
  英国: 'united kingdom',
  中国: 'china',
  新西兰: 'new zealand',
};
export function normalizeCountry(value) {
  const key = String(value || '')
    .trim()
    .toLowerCase();
  if (!key) return '';
  return countryAliases[key] || key;
}
export function countryMatches(actual, marketCountries = []) {
  const normalized = normalizeCountry(actual);
  if (!normalized) return 'unknown';
  const markets = marketCountries.map(normalizeCountry).filter(Boolean);
  if (!markets.length) return 'unrestricted';
  return markets.includes(normalized) ? 'matched' : 'not_matched';
}
