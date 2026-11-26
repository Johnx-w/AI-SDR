import subdivisions from './data/subdivisions-bilingual.json' with { type: 'json' };
import { acquisitionMarkets, countryFor } from '../src/domain/country-catalog.ts';
import { marketRegions } from './market-regions.mjs';

// Search one level per market. The customer library also recognises older names
// and smaller subdivisions for historical addresses.
const includeCode = {
  BE: (code) => ['BRU', 'VLG', 'WAL'].includes(code),
  GH: (code) => code !== 'BA',
  IT: (code) => /^\d{2}$/.test(code),
  NL: (code) => !code.startsWith('BQ'),
  TH: (code) => code !== 'S',
};

// Official national lists take precedence where the bundled CLDR names predate reforms.
const nationalLists = {
  VN: [
    'Tuyen Quang',
    'Cao Bang',
    'Lai Chau',
    'Lao Cai',
    'Thai Nguyen',
    'Dien Bien',
    'Lang Son',
    'Son La',
    'Phu Tho',
    'Bac Ninh',
    'Quang Ninh',
    'Ha Noi',
    'Hai Phong',
    'Hung Yen',
    'Ninh Binh',
    'Thanh Hoa',
    'Nghe An',
    'Ha Tinh',
    'Quang Tri',
    'Hue',
    'Da Nang',
    'Quang Ngai',
    'Gia Lai',
    'Dak Lak',
    'Khanh Hoa',
    'Lam Dong',
    'Dong Nai',
    'Tay Ninh',
    'Ho Chi Minh City',
    'Dong Thap',
    'An Giang',
    'Vinh Long',
    'Can Tho',
    'Ca Mau',
  ],
  PH: [
    'National Capital Region',
    'Cordillera Administrative Region',
    'Ilocos Region',
    'Cagayan Valley',
    'Central Luzon',
    'CALABARZON',
    'MIMAROPA',
    'Bicol Region',
    'Western Visayas',
    'Negros Island Region',
    'Central Visayas',
    'Eastern Visayas',
    'Zamboanga Peninsula',
    'Northern Mindanao',
    'Davao Region',
    'SOCCSKSARGEN',
    'Caraga',
    'Bangsamoro Autonomous Region in Muslim Mindanao',
  ],
};

function namesFor(country) {
  if (marketRegions[country]) return marketRegions[country].map((region) => region.name);
  const { code } = countryFor(country);
  if (nationalLists[code]) return nationalLists[code];
  const names = subdivisions[code]
    .filter(([id]) => !includeCode[code] || includeCode[code](id))
    .map(([id, name]) => {
      if (code === 'NZ' && id === 'MBH') return 'Marlborough';
      if (code === 'NZ' && id === 'MWT') return 'Manawatū-Whanganui';
      return name;
    });
  if (code === 'NZ') names.push('Nelson');
  return names;
}

export const searchRegions = new Map(
  acquisitionMarkets.map(({ value }) => [value, namesFor(value)]),
);
