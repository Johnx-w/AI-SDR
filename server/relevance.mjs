// Product-relevance gating shared by the pre-AI page screen and the post-AI audit.
import { isAllProductScope, productTerms } from '../src/domain/acquisition-products.mjs';
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
  if (isAllProductScope(target)) {
    const relevant = broadWindowProductStatus(content, true) === 'matched';
    return { relevant, score: relevant ? 1 : 0, matched: relevant ? ['window furnishings'] : [] };
  }
  const matched = [];
  const hit = (label) => {
    if (!matched.includes(label)) matched.push(label);
  };
  // 1. Strong industry phrase anywhere in the page.
  for (const pattern of strongPhrases) if (pattern.test(content)) hit(pattern.source);
  // 2. Target product phrases (multi-word phrases are specific enough to prove relevance).
  const terms = productTerms(target).flatMap((p) => targetProductTerms(p));
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
const unrelatedWindowProducts =
  /\b(?:(?:shower|bath|stage|theat(?:re|er)|welding|air|fire|vehicle|caravan|automotive|car|truck|marine|boat|rv)\s+(?:window\s+)?(?:curtains?|blinds?|shades?|screens?|awnings?|shutters?)|(?:medical|cubicle|surgical)\s+(?:privacy\s+)?curtains?|hospital\s+(?:privacy|cubicle|bedside)\s+curtains?|(?:lamp|eye|sun\s*glass)\s*shades?|(?:led|lcd|computer|phone|projection|printing)\s+screens?|screen\s+printing|camera\s+shutters?|(?:curtains?|blinds?|shades?|awnings?)\s+(?:for|in)\s+(?:cars?|vehicles?|caravans?|boats?|rvs?))\b|浴帘|医用帘|医疗帘|隔帘|舞台幕布|焊接帘|房车|车载|汽车遮阳|灯罩/gi;
const windowIndustryPattern =
  /\b(?:window\s+(?:coverings?|furnishings?|treatments?|blinds?|shades?|curtains?|shutters?|screens?)|blinds|shades|curtains|draper(?:y|ies)|awnings?|pergolas?|shutters?|zip\s*[- ]?(?:screens?|tracks?)|zipscreen|ziptrak|(?:roller|roman|venetian|cellular|honeycomb|zebra|vertical|pleated|panel\s+track|woven\s+wood|bamboo)\s+(?:blinds?|shades?)|(?:insect|fly|bug)\s+screens?|shade\s+sails?)\b|窗饰|窗帘|遮阳篷|遮阳棚|遮阳帆|百叶帘|百叶窗|卷帘|罗马帘|蜂巢帘|斑马帘|百褶帘|竹木帘|防风帘|拉链帘|纱窗|凉亭|廊架|天幕/i;
const dedicatedWindowMaterialsPattern =
  /\b(?:blind|shade|curtain|awning|shutter)\s+(?:components?|parts?|motors?|fabrics?|tracks?|rails?|slats?|tubes?|brackets?|accessories|hardware)\b|\bsemi[- ]?finished\s+(?:window\s+coverings?|blinds?|shades?|curtains?|awnings?|shutters?)\b/i;
const sampleProductPattern =
  /\b(?:samples?|swatches?|sample\s+books?|sample\s+cards?|display\s+kits?|display\s+cases?)\b|样本|样册|样卡|展示套件|展示箱/i;
const sampleProductDescriptions =
  /\b(?:(?:window\s+(?:coverings?|furnishings?|treatments?)|blinds?|shades?|curtains?|awnings?)\s+)?(?:fabrics?\s+)?(?:samples?(?:\s+(?:books?|cards?|kits?))?|swatches?|display\s+(?:kits?|cases?))(?:\s+(?:for|of)\s+(?:window\s+)?(?:coverings?|furnishings?|blinds?|shades?|curtains?|fabrics?))?\b|(?:窗饰|窗帘|面料)?(?:样本册|样本|样册|样卡|展示套件|展示箱)/gi;
const windowMaterialsPattern =
  /\b(?:semi[- ]?finished|materials?|components?|parts?|motors?|brackets?|headrails?|springs?|slats?|tubes?|(?<!zip[- ]|panel\s)tracks?|rails?|profiles?|extrusions?|hardware|accessories|mechanisms?|clutch(?:es)?|chains?|cords?|strings?)\b|\b(?:curtain|blind|blinds|shade|shades|awning|awnings)\s+fabrics?\b|\bfabrics?\s+for\s+(?:curtains?|blinds?|shades?|awnings?)\b|半成品|材料|配件|零件|电机|制头|弹簧|安装码|叶片|型材|轨道|面料|卷管|绳线|拉绳/i;

function broadWindowProductStatus(text, allowSampleMentions = false) {
  const original = String(text || '').trim();
  if (!original) return 'unknown';
  let cleaned = original.replace(unrelatedWindowProducts, ' ');
  // A sample book may contain curtain fabric without being a material supplier.
  const mentionsSamples = sampleProductPattern.test(cleaned);
  if (!allowSampleMentions && mentionsSamples)
    cleaned = cleaned.replace(sampleProductDescriptions, ' ');
  if (windowIndustryPattern.test(cleaned) || dedicatedWindowMaterialsPattern.test(cleaned))
    return 'matched';
  if (mentionsSamples) return 'not_matched';
  if (cleaned !== original) return 'not_matched';
  return /\b(?:screens?|motors?|fabrics?|materials?|parts?|components?|hardware|shading)\b|屏幕|电机|面料|材料|配件|零件/i.test(
    original,
  )
    ? 'unknown'
    : 'not_matched';
}

// Delivery direction is checked separately from the product family. Generic
// motors/fabric never establish a window-furnishing opportunity on their own.
export function windowProductDirections(text) {
  if (broadWindowProductStatus(text) !== 'matched') return [];
  const cleaned = String(text)
    .replace(unrelatedWindowProducts, ' ')
    .replace(sampleProductDescriptions, ' ')
    // Keep a shared Chinese accessory suffix attached to all of its uses.
    .replace(
      /(?:用于|适用于)?(?:窗饰|窗帘|百叶帘|卷帘|遮阳帘)(?:\s*(?:和|与|以及|及|、)\s*(?:窗饰|窗帘|百叶帘|卷帘|遮阳帘))+(?:的|用)(?:替换|维修|专用)?(配件|零件|材料|电机|面料|绳线|拉绳)/g,
      '$1',
    );
  if (!windowMaterialsPattern.test(cleaned)) return ['finished'];
  const found = new Set(['materials']);
  // A catalog sentence may list complete blinds and dedicated components side
  // by side. Classify the independent phrases rather than assigning the whole
  // sentence to materials merely because one listed product is a motor.
  for (const sentence of cleaned.split(/[.!?;。\n]/)) {
    let sharedMaterialContext = false;
    for (const phrase of sentence.split(/\b(?:and|or|plus)\b|[,;&]|、|以及|和|与/)) {
      const material = windowMaterialsPattern.test(phrase);
      if (material) {
        sharedMaterialContext = /\bsemi[- ]?finished\b|\bfor\b|半成品|用于/i.test(phrase);
        continue;
      }
      const independentSupply =
        /\b(?:we\s+)?(?:supply|sell|offer|manufacture|produce)\b|供应|销售|生产/i.test(phrase);
      if (
        (!sharedMaterialContext || independentSupply) &&
        broadWindowProductStatus(phrase) === 'matched'
      )
        found.add('finished');
    }
  }
  return [...found];
}
// These catalog subtypes need their own evidence. A generic "awning" or "roller
// blind" listing cannot establish that a company sells the selected subtype.
const specificProductPatterns = new Map([
  ['outdoor roller blinds', /outdoor\s+roller\s+(?:blinds?|shades?)|户外卷帘|室外卷帘/i],
  [
    'straight drop awnings',
    /straight\s+drop\s+(?:awnings?|blinds?|screens?)|直落式?户外帘|直落帘/i,
  ],
  [
    'wire guided outdoor blinds',
    /wire\s+guid(?:ed|e)\s+(?:outdoor\s+)?(?:blinds?|screens?|awnings?)|钢丝导向.*(?:帘|篷)/i,
  ],
  [
    'outdoor venetian blinds',
    /(?:outdoor|external|exterior)\s+venetian\s+blinds?|户外百叶帘|室外百叶帘/i,
  ],
  [
    'outdoor roller shutters',
    /(?:outdoor|external|exterior)\s+roller\s+shutters?|户外卷闸帘|室外卷闸帘/i,
  ],
  ['folding arm awnings', /folding\s+arm\s+awnings?|曲臂(?:遮阳)?篷/i],
  ['window awnings', /window\s+awnings?|窗篷|窗式遮阳篷/i],
  ['side awnings', /side\s+(?:awnings?|screens?)|侧遮阳帘|侧边遮阳篷/i],
  ['retractable roof awnings', /retractable\s+roof\s+(?:awnings?|systems?)|伸缩天幕篷|伸缩天幕/i],
  ['pergola awnings', /pergola\s+(?:awnings?|shades?)|廊架遮阳篷|凉亭篷/i],
  ['shade sails', /shade\s+sails?|遮阳帆/i],
  ['sheer curtains', /sheer\s+curtains?|voile\s+curtains?|纱帘/i],
  ['solar roller shades', /solar\s+(?:roller\s+)?shades?|solar\s+roller\s+blinds?|阳光卷帘/i],
  ['pleated shades', /pleated\s+(?:shades?|blinds?)|百褶帘/i],
  [
    'woven wood shades',
    /woven\s+wood\s+(?:shades?|blinds?)|bamboo\s+(?:shades?|blinds?)|竹木帘|竹帘/i,
  ],
  ['panel track blinds', /panel\s+track\s+(?:blinds?|shades?)|推拉板帘|板帘/i],
]);
function productCategories(text) {
  // Catalogs often coordinate two styles before the shared noun.
  text = String(text).replace(
    /\broller\s*(?:&|and|\/)\s*solar\s+shades?\b/gi,
    'roller shades solar shades',
  );
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
  // Preserve unconstrained helper calls; API requests normalize an explicit scope.
  if (!target.product_scope && !target.product && !target.products?.length) return 'unrestricted';
  if (isAllProductScope(target)) {
    if (!list.length) return 'unknown';
    const statuses = list.map((product) => broadWindowProductStatus(product));
    return statuses.includes('matched')
      ? 'matched'
      : statuses.includes('unknown')
        ? 'unknown'
        : 'not_matched';
  }
  const terms = productTerms(target).flatMap((p) => targetProductTerms(p));
  // No target product constraint (e.g. direct unit-test calls) means unrestricted.
  if (!terms.length) return 'unrestricted';
  if (!list.length) return 'unknown';
  for (const term of terms) {
    const wanted = productCategories(term);
    const specificPattern = specificProductPatterns.get(term);
    const needsParts = windowMaterialsPattern.test(term);
    const outdoorParts = needsParts && /outdoor|室外|户外/i.test(term);
    const indoorParts = needsParts && /indoor|室内/i.test(term);
    for (const product of list) {
      if (
        /\b(?:vehicle|caravan|4x4|camping|marine|boat|rv)\b|房车|车载|汽车/i.test(product) &&
        !/\b(?:vehicle|caravan|4x4|camping|marine|boat|rv)\b|房车|车载|汽车/i.test(term)
      )
        continue;
      if (windowMaterialsPattern.test(product) !== needsParts) continue;
      if (specificPattern) {
        if (specificPattern.test(product)) return 'matched';
        continue;
      }
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

// A finished-product business can be a prospect for related inputs even when
// it does not publicly sell or request those inputs. Keep that relationship
// explicit so a catalog fact never becomes a procurement fact.
export function businessProductRelation(products, target = {}) {
  const list = (Array.isArray(products) ? products : []).filter((p) => typeof p === 'string');
  const direct = productsRelevant(list, target);
  if (isAllProductScope(target) || direct === 'unrestricted')
    return { status: direct, kind: direct === 'matched' ? 'catalog_related' : null };
  const inputs =
    /\b(?:semi[- ]?finished|components?|parts?|motors?|fabrics?|textiles?|cloth|brackets?|headrails?|springs?|slats?|tubes?|tracks?|rails?|profiles?|extrusions?|hardware|accessories|mechanisms?|clutch(?:es)?|chains?|cords?)\b|半成品|材料|配件|零件|电机|制头|弹簧|安装码|叶片|型材|轨道|面料|卷管/gi;
  let potential;
  for (const term of productTerms(target).flatMap(targetProductTerms)) {
    inputs.lastIndex = 0;
    const inputTarget = inputs.test(term);
    const family = term.replace(inputs, ' ').replace(/\s+/g, ' ').trim();
    for (const product of list) {
      if (
        /\b(?:vehicle|caravan|automotive|car|truck|marine|boat|rv)\b|房车|车载|汽车/i.test(product)
      )
        continue;
      const forms = windowProductDirections(product);
      const matched =
        productsRelevant([product], { product_scope: 'specific', product: term }) === 'matched';
      if (matched && (!inputTarget || forms.includes('materials')))
        return { status: 'matched', kind: 'catalog_related', basis_product: product };
      if (!inputTarget || !forms.includes('finished')) continue;
      const familyMatch =
        matched ||
        (family &&
          productsRelevant([product], { product_scope: 'specific', product: family }) ===
            'matched') ||
        (/^(?:window\s+(?:coverings?|furnishings?|treatments?)|blinds?|shades?)$/i.test(family) &&
          /\b(?:blinds?|shades?|shutters?|window\s+(?:coverings?|furnishings?|treatments?))\b|卷帘|百叶|斑马|窗帘/i.test(
            product,
          )) ||
        (/sunscreen/i.test(family) && /solar\s+(?:roller\s+)?shades?|阳光卷帘/i.test(product));
      if (familyMatch)
        potential = { status: 'matched', kind: 'potential_input', basis_product: product };
    }
  }
  return potential || { status: direct, kind: direct === 'matched' ? 'catalog_related' : null };
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
