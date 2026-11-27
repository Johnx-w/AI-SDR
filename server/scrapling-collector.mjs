import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { availableMemory } from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  requestPublicWebsite,
  websiteUrl,
  websiteRedirectUrl,
  readWebsiteBytes,
} from './branding.mjs';
import { domainKey } from './website-identity.mjs';
import { researchPageText, hasUsableResearchText } from './research-pages.mjs';
import { createScraplingCgroup, scraplingCgroupParent } from './scrapling-cgroup.mjs';
import { releaseChromiumDirectory } from './scrapling-runtime.mjs';
import { runScraplingWorker } from './scrapling-process.mjs';

const worker = fileURLToPath(new URL('./scrapling/worker.py', import.meta.url));
const windowsJob = fileURLToPath(new URL('./scrapling/windows-job.py', import.meta.url));
const bundledWorker = fileURLToPath(new URL('./scrapling/runtime-linux/worker', import.meta.url));
const bundledBrowsers = fileURLToPath(
  new URL('./scrapling/runtime-linux/browsers', import.meta.url),
);
const maxDocument = 4 * 1024 * 1024;
const maxResources = 30;
const allowed = new Set(['document', 'script', 'stylesheet', 'xhr', 'fetch']);
let active = false;
const waiting = [];
const queueCapacity = 8;
const queueTimeoutMs = 30000;
const minAvailableMemory = 1024 ** 3;
let memoryCheck;

function dispatchBrowser() {
  if (active) return;
  clearTimeout(memoryCheck);
  const next = waiting[0];
  if (!next) return;
  if (next.availableMemoryImpl() < minAvailableMemory) {
    next.wait('low_memory');
    memoryCheck = setTimeout(dispatchBrowser, 250);
    return;
  }
  active = true;
  next.finish(true);
}

function requestBrowser({ availableMemoryImpl, onQueue, signal }) {
  if (signal?.aborted) return { resource_wait: { reason: 'aborted', wait_ms: 0 } };
  if (waiting.length >= queueCapacity)
    return { resource_wait: { reason: 'queue_full', wait_ms: 0 } };
  return new Promise((resolve) => {
    const started = performance.now();
    let reason;
    const notify = (state) => {
      try {
        onQueue?.(state);
      } catch {
        // A progress-write failure must release the browser queue.
      }
    };
    const entry = {
      availableMemoryImpl,
      wait(value) {
        if (reason === value) return;
        reason = value;
        notify({ reason });
      },
      finish(admitted, end) {
        waiting.splice(waiting.indexOf(entry), 1);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (reason) notify(null);
        resolve({
          admitted,
          ...(reason || end
            ? {
                resource_wait: {
                  reason: reason || end,
                  wait_ms: Math.round(performance.now() - started),
                  ...(end ? { end } : {}),
                },
              }
            : {}),
        });
        if (!admitted) dispatchBrowser();
      },
    };
    const abort = () => entry.finish(false, 'aborted');
    const timer = setTimeout(() => entry.finish(false, 'queue_timeout'), queueTimeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    waiting.push(entry);
    if (active || waiting.length > 1) entry.wait('browser_busy');
    dispatchBrowser();
  });
}

async function readResource(url, resource, signal) {
  return requestPublicWebsite(url, signal, {
    accept: resource === 'document' ? 'text/html' : '*/*',
    async handleResponse(response) {
      const type = response.headers['content-type'] || 'application/octet-stream';
      if (response.statusCode !== 200 || (resource === 'document' && !/html/i.test(type))) {
        response.destroy();
        return { status: response.statusCode };
      }
      return {
        status: 200,
        type,
        body: await readWebsiteBytes(
          response,
          resource === 'document' ? maxDocument : maxDocument / 2,
        ),
      };
    },
  });
}

function browserGateway(initial, signal, read) {
  const token = randomUUID();
  const domain = domainKey(initial.href);
  let count = 0;
  let remaining = 12 * 1024 * 1024;
  const readChecked = async (input, resource) => {
    let target = websiteUrl(input);
    for (let hop = 0; hop < 4; hop++) {
      signal.throwIfAborted();
      if (!target || domainKey(target.href) !== domain) return { status: 403 };
      target.hash = '';
      if (++count > maxResources || remaining <= 0) return { status: 429 };
      const response = await read(target, resource, signal);
      if (response.redirect) {
        target = websiteRedirectUrl(response.redirect, target);
        continue;
      }
      if (!response.body) return { status: response.status || 502 };
      remaining -= response.body.length;
      if (remaining < 0) return { status: 413 };
      return { ...response, url: target.href };
    }
    return { status: 403 };
  };
  // The worker holds the token, only it can ask for a resource. Browser requests
  // are fulfilled from bytes and never receive the local endpoint or token.
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' || request.headers.authorization !== 'Bearer ' + token) {
      response.writeHead(403).end();
      return;
    }
    try {
      const parameters = new URL(request.url, 'http://127.0.0.1').searchParams;
      const kind = parameters.get('kind');
      if (!allowed.has(kind) || kind === 'document') {
        response.writeHead(403).end();
        return;
      }
      const result = await readChecked(parameters.get('url'), kind);
      if (result.body) {
        response.writeHead(200, { 'content-type': result.type }).end(result.body);
      } else response.writeHead(result.status).end();
    } catch {
      response.writeHead(502).end();
    }
  });
  server.maxConnections = 4;
  return { server, token, readChecked };
}

function runWorker(python, workerScript, input, signal, parent) {
  const safeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:HOME|PATH|SYSTEMROOT|TEMP|TMP|USERPROFILE|LOCALAPPDATA|PLAYWRIGHT_BROWSERS_PATH)$/i.test(
        key,
      ),
    ),
  );
  safeEnv.PYTHONUTF8 = '1';
  if (!python) safeEnv.PLAYWRIGHT_BROWSERS_PATH = releaseChromiumDirectory(bundledBrowsers);
  const args = python ? ['-I', '-X', 'utf8', workerScript] : [];
  if (python && process.platform === 'win32') args.splice(3, 0, windowsJob);
  let cgroup;
  if (parent) {
    try {
      cgroup = createScraplingCgroup(parent);
      safeEnv.SCRAPLING_CGROUP_LIMITED = '1';
    } catch {
      return { status: 'unavailable', failure_reason: 'worker_isolation_unavailable' };
    }
  }
  return runScraplingWorker(python || bundledWorker, args, {
    env: safeEnv,
    input,
    signal,
    maxBuffer: 6 * maxDocument,
    cgroup,
  });
}

export async function collectScraplingPage(
  url,
  {
    reason = '',
    signal,
    python = process.env.SCRAPLING_PYTHON,
    workerScript = worker,
    offlineProbe = false,
    readResourceImpl = readResource,
    availableMemoryImpl = availableMemory,
    onQueue,
  } = {},
) {
  const snapshot = {
    requested_url: String(url),
    final_url: null,
    acquired_at: new Date().toISOString(),
    method: 'scrapling',
    status: 'blocked',
    content: '',
    content_hash: null,
    reason,
  };
  const initial = websiteUrl(url);
  if (!initial || !domainKey(initial.href)) return snapshot;
  const installed =
    python || (process.platform === 'linux' && existsSync(bundledWorker) && bundledWorker);
  if (!installed)
    return { ...snapshot, status: 'unavailable', failure_reason: 'worker_unavailable' };
  let parent;
  try {
    parent = scraplingCgroupParent(
      !offlineProbe && (!python || process.env.NODE_ENV === 'production'),
    );
  } catch {
    return { ...snapshot, status: 'unavailable', failure_reason: 'worker_isolation_unavailable' };
  }
  const { admitted, resource_wait } = await requestBrowser({
    availableMemoryImpl,
    onQueue,
    signal,
  });
  if (resource_wait) snapshot.resource_wait = resource_wait;
  if (!admitted)
    return {
      ...snapshot,
      status: 'deferred',
      failure_reason: resource_wait.end || resource_wait.reason,
    };
  const timeout = AbortSignal.timeout(30000);
  const finished = new AbortController();
  const stop = AbortSignal.any([timeout, finished.signal, ...(signal ? [signal] : [])]);
  const { server, token, readChecked } = browserGateway(initial, stop, readResourceImpl);
  const stopped = () =>
    timeout.aborted && stop.reason === timeout.reason
      ? { status: 'timeout', failure_reason: 'worker_timeout' }
      : { status: 'deferred', failure_reason: 'aborted' };
  let failureReason = 'document_read_failed';
  try {
    const document = await readChecked(initial.href, 'document');
    stop.throwIfAborted();
    if (!document.body)
      return {
        ...snapshot,
        status: document.status === 403 ? 'blocked' : 'failed',
        ...(document.status === 403 ? {} : { failure_reason: failureReason }),
      };
    if (
      /<title>\s*(?:just a moment|access denied|security verification)[.\s!]*<\/title>/i.test(
        document.body.toString('utf8'),
      )
    )
      return { ...snapshot, status: 'blocked' };
    failureReason = 'worker_failed';
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    stop.throwIfAborted();
    const result = await runWorker(
      python,
      workerScript,
      {
        url: document.url,
        body: document.body.toString('base64'),
        type: document.type,
        gateway: 'http://127.0.0.1:' + server.address().port,
        token,
      },
      stop,
      parent,
    );
    if (
      stop.aborted &&
      result.status !== 'memory_limit' &&
      result.failure_reason !== 'worker_cleanup_failed'
    )
      return { ...snapshot, ...stopped(), resources: result.resources };
    const final = websiteUrl(result.url);
    if (result.status !== 'ok' || !final || domainKey(final.href) !== domainKey(initial.href)) {
      const status = ['timeout', 'unavailable', 'memory_limit'].includes(result.status)
        ? result.status
        : 'failed';
      return {
        ...snapshot,
        status,
        failure_reason:
          result.failure_reason ||
          ({ timeout: 'page_timeout', unavailable: 'worker_unavailable' }[status] ??
            'worker_failed'),
        resources: result.resources,
      };
    }
    const { content, links, versions, resources } = result;
    const text = researchPageText(content, content.length);
    const usable = result.has_body_text && hasUsableResearchText(text, content);
    return {
      ...snapshot,
      final_url: final.href,
      acquired_at: new Date().toISOString(),
      status: usable ? 'ok' : 'failed',
      ...(usable ? {} : { failure_reason: 'page_evidence_missing' }),
      content,
      content_hash: createHash('sha256').update(content).digest('hex'),
      raw_content: document.body.toString('utf8'),
      links,
      versions,
      resources,
    };
  } catch (error) {
    return {
      ...snapshot,
      ...(stop.aborted
        ? stopped()
        : error.code === 'ENOENT' && failureReason === 'worker_failed'
          ? { status: 'unavailable', failure_reason: 'worker_unavailable' }
          : { status: 'failed', failure_reason: failureReason }),
    };
  } finally {
    finished.abort();
    server.closeAllConnections();
    server.close();
    active = false;
    dispatchBrowser();
  }
}
