import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { availableMemory } from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { selectAcquisitionEvidence } from '../server/acquisition-evidence-selection.mjs';
import { readPublicHtml, websiteUrl, websiteRedirectUrl } from '../server/branding.mjs';
import { boundedResearchPages } from '../server/research-input.mjs';
import { hasUsableResearchText, researchPageText } from '../server/research-pages.mjs';
import { compactResearchText, researchEvidencePages } from '../server/research-text.mjs';
import { collectScraplingPage } from '../server/scrapling-collector.mjs';
import { domainKey } from '../server/website-identity.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const [manifest, output] = process.argv.slice(2);
if (!manifest || !output || !process.env.SCRAPLING_PYTHON) {
  throw new Error(
    'Set SCRAPLING_PYTHON and run node scripts/compare-acquisition-collectors.mjs <sample.json> <new-output-directory>',
  );
}
const targets = JSON.parse(await readFile(manifest, 'utf8'));
if (
  !Array.isArray(targets) ||
  !targets.length ||
  new Set(targets.map((record) => record.url)).size !== targets.length ||
  targets.some(
    ({ market, group, url, facts }) =>
      !market ||
      !group ||
      !websiteUrl(url) ||
      !domainKey(url) ||
      (facts && (!Array.isArray(facts) || facts.some((fact) => typeof fact !== 'string' || !fact))),
  )
) {
  throw new Error(
    'Expected distinct targets with market, group, public HTTPS URL and optional facts',
  );
}
await mkdir(output);
await mkdir(join(output, 'pages'));
await writeFile(join(output, 'sample.json'), JSON.stringify(targets, null, 2));

async function archive(content) {
  if (!content) return null;
  const id = hash(content);
  const filename = join(output, 'pages', id + '.html.gz');
  await writeFile(filename, gzipSync(content), { flag: 'wx' }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  if (hash(gunzipSync(await readFile(filename))) !== id)
    throw new Error('Snapshot digest mismatch');
  return id;
}

async function direct(url) {
  try {
    const signal = AbortSignal.timeout(12000);
    let next = websiteUrl(url);
    for (let hop = 0; hop < 4; hop++) {
      if (!next || domainKey(next.href) !== domainKey(url)) return { status: 'blocked' };
      const response = await readPublicHtml(next, signal);
      if (response.redirect) {
        next = websiteRedirectUrl(response.redirect, next);
        continue;
      }
      const content = response.html || '';
      return {
        content,
        final_url: next.href,
        status: hasUsableResearchText(researchPageText(content), content) ? 'ok' : 'failed',
      };
    }
    return { status: 'blocked' };
  } catch (error) {
    return { status: error.name === 'TimeoutError' ? 'timeout' : 'failed' };
  }
}

const counts = new Map();
const lastBody = new Map();
for (const [index, target] of targets.entries()) {
  for (let trial = 0; trial < 2; trial++) {
    const variants = ['node', 'scrapling'];
    if ((index + trial) % 2) variants.reverse();
    for (const method of variants) {
      const started_at = new Date().toISOString();
      const start = performance.now();
      const memory_before_bytes = availableMemory();
      const page =
        method === 'node'
          ? await direct(target.url)
          : await collectScraplingPage(target.url, { reason: 'paired_collection' });
      const elapsed_ms = Math.round(performance.now() - start);
      const { content, raw_content, ...snapshot } = page;
      const snapshot_hash = await archive(content);
      const raw_hash = await archive(raw_content || content);
      const bodyKey = method + ':' + target.url;
      const previous = lastBody.get(bodyKey);
      lastBody.set(bodyKey, raw_hash);
      const source_url = page.final_url || target.url;
      const cleaned = researchPageText(content, content?.length || 0);
      const evidence =
        method === 'node'
          ? { source_url, text: compactResearchText(cleaned, source_url) }
          : selectAcquisitionEvidence(source_url, content || '');
      const spans = researchEvidencePages(boundedResearchPages([evidence]).pages);
      const lost = target.facts?.filter((fact) => !spans.some(({ text }) => text.includes(fact)));
      const record = {
        ...snapshot,
        target: target.url,
        market: target.market,
        group: target.group,
        trial: trial + 1,
        method,
        started_at,
        elapsed_ms,
        memory_before_bytes,
        snapshot_hash,
        raw_hash,
        raw_hash_changed: previous === undefined ? null : previous !== raw_hash,
        lost: lost ?? null,
      };
      await writeFile(join(output, 'runs.jsonl'), JSON.stringify(record) + '\n', { flag: 'a' });
      const key = target.market + ' / ' + target.group + ' / ' + method;
      const stats = counts.get(key) || {
        sites: new Set(),
        pages: 0,
        ok: 0,
        times: [],
        labeled: 0,
        complete: 0,
      };
      stats.sites.add(target.url);
      stats.pages++;
      if (page.status === 'ok') stats.ok++;
      if (target.facts?.length) {
        stats.labeled++;
        if (page.status === 'ok' && !lost.length) stats.complete++;
      }
      stats.times.push(elapsed_ms);
      counts.set(key, stats);
      await delay(500);
    }
  }
}
const summary = [...counts].map(([key, { sites, times, ...stat }]) => {
  times.sort((a, b) => a - b);
  return {
    group: key,
    sites: sites.size,
    ...stat,
    p50_ms: times[Math.ceil(times.length * 0.5) - 1],
    p95_ms: times[Math.ceil(times.length * 0.95) - 1],
  };
});
await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
console.table(summary);
