import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LeadLibrary } from '../server/lead-library.mjs';

const sizes = [1000, 10000];
const fixtureDetailBytes = 1792;
const fixtureTime = '2026-01-01T00:00:00.000Z';
const temporaryPrefix = 'shadeflow-lead-benchmark-';

function fixture(index) {
  const number = String(index).padStart(5, '0');
  const name = `Synthetic Customer ${number}`;
  const domain = `customer-${number}.example`;
  const website = `https://${domain}/`;
  const email = `buyer@${domain}`;
  const lead = {
    id: `rec_benchmark_${number}`,
    name,
    domain,
    market: 'Australia',
    type: 'manufacturer',
    product: 'roller blinds',
    match: '',
    score: 75,
    grade: 'B',
    ratingReason: '主营产品：合成卷帘样本',
    status: '未记录',
    region: 'New South Wales',
    city: 'Sydney',
    contact: 'Synthetic Buyer',
    email,
    phone: '',
    website,
    source: `${website}catalog`,
    evidence: 'Synthetic benchmark fixture; no real customer data.',
    companyIdentity: null,
    assessment: null,
    facts: [
      {
        field: 'products',
        value: 'roller blinds',
        quote: 'Synthetic product evidence for a deterministic performance fixture.',
        source_url: `${website}catalog`,
      },
    ],
    contactEvidence: [
      {
        kind: 'email',
        value: email,
        quote: 'Synthetic contact evidence.',
        source_url: `${website}contact`,
      },
    ],
    updatedAt: fixtureTime,
    fields: { 公司名称: name, benchmark_padding: '' },
  };
  const paddingBytes = fixtureDetailBytes - Buffer.byteLength(JSON.stringify(lead));
  if (paddingBytes < 0) throw new Error('Synthetic fixture exceeds its detail size budget');
  lead.fields.benchmark_padding = 'x'.repeat(paddingBytes);
  if (Buffer.byteLength(JSON.stringify(lead)) !== fixtureDetailBytes)
    throw new Error('Synthetic fixture detail size is not deterministic');
  return lead;
}

const rounded = (value) => Math.round(value * 1000) / 1000;
function distribution(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    iterations: sorted.length,
    medianMs: rounded(
      sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    ),
    p95Ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]),
  };
}

async function measure(iterations, read) {
  const durations = [];
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    await read(index);
    durations.push(performance.now() - started);
  }
  return distribution(durations);
}

async function benchmark(size, folder) {
  let current = Array.from({ length: size }, (_, index) => fixture(index));
  const library = new LeadLibrary({
    path: join(folder, `customers-${size}.sqlite`),
    scope: `synthetic-benchmark-${size}`,
  });
  try {
    for (const lead of current) library.upsert(lead);
    // Warm up each read path without including initial sync or JIT setup in samples.
    await library.list();
    await library.list();
    await library.detail(current[0].id);
    await library.detail(current.at(-1).id);
    const warmList = await measure(10, () => library.list());
    const warmDetail = await measure(20, (index) =>
      library.detail(current[Math.floor((index * size) / 20)].id),
    );
    const added = fixture(size);
    library.upsert(added);
    const detail = await library.detail(added.id);
    if (detail.lead.email !== added.email) throw new Error('New customer detail was not persisted');
    return {
      customers: size,
      seededDetailBytesPerCustomer: fixtureDetailBytes,
      seededDetailBytesTotal: size * fixtureDetailBytes,
      warmList,
      warmDetail,
    };
  } finally {
    library.close();
  }
}

async function cleanup(folder) {
  const absoluteFolder = resolve(folder);
  const tempRoot = resolve(tmpdir());
  const withinTemp = relative(tempRoot, absoluteFolder);
  if (
    !withinTemp ||
    withinTemp === '..' ||
    withinTemp.startsWith(`..${sep}`) ||
    resolve(tempRoot, withinTemp) !== absoluteFolder ||
    basename(absoluteFolder) !== withinTemp ||
    !basename(absoluteFolder).startsWith(temporaryPrefix)
  )
    throw new Error('Refusing to clean a benchmark path outside its dedicated temporary directory');
  await rm(absoluteFolder, { recursive: true, force: true });
}

const folder = await mkdtemp(join(tmpdir(), temporaryPrefix));
try {
  const results = [];
  for (const size of sizes) results.push(await benchmark(size, folder));
  process.stdout.write(
    JSON.stringify(
      {
        benchmark: 'lead-library-synthetic',
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        percentileMethod: 'nearest-rank',
        scope:
          'Local LeadLibrary methods; excludes HTTP, browser rendering and Feishu network time.',
        fixtures: 'Generated synthetic customers under reserved .example domains; no real data.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await cleanup(folder);
}
