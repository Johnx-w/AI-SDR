import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discoverBranding, websiteUrl } from './branding.mjs';
import { readPublicImage, inspectBrandImage } from './branding-image.mjs';

const assetPrefix = '/api/v1/branding/assets/';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const day = 86400000;
const version = 1;

// The cache owns both discovery and the image bytes: returning a cached remote URL
// still makes every browser depend on the customer's website on every visit.
export class BrandingCache {
  constructor({
    path = '.data/branding',
    discover = discoverBranding,
    readImage = readPublicImage,
    now = Date.now,
    ttlMs = 7 * day,
    retryMs = 30 * 60000,
    concurrency = 6,
  } = {}) {
    this.path = resolve(path);
    this.discover = discover;
    this.readImage = readImage;
    this.now = now;
    this.ttlMs = ttlMs;
    this.retryMs = retryMs;
    this.concurrency = concurrency;
    this.entries = new Map();
    this.pending = new Map();
    this.active = 0;
    this.waiters = [];
  }

  async get(lead) {
    const website = websiteUrl(lead.website || (lead.domain ? 'https://' + lead.domain : ''));
    if (!website) return { candidates: [] };
    const key = digest(website.hostname.replace(/^www\./, ''));
    // Register before disk I/O so simultaneous list/detail callers share one read.
    if (this.pending.has(key)) return this.pending.get(key);
    const task = this.load(key, lead).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  async load(key, lead) {
    let entry = this.entries.get(key);
    if (!entry) {
      try {
        entry = JSON.parse(await readFile(join(this.path, key + '.json'), 'utf8'));
        if (entry.version !== version || !Array.isArray(entry.candidates)) entry = null;
      } catch {
        entry = null;
      }
    }
    // Validate memory hits too: deleting or corrupting cached bytes must repair
    // the entry without requiring the API process to restart.
    if (entry?.candidates.length) {
      const assets = await Promise.all(
        entry.candidates.map((mark) => this.asset(mark.url.slice(assetPrefix.length))),
      );
      entry.candidates = entry.candidates.filter((_, index) => assets[index]);
      if (!entry.candidates.length) entry.expires = 0;
      // Older releases treated a fallback icon as a successful logo for seven
      // days. Recheck those entries once while continuing to serve the icon.
      if (
        !entry.candidates.some((mark) => mark.kind === 'logo') &&
        !Number.isFinite(entry.checkedAt)
      )
        entry.expires = 0;
    }
    if (entry) this.remember(key, entry);
    if (entry?.expires > this.now()) return { candidates: entry.candidates };
    if (entry?.candidates.length) {
      // Serve stale pixels immediately. Refresh is tracked separately so all
      // concurrent callers also get the stale result without waiting for HTTPS.
      const refreshKey = key + ':refresh';
      if (!this.pending.has(refreshKey)) {
        const refresh = this.refresh(key, lead, entry).finally(() =>
          this.pending.delete(refreshKey),
        );
        this.pending.set(refreshKey, refresh);
      }
      return { candidates: entry.candidates };
    }
    return { candidates: (await this.refresh(key, lead, entry)).candidates };
  }

  remember(key, entry) {
    this.entries.delete(key);
    if (this.entries.size >= 500) this.entries.delete(this.entries.keys().next().value);
    this.entries.set(key, entry);
  }

  async slot(work) {
    if (this.active >= this.concurrency) await new Promise((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  async refresh(key, lead, previous) {
    return this.slot(async () => {
      let candidates = [];
      try {
        const signal = AbortSignal.timeout(14000);
        // Leave time for cached public icons when the homepage itself times out.
        const discoverySignal = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
        const found = await this.discover(lead, { signal: discoverySignal });
        // Keep the site's ranking; use icons only if no usable brand image exists.
        const logos = found.candidates.filter((mark) => mark.kind === 'logo').slice(0, 4);
        const icons = found.candidates.filter((mark) => mark.kind === 'website_icon').slice(0, 3);
        const collect = async (marks) => {
          const loaded = await Promise.all(
            marks.map(async (mark) => {
              try {
                const imageSignal = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
                const image = await this.readImage(new URL(mark.url), imageSignal);
                const info = inspectBrandImage(image.body);
                if (!info) return null;
                // Ignore tracking pixels and tiny raster "logos"; try the next brand.
                if (
                  mark.kind === 'logo' &&
                  info.contentType !== 'image/svg+xml' &&
                  (!info.width || !info.height || info.width < 64 || info.height < 16)
                )
                  return null;
                if (info.width && info.height && (info.width < 8 || info.height < 8)) return null;
                const hash = digest(image.body);
                await this.write(hash + '.bin', image.body);
                return {
                  url: assetPrefix + hash,
                  kind: mark.kind,
                  ...(mark.provider ? { provider: mark.provider } : {}),
                  ...(mark.background === 'dark' || /white|[-_]ko[._-]/i.test(mark.url)
                    ? { background: 'dark' }
                    : {}),
                  ...(info.width ? { width: info.width } : {}),
                  ...(info.height ? { height: info.height } : {}),
                };
              } catch {
                return null;
              }
            }),
          );
          return [
            ...new Map(loaded.filter(Boolean).map((mark) => [mark.url, mark])).values(),
          ].slice(0, 2);
        };
        candidates = await collect(logos);
        if (!candidates.length) candidates = await collect(icons);
      } catch {
        // Keep known working bytes if a website is temporarily unavailable.
      }
      const fresh = candidates.length > 0;
      const hasLogo = candidates.some((mark) => mark.kind === 'logo');
      const entry = {
        version,
        candidates: fresh ? candidates : previous?.candidates || [],
        checkedAt: this.now(),
        expires: this.now() + (hasLogo ? this.ttlMs : this.retryMs),
      };
      this.remember(key, entry);
      try {
        await this.write(key + '.json', JSON.stringify(entry));
      } catch {
        // A read-only/full disk must not fail the customer library.
      }
      return entry;
    });
  }

  async write(name, body) {
    await mkdir(this.path, { recursive: true });
    const target = join(this.path, name);
    const temporary = target + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, body);
    await rename(temporary, target);
  }

  async asset(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    try {
      const body = await readFile(join(this.path, hash + '.bin'));
      if (digest(body) !== hash) return null;
      const info = inspectBrandImage(body);
      if (!info) return null;
      return { body, ...info, etag: '"' + hash + '"' };
    } catch {
      return null;
    }
  }
}
