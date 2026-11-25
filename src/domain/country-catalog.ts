import codes from 'i18n-iso-countries/codes.json' with { type: 'json' };
import gdpOrder from '../data/country-gdp-order.json' with { type: 'json' };

const english = new Intl.DisplayNames('en', { type: 'region' });
const chinese = new Intl.DisplayNames('zh-CN', { type: 'region' });
const rank = new Map(gdpOrder.map((code, i) => [code, i]));
export const countries = codes
  .map(([code, iso3]) => {
    const name = english.of(code) || code;
    const zh = code === 'AE' ? '阿联酋' : chinese.of(code) || code;
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
};
const byName = new Map(
  countries.flatMap((c) =>
    [c.name, c.zh, c.code, c.iso3, c.label, ...(aliases[c.code] || [])].map(
      (s) => [s.toLowerCase(), c] as const,
    ),
  ),
);
export const countryFor = (value?: string | null) => byName.get(value?.trim().toLowerCase() || '');
export const countryFilters = [
  { label: '全部国家', value: '' },
  ...countries.map((c) => ({
    label: c.label,
    value: c.zh,
    keywords: [c.code, c.iso3, ...(aliases[c.code] || [])].join(' '),
  })),
  { label: '待核实', value: '待核实' },
];
export const acquisitionMarkets = [
  ...countries.map((c) => ({
    label: c.label,
    value: c.name,
    keywords: [
      c.code,
      c.iso3,
      ...(aliases[c.code] || []).filter((s) => !['Dubai', '迪拜'].includes(s)),
    ].join(' '),
  })),
  { label: '迪拜.Dubai（阿联酋）', value: 'Dubai', keywords: 'United Arab Emirates' },
  { label: '欧洲（不含英国）.Europe', value: 'Europe' },
];
