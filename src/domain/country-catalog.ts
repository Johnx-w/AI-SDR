import codes from 'i18n-iso-countries/codes.json' with { type: 'json' };
import gdpOrder from '../data/country-gdp-order.json' with { type: 'json' };

import englishNames from 'i18n-iso-countries/langs/en.json' with { type: 'json' };
import chineseNames from 'i18n-iso-countries/langs/zh.json' with { type: 'json' };

const targetCodes = new Set(
  'US AU CA GB SG MY NZ TH VN AE ZA GH PH PL NL DE IT BE BR CL AR CO MX KR JP'.split(' '),
);
function catalogName(names: Record<string, string | string[]>, code: string) {
  const value = names[code];
  return Array.isArray(value) ? value[0] : value;
}

const english = new Intl.DisplayNames('en', { type: 'region' });
const chinese = new Intl.DisplayNames('zh-CN', { type: 'region' });
const rank = new Map(gdpOrder.map((code, i) => [code, i]));
export const countries = codes
  .map(([code, iso3]) => {
    // Task values cross browser, API and storage boundaries. Use the bundled
    // names for supported countries so a browser's ICU version cannot change them.
    const target = targetCodes.has(code);
    const name =
      code === 'US'
        ? 'United States'
        : target
          ? catalogName(englishNames.countries, code)
          : english.of(code) || code;
    const zh = target ? catalogName(chineseNames.countries, code) : chinese.of(code) || code;
    return { code, iso3, name, zh, label: zh + '.' + name };
  })
  .sort(
    (a, b) =>
      (rank.get(a.code) ?? Infinity) - (rank.get(b.code) ?? Infinity) ||
      a.name.localeCompare(b.name, 'en'),
  );
const aliases: Record<string, string[]> = {
  US: ['United States of America', 'America', 'U.S.', 'U.S.A.'],
  GB: ['UK', 'Great Britain'],
  AU: ['澳洲'],
  AE: ['UAE', '阿拉伯联合酋长国', 'Dubai', '迪拜'],
  KR: ['Republic of Korea', 'Korea, Republic of'],
  VN: ['Viet Nam'],
  CN: ['PRC'],
  TR: ['Turkey'],
  HK: ['Hong Kong', '香港', '中国香港'],
  MO: ['Macao', 'Macau', '澳门', '中国澳门'],
};
const byName = new Map(
  countries.flatMap((c) =>
    [c.name, c.zh, c.code, c.iso3, c.label, ...(aliases[c.code] || [])].map(
      (s) => [s.toLowerCase(), c] as const,
    ),
  ),
);
export const countryFor = (value?: string | null) => byName.get(value?.trim().toLowerCase() || '');
const targetCountries = countries.filter((country) => targetCodes.has(country.code));
export const acquisitionMarkets = targetCountries.map((c) => ({
  label: c.code === 'AE' ? c.label + '（迪拜）' : c.label,
  value: c.name,
  keywords: [c.code, c.iso3, ...(aliases[c.code] || [])].join(' '),
}));
export const countryFilters = [
  { label: '全部国家', value: '' },
  ...acquisitionMarkets.map((option, i) => ({ ...option, value: targetCountries[i].zh })),
  { label: '待核实', value: '待核实' },
];

export function isCountryScope(input: {
  country: string;
  region?: unknown;
  market_countries?: unknown;
  target_markets?: unknown;
}) {
  return (
    acquisitionMarkets.some((option) => option.value === input.country) &&
    !input.region &&
    [input.market_countries, input.target_markets].every(
      (group) =>
        group === undefined ||
        (Array.isArray(group) && group.length === 1 && group[0] === input.country),
    )
  );
}
