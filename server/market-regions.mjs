import geography from './data/geography.json' with { type: 'json' };
import { canadaRegions } from './markets.mjs';

// Display labels are separate from the original English search values and codes.
const unitedStatesLabels = {
  AL: '阿拉巴马州',
  AK: '阿拉斯加州',
  AZ: '亚利桑那州',
  AR: '阿肯色州',
  CA: '加利福尼亚州',
  CO: '科罗拉多州',
  CT: '康涅狄格州',
  DE: '特拉华州',
  DC: '华盛顿哥伦比亚特区',
  FL: '佛罗里达州',
  GA: '佐治亚州',
  HI: '夏威夷州',
  ID: '爱达荷州',
  IL: '伊利诺伊州',
  IN: '印第安纳州',
  IA: '艾奥瓦州',
  KS: '堪萨斯州',
  KY: '肯塔基州',
  LA: '路易斯安那州',
  ME: '缅因州',
  MD: '马里兰州',
  MA: '马萨诸塞州',
  MI: '密歇根州',
  MN: '明尼苏达州',
  MS: '密西西比州',
  MO: '密苏里州',
  MT: '蒙大拿州',
  NE: '内布拉斯加州',
  NV: '内华达州',
  NH: '新罕布什尔州',
  NJ: '新泽西州',
  NM: '新墨西哥州',
  NY: '纽约州',
  NC: '北卡罗来纳州',
  ND: '北达科他州',
  OH: '俄亥俄州',
  OK: '俄克拉何马州',
  OR: '俄勒冈州',
  PA: '宾夕法尼亚州',
  RI: '罗得岛州',
  SC: '南卡罗来纳州',
  SD: '南达科他州',
  TN: '田纳西州',
  TX: '得克萨斯州',
  UT: '犹他州',
  VT: '佛蒙特州',
  VA: '弗吉尼亚州',
  WA: '华盛顿州',
  WV: '西弗吉尼亚州',
  WI: '威斯康星州',
  WY: '怀俄明州',
};
const australiaLabels = {
  ACT: '澳大利亚首都领地',
  NSW: '新南威尔士州',
  NT: '北领地',
  QLD: '昆士兰州',
  SA: '南澳大利亚州',
  TAS: '塔斯马尼亚州',
  VIC: '维多利亚州',
  WA: '西澳大利亚州',
};

// ONS January 2025 ITL 1: nine English regions and three constituent countries.
// These are peer search-market areas, not a claim that UK administrations share
// one uniform hierarchy. England itself is omitted to avoid overlapping choices.
const unitedKingdomRegions = [
  ['TLC', 'North East (England)', '英格兰东北部'],
  ['TLD', 'North West (England)', '英格兰西北部'],
  ['TLE', 'Yorkshire and The Humber', '约克郡和亨伯'],
  ['TLF', 'East Midlands (England)', '东米德兰兹'],
  ['TLG', 'West Midlands (England)', '西米德兰兹'],
  ['TLH', 'East (England)', '英格兰东部'],
  ['TLI', 'London', '伦敦地区'],
  ['TLJ', 'South East (England)', '英格兰东南部'],
  ['TLK', 'South West (England)', '英格兰西南部'],
  ['TLL', 'Wales', '威尔士'],
  ['TLM', 'Scotland', '苏格兰'],
  ['TLN', 'Northern Ireland', '北爱尔兰'],
].map(([code, name, label]) => ({ code, name, label }));

const labelledRegions = (country, labels) =>
  geography[country].map(({ name, code }) => ({ name, code, label: labels[code] }));

export const marketRegions = {
  'United States': labelledRegions('United States', unitedStatesLabels),
  Australia: labelledRegions('Australia', australiaLabels),
  Canada: canadaRegions,
  'United Kingdom': unitedKingdomRegions,
};
