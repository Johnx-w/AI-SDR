const operations = ['list', 'detail', 'export', 'refresh'];
const rounded = (value) => Math.round(value * 100) / 100;

// Fixed categories and a bounded timing window keep customer data out of metrics.
export class LeadPerformance {
  constructor({ sampleLimit = 200 } = {}) {
    if (!Number.isInteger(sampleLimit) || sampleLimit < 1 || sampleLimit > 10000)
      throw new TypeError('Invalid performance sample limit');
    this.sampleLimit = sampleLimit;
    this.entries = new Map();
  }

  record(operation, { durationMs, bytes = 0, error = false }) {
    if (!operations.includes(operation)) throw new TypeError('Unknown customer operation');
    if (!Number.isFinite(durationMs) || durationMs < 0 || !Number.isFinite(bytes) || bytes < 0)
      throw new TypeError('Invalid customer performance measurement');
    const entry = this.entries.get(operation) || {
      count: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      samples: [],
    };
    entry.count++;
    entry.errors += error ? 1 : 0;
    entry.totalMs += durationMs;
    entry.lastMs = durationMs;
    entry.maxMs = Math.max(entry.maxMs, durationMs);
    entry.lastBytes = bytes;
    entry.samples.push(durationMs);
    if (entry.samples.length > this.sampleLimit) entry.samples.shift();
    this.entries.set(operation, entry);
  }

  snapshot() {
    return Object.fromEntries(
      operations.map((operation) => {
        const entry = this.entries.get(operation);
        const samples = entry ? [...entry.samples].sort((a, b) => a - b) : [];
        return [
          operation,
          {
            count: entry?.count || 0,
            errors: entry?.errors || 0,
            lastMs: entry ? rounded(entry.lastMs) : null,
            averageMs: entry ? rounded(entry.totalMs / entry.count) : null,
            p95Ms: samples.length ? rounded(samples[Math.ceil(samples.length * 0.95) - 1]) : null,
            maxMs: entry ? rounded(entry.maxMs) : null,
            lastBytes: entry?.lastBytes ?? null,
            sampleCount: samples.length,
          },
        ];
      }),
    );
  }
}
