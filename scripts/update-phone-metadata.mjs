import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import prettier from 'prettier';

// Only general number patterns, country codes and dialing prefixes are vendored.
// Runtime helpers stay dependency-free so the same rules can run in n8n.
const source =
  'https://raw.githubusercontent.com/google/libphonenumber/master/resources/PhoneNumberMetadata.xml';
const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Phone metadata HTTP ${response.status}`);
const xml = await response.text();
const regions = {};
const names = {};
const display = new Intl.DisplayNames(['en'], { type: 'region' });
for (const match of xml.matchAll(/<territory\b([^>]+)>([\s\S]*?)<\/territory>/g)) {
  const attrs = Object.fromEntries(
    [...match[1].matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
  );
  const pattern = match[2]
    .match(/<generalDesc>[\s\S]*?<nationalNumberPattern>([\s\S]*?)<\/nationalNumberPattern>/)?.[1]
    ?.replace(/\s/g, '');
  if (!attrs.id || !attrs.countryCode || !pattern) continue;
  const lengths = new Set();
  for (const entry of match[2].matchAll(/<possibleLengths\b[^>]*\bnational="([^"]*)"/g)) {
    for (const part of entry[1].split(',')) {
      const range = /^\[(\d+)-(\d+)\]$/.exec(part.trim());
      if (range) for (let n = Number(range[1]); n <= Number(range[2]); n++) lengths.add(n);
      else if (/^\d+$/.test(part.trim())) lengths.add(Number(part));
    }
  }
  if (!lengths.size) throw new Error(`Missing national lengths: ${attrs.id}`);
  const id = attrs.id === '001' ? '001-' + attrs.countryCode : attrs.id;
  regions[id] = [
    attrs.countryCode,
    pattern,
    [...lengths].sort((a, b) => a - b),
    attrs.nationalPrefixForParsing || attrs.nationalPrefix || '',
    attrs.internationalPrefix || '00',
  ];
  if (attrs.id !== '001') names[display.of(attrs.id).toLowerCase()] = attrs.id;
}
Object.assign(names, {
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  uk: 'GB',
  'great britain': 'GB',
  'united states of america': 'US',
  'czech republic': 'CZ',
  turkey: 'TR',
  'south korea': 'KR',
  vietnam: 'VN',
  russia: 'RU',
  'vatican city': 'VA',
  美国: 'US',
  加拿大: 'CA',
  澳大利亚: 'AU',
  澳洲: 'AU',
  英国: 'GB',
  中国: 'CN',
  中国大陆: 'CN',
  香港: 'HK',
  澳门: 'MO',
  台湾: 'TW',
  阿联酋: 'AE',
  新西兰: 'NZ',
  新加坡: 'SG',
  日本: 'JP',
  韩国: 'KR',
});
const hash = createHash('sha256').update(xml).digest('hex');
const code = `// Derived from Google libphonenumber, Apache-2.0. See data/PHONE-METADATA-LICENSE.txt.\n// Source: ${source}\n// SHA256: ${hash}\n// Regenerate with: node scripts/update-phone-metadata.mjs\nexport function phoneMetadata() {\n  if (phoneMetadata.cache) return phoneMetadata.cache;\n  const regions = ${JSON.stringify(regions)};\n  const names = ${JSON.stringify(names)};\n  const callingCodes = {};\n  for (const [id, entry] of Object.entries(regions)) (callingCodes[entry[0]] ||= []).push(id);\n  return (phoneMetadata.cache = { regions, names, callingCodes });\n}\n`;
await fs.writeFile(
  'server/phone-metadata.mjs',
  await prettier.format(code, {
    ...(await prettier.resolveConfig('server/phone-metadata.mjs')),
    parser: 'babel',
  }),
);
const license = await fetch(
  'https://raw.githubusercontent.com/google/libphonenumber/master/LICENSE',
  { signal: AbortSignal.timeout(30000) },
);
if (!license.ok) throw new Error('Phone metadata license unavailable');
await fs.writeFile('server/data/PHONE-METADATA-LICENSE.txt', await license.text());
console.log(JSON.stringify({ regions: Object.keys(regions).length, sha256: hash }));
