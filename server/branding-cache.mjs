import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { discoverBranding, websiteUrl } from './branding.mjs';
import { readPublicImage, inspectBrandImage } from './branding-image.mjs';

const assetPrefix = '/api/v1/branding/assets/';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const version = 1;

// Persist both the website mapping and image bytes; successful logos never expire.
export class BrandingCache {
  constructor({
    path = '.data/branding',
    discover = discoverBranding,
    readImage = readPublicImage,
    now = Date.now,
    retryMs = 30 * 60000,
    concurrency = 6,
  } = {}) {
    this.path = resolve(path);
    this.discover = discover;
    this.readImage = readImage;
    this.now = now;
    this.retryMs = retryMs;
    this.concurrency = concurrency;
    this.entries = new Map();
    this.pending = new Map();
    this.active = 0;
    this.waiters = [];
  }

  database() {
    if (this.db) return this.db;
    mkdirSync(this.path, { recursive: true });
    const db = new DatabaseSync(join(this.path, 'branding.sqlite'));
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS branding_assets (hash TEXT PRIMARY KEY, body BLOB NOT NULL);
        CREATE TABLE IF NOT EXISTS branding_sites (key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
      if (db.prepare('PRAGMA user_version').get().user_version < 1) {
        db.exec('BEGIN IMMEDIATE');
        try {
          this.importLegacy(db);
          db.exec('PRAGMA user_version=1; COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      }
      this.db = db;
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  importLegacy(db) {
    const names = readdirSync(this.path);
    const putAsset = db.prepare('INSERT OR IGNORE INTO branding_assets VALUES(?,?)');
    const putSite = db.prepare('INSERT OR IGNORE INTO branding_sites VALUES(?,?)');
    const hasAsset = db.prepare('SELECT 1 FROM branding_assets WHERE hash=?');
    for (const name of names.filter((name) => /^[a-f0-9]{64}\.bin$/.test(name))) {
      let body;
      try {
        body = readFileSync(join(this.path, name));
      } catch {
        continue;
      }
      const hash = name.slice(0, -4);
      if (digest(body) === hash && inspectBrandImage(body)) putAsset.run(hash, body);
    }
    for (const name of names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
      let entry;
      try {
        entry = JSON.parse(readFileSync(join(this.path, name), 'utf8'));
      } catch {
        continue;
      }
      if (entry?.version !== version || !Array.isArray(entry.candidates)) continue;
      entry.candidates = entry.candidates.filter(
        (mark) =>
          mark &&
          ['logo', 'website_icon'].includes(mark.kind) &&
          typeof mark.url === 'string' &&
          /^\/api\/v1\/branding\/assets\/[a-f0-9]{64}$/.test(mark.url) &&
          hasAsset.get(mark.url.slice(assetPrefix.length)),
      );
      // Retry old misses immediately; never migrate a temporary failure as durable data.
      if (entry.candidates.length) putSite.run(name.slice(0, -5), JSON.stringify(entry));
    }
  }

  async get(lead) {
    if (this.closed) throw new Error('企业 Logo 存储已关闭');
    const website = websiteUrl(lead.website || (lead.domain ? 'https://' + lead.domain : ''));
    if (!website) return { candidates: [] };
    const key = digest(website.hostname.replace(/^www\./, ''));
    // Simultaneous list/detail callers share discovery for the same website.
    if (this.pending.has(key)) return this.pending.get(key);
    const task = this.load(key, lead).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  async load(key, lead) {
    let entry = this.entries.get(key);
    if (!entry) {
      const row = this.database().prepare('SELECT data FROM branding_sites WHERE key=?').get(key);
      entry = row ? JSON.parse(row.data) : null;
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
    if (entry?.candidates.some((mark) => mark.kind === 'logo'))
      return { candidates: entry.candidates };
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
        void refresh.catch(() => {});
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
                this.database()
                  .prepare('INSERT OR REPLACE INTO branding_assets VALUES(?,?)')
                  .run(hash, image.body);
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
      const entry = {
        version,
        candidates: fresh ? candidates : previous?.candidates || [],
        checkedAt: this.now(),
        expires: this.now() + this.retryMs,
      };
      this.database()
        .prepare('INSERT OR REPLACE INTO branding_sites VALUES(?,?)')
        .run(key, JSON.stringify(entry));
      this.remember(key, entry);
      return entry;
    });
  }

  async asset(hash) {
    if (!/^[a-f0-9]{64}$/.test(hash)) return null;
    const row = this.database().prepare('SELECT body FROM branding_assets WHERE hash=?').get(hash);
    if (!row) return null;
    const body = Buffer.from(row.body);
    if (digest(body) !== hash) return null;
    const info = inspectBrandImage(body);
    if (!info) return null;
    return { body, ...info, etag: '"' + hash + '"' };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
    this.db?.close();
  }
}
