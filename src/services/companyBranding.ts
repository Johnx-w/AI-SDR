export interface CompanyMark {
  url: string;
  kind: 'logo' | 'website_icon';
  provider?: string;
  background?: 'dark' | 'light';
  sourceUrl?: string;
  width?: number;
  height?: number;
}

interface CachedBranding {
  marks: CompanyMark[];
  expiresAt: number;
}
type BrandingStorage = Pick<Storage, 'getItem' | 'setItem'>;
const storageKey = 'shadeflow.company-branding.v2';
const freshFor = 5 * 60 * 1000;
const retainFor = 24 * 60 * 60 * 1000;
const localAsset = /^\/api\/v1\/branding\/assets\/[a-z0-9-]+$/i;

// Ignore transparent canvas pixels and faint antialiasing; they do not describe the mark's color.
export function prefersDarkLogoBackground(pixels: Uint8ClampedArray): boolean {
  let visible = 0;
  let transparent = 0;
  let opacity = 0;
  let lightOpacity = 0;
  let darkOpacity = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const alpha = pixels[i + 3];
    if (alpha < 32) {
      transparent++;
      continue;
    }
    visible++;
    opacity += alpha;
    const channels = [pixels[i], pixels[i + 1], pixels[i + 2]];
    if (Math.min(...channels) >= 220 && Math.max(...channels) - Math.min(...channels) <= 32)
      lightOpacity += alpha;
    if (Math.max(...channels) <= 110) darkOpacity += alpha;
  }
  return (
    visible >= 6 &&
    opacity >= 4 * 255 &&
    transparent >= (pixels.length / 4) * 0.05 &&
    lightOpacity / opacity >= 0.35 &&
    darkOpacity / opacity <= 0.05
  );
}

export function logoContentBounds(pixels: Uint8ClampedArray, width: number, height: number) {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] < 16) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  if (right < left || bottom < top) return null;
  const contentWidth = right - left + 1;
  const contentHeight = bottom - top + 1;
  if (
    (contentWidth * contentHeight) / (width * height) >= 0.55 ||
    (contentWidth / width >= 0.7 && contentHeight / height >= 0.7)
  )
    return null;
  const padding = Math.max(1, Math.ceil(Math.max(contentWidth, contentHeight) * 0.04));
  left = Math.max(0, left - padding);
  top = Math.max(0, top - padding);
  right = Math.min(width - 1, right + padding);
  bottom = Math.min(height - 1, bottom + padding);
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

function browserStorage(): BrandingStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function validMarks(value: unknown): value is CompanyMark[] {
  return (
    Array.isArray(value) &&
    value.length <= 12 &&
    value.every(
      (mark) =>
        mark &&
        typeof mark.url === 'string' &&
        (localAsset.test(mark.url) || /^https:\/\//.test(mark.url)) &&
        ['logo', 'website_icon'].includes(mark.kind),
    )
  );
}

export class CompanyBrandingClient {
  private cache = new Map<string, CachedBranding>();
  private pending = new Map<string, Promise<CompanyMark[]>>();
  private hydrated = false;

  constructor(
    private fetcher: typeof fetch = (...args) => fetch(...args),
    private storage: () => BrandingStorage | undefined = browserStorage,
    private now: () => number = Date.now,
  ) {}

  private key(id: string, identity: string) {
    return JSON.stringify([id, identity]);
  }

  private hydrate() {
    if (this.hydrated) return;
    this.hydrated = true;
    try {
      const entries: unknown = JSON.parse(this.storage()?.getItem(storageKey) || '[]');
      if (!Array.isArray(entries)) return;
      for (const entry of entries.slice(-200)) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          validMarks(entry[1]?.marks) &&
          entry[1].marks.every((mark: CompanyMark) => localAsset.test(mark.url)) &&
          Number.isFinite(entry[1].expiresAt) &&
          entry[1].expiresAt + retainFor > this.now()
        )
          this.cache.set(entry[0], entry[1]);
      }
    } catch {
      // Storage may be disabled or cleared independently of this page.
    }
  }

  private persist() {
    try {
      const entries = [...this.cache]
        .filter(
          ([, entry]) =>
            entry.marks.length &&
            entry.expiresAt + retainFor > this.now() &&
            entry.marks.every((mark) => localAsset.test(mark.url)),
        )
        .slice(-200);
      this.storage()?.setItem(storageKey, JSON.stringify(entries));
    } catch {
      // A full or unavailable session store does not prevent logo loading.
    }
  }

  cached(id: string, identity = ''): CompanyMark[] {
    this.hydrate();
    const entry = this.cache.get(this.key(id, identity));
    return entry && entry.expiresAt + retainFor > this.now() ? entry.marks : [];
  }

  load(id: string, identity = ''): Promise<CompanyMark[]> {
    this.hydrate();
    const key = this.key(id, identity);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) return Promise.resolve(cached.marks);
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.fetcher('/api/v1/leads/real/' + encodeURIComponent(id) + '/branding', {
      signal: AbortSignal.timeout(20000),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('企业 Logo 暂时不可用');
        const result = await response.json();
        if (!validMarks(result.candidates)) throw new Error('企业 Logo 响应无效');
        const marks: CompanyMark[] = result.candidates;
        this.cache.set(key, {
          marks,
          expiresAt: this.now() + (marks.length ? freshFor : 60 * 1000),
        });
        while (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
        this.persist();
        return marks;
      })
      .catch(() => {
        const marks = this.cached(id, identity);
        this.cache.set(key, { marks, expiresAt: this.now() + 30000 });
        return marks;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }
}

export const companyBranding = new CompanyBrandingClient();
