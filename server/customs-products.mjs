// Discovery catalog: official supplier pages are evidence for query vocabulary,
// not a quotation, SKU approval or a promise of current supply capability.
export const CUSTOMS_SCOPE_VERSION = 'north-america-window-coverings-v2';
export const CUSTOMS_PRODUCT_PACKS = [
  {
    family: 'fabrics',
    label: '窗饰面料',
    products: [
      'sunscreen fabric',
      'roller blind fabric',
      'blackout blind fabric',
      'zebra blind fabric',
      'honeycomb blind fabric',
    ],
    sources: ['https://www.durarollblinds.com/material_170.html'],
  },
  {
    family: 'components',
    label: '窗饰组件和叶片',
    products: [
      'blind components',
      'roller blind clutch',
      'roller shade clutch',
      'basswood slat',
      'fauxwood blinds components',
      'venetian blind slat',
    ],
    sources: [
      'https://www.blindselements.com/products/104.html',
      'https://www.durarollblinds.com/sujiaohanjieshebei_152-6.html',
      'https://www.durarollblinds.com/material_170.html',
    ],
  },
  {
    family: 'plantation_shutters',
    label: 'Plantation shutters',
    products: ['plantation shutter', 'wood shutter', 'PVC shutter', 'basswood shutter'],
    sources: ['https://decormaxgroup.com/', 'https://www.blindselements.com/products/'],
  },
  {
    family: 'finished_blinds',
    label: '室内成品窗饰',
    products: [
      'roller blind',
      'zebra blind',
      'honeycomb blind',
      'cellular shade',
      'faux wood blind',
    ],
    sources: ['https://decormaxgroup.com/', 'https://www.blindselements.com/products/'],
  },
  {
    family: 'outdoor_shading',
    label: '户外遮阳',
    products: [
      'outdoor zip screen',
      'zipscreen',
      'ziptrack blind',
      'zipper blind',
      'aluminum pergola',
      'louver pergola',
    ],
    sources: [
      'https://www.blindselements.com/products/89.html',
      'https://www.blindselements.com/products/87.html',
    ],
  },
  {
    family: 'samples',
    label: '窗饰样本与展示',
    products: [
      'roller shade sample book',
      'fabric swatch book',
      'shade sample card',
      'blinds display kit',
    ],
    sources: ['https://www.samplingworldwide.com/roller-shade_313.html'],
  },
];

const normalized = (text) => String(text || '').toLowerCase();
const normalizeTerm = (text) => normalized(text).replace(/[-_/]/g, ' ').replace(/\s+/g, ' ').trim();
const windowProduct = /\b(?:blinds?|shades?|shutters?|curtains?|window coverings?)\b/;
const sampleForm = /\b(?:samples?|swatches|swatch|display\s+(?:kits?|boxes?|books?|cards?))\b/;
const componentForm =
  /\b(?:components?|parts?|clutch|slats?|brackets?|head ?rails?|bottom ?rails?|mechanisms?|hardware|motors?|tubes?)\b/;

function familyFor(term) {
  const text = normalizeTerm(term);
  if (sampleForm.test(text))
    return windowProduct.test(text) || /fabric\s+swatch\s+book/.test(text) ? 'samples' : null;
  if (
    /fabric|textile|cloth|sun ?screen/.test(text) &&
    !/zip\s*screen|\bfabric\s+curtains?\b/.test(text)
  )
    return 'fabrics';
  if (
    componentForm.test(text) &&
    (windowProduct.test(text) || /basswood|faux\s*wood|venetian|head ?rails?/.test(text))
  )
    return 'components';
  if (/shutter/.test(text) && !/hurricane|roller shutter|rolling shutter/.test(text))
    return 'plantation_shutters';
  if (
    /zip\s*screen|ziptrack|zipper\s+blind|pergolas?|awnings?|shade\s+sails?|\b(?:outdoor|exterior|external)\b.*\b(?:blinds?|screens?|shades?)\b/.test(
      text,
    )
  )
    return 'outdoor_shading';
  if (
    /\b(?:roller|zebra|honeycomb|cellular|venetian|faux\s*wood|roman|pleated|vertical|woven\s+wood|panel\s+track|solar\s+roller|sheer|shangri\s*la)\b.*\b(?:blinds?|shades?)\b|\b(?:fabric|sheer|blackout|window|dream)\s+curtains?\b/.test(
      text,
    )
  )
    return 'finished_blinds';
  return null;
}

function selectedTerms(input) {
  return [
    ...new Set(
      (input.products?.length
        ? input.products.flatMap((p) =>
            typeof p === 'string' ? [p] : [p.value, ...(p.aliases || [])],
          )
        : String(input.product || '').split(',')
      )
        .filter((term) => typeof term === 'string' && term.trim())
        .map((term) => term.trim()),
    ),
  ];
}

function allProducts(input, terms) {
  return (
    input.product_scope === 'all' ||
    (input.product_scope !== 'specific' &&
      (!terms.length || (terms.length === 1 && normalizeTerm(terms[0]) === 'window coverings')))
  );
}

export function customsFamilies(input = {}) {
  const terms = selectedTerms(input);
  const all = allProducts(input, terms);
  return CUSTOMS_PRODUCT_PACKS.filter(
    (pack) => all || terms.some((term) => familyFor(term) === pack.family),
  );
}

export function customsSearchPlan(input = {}) {
  const country = input.country || 'North America';
  if (
    !['US', 'CA', 'United States', 'Canada', 'North America', '美国', '加拿大', '北美'].includes(
      country,
    )
  )
    return [];
  const terms = selectedTerms(input);
  const all = allProducts(input, terms);
  return customsFamilies(input).flatMap((pack) => {
    const products = all
      ? [...pack.products]
      : terms.filter((term) => familyFor(term) === pack.family);
    const base = {
      source_kind: 'customs',
      country,
      family: pack.family,
      product_family: pack.family,
      scope_version: CUSTOMS_SCOPE_VERSION,
      products,
      query: products.join(' OR '),
      source_markets: ['US'],
    };
    // HS is a separate recall lane. Never AND a broad HS class with all aliases.
    const codes = input.customs_hs_codes?.[pack.family];
    return [
      base,
      ...(Array.isArray(codes) && codes.length
        ? [
            {
              ...base,
              products: [],
              hs_codes: codes.map(String),
              query: 'HS ' + codes.join(' OR '),
            },
          ]
        : []),
    ];
  });
}

export function shipmentProductMatch(description, family) {
  const text = normalizeTerm(description);
  if (family === 'samples')
    return (
      sampleForm.test(text) &&
      windowProduct.test(text) &&
      !/garment|apparel|furniture|upholstery/.test(text)
    );
  if (sampleForm.test(text)) return false;
  if (family === 'fabrics') {
    if (!/fabric|textile|cloth/.test(text)) return false;
    return /(?:sun ?screen|roller\s+(?:blind|shade)|blackout\s+(?:blind|shade)|zebra\s+(?:blind|shade)|honeycomb\s+(?:blind|shade)|cellular\s+shade|window\s+(?:blind|shade)|curtain)\s*(?:s?\s*)?(?:fabric|textile|cloth)|(?:fabric|textile|cloth)\s+(?:for\s+)?(?:roller\s+)?(?:blinds?|shades?)|(?:fabric|textile|cloth)\s+for\s+curtains?/.test(
      text,
    );
  }
  if (family === 'components') {
    return (
      /(?:blinds?|shades?|venetian|basswood|faux\s*wood)/.test(text) &&
      /component|clutch|slats?|bracket|head ?rail|bottom ?rail|mechanism|blind\s+(?:parts?|hardware)|(?:parts?|components?)\s+of\s+(?:the\s+)?blinds?|roller\s+(?:blind|shade)\s+tube|(?:blind|shade)\s+motor/.test(
        text,
      ) &&
      !/blind\s+(?:flange|valve|rivet)/.test(text)
    );
  }
  if (family === 'plantation_shutters') {
    return (
      /plantation\s+shutters?|(?:wood|pvc|basswood|faux\s*wood|cedar)\s+shutters?/.test(text) &&
      !/hurricane|rolling\s+shutter|roller\s+shutter/.test(text)
    );
  }
  if (family === 'finished_blinds') {
    if (
      componentForm.test(text) ||
      /fabric(?!\s+curtains?\b)|textile|cloth|\b(?:outdoor|exterior|external)\b/.test(text)
    )
      return false;
    return /\b(?:roller|zebra|honeycomb|cellular|venetian|faux\s*wood|roman|pleated|vertical|woven\s+wood|panel\s+track|solar\s+roller|sheer|shangri\s*la)\s+(?:blinds?|shades?)\b|\b(?:fabric|sheer|blackout|window|dream)\s+curtains?\b/.test(
      text,
    );
  }
  if (family === 'outdoor_shading') {
    if (
      /inflatable|electronic|\bled\b|zip\s+ties|hurricane|rolling\s+shutter|roller\s+shutter/.test(
        text,
      )
    )
      return false;
    return /\b(?:outdoor|exterior|external|zip|zipper|ziptrack|wire\s+guided|straight\s+drop)\s+(?:roller\s+|venetian\s+)?(?:screens?|blinds?|shades?)\b|\bzip\s*screen\b|\b(?:aluminum|aluminium|louver|louvered|bioclimatic)\s+pergolas?\b|\b(?:retractable|folding\s+arm|window|side|pergola)\s+awnings?\b|\bshade\s+sails?\b/.test(
      text,
    );
  }
  return false;
}

export function obviousLogisticsBuyer(name, role = '') {
  return (
    /forwarder|carrier|notify|logistics|freight/.test(String(role).toLowerCase()) ||
    /\b(?:logistics?|freight|forwarding|shipping|cargo|transport(?:s|ation)?|transit|brokerage|fba)\b|\b(?:dhl|dsv|kuehne|nagel|clasquin|chain logic|globe express|expeditors)\b/i.test(
      String(name),
    )
  );
}
