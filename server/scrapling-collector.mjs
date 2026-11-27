import { execFile } from 'node:child_process';
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

const worker = fileURLToPath(new URL('./scrapling/worker.py', import.meta.url));
const bundledWorker = fileURLToPath(new URL('./scrapling/runtime-linux/worker', import.meta.url));
const bundledBrowsers = fileURLToPath(
  new URL('./scrapling/runtime-linux/browsers', import.meta.url),
);
const maxDocument = 4 * 1024 * 1024;
const maxResources = 30;
const allowed = new Set(['document', 'script', 'stylesheet', 'xhr', 'fetch']);
let active = false;

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

function runWorker(python, input, signal) {
  const safeEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:HOME|PATH|SYSTEMROOT|TEMP|TMP|USERPROFILE|LOCALAPPDATA|PLAYWRIGHT_BROWSERS_PATH)$/i.test(
        key,
      ),
    ),
  );
  safeEnv.PYTHONUTF8 = '1';
  if (!python) safeEnv.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== 'win32';
    const child = execFile(
      python || bundledWorker,
      python ? ['-I', '-X', 'utf8', worker] : [],
      {
        windowsHide: true,
        detached: grouped,
        maxBuffer: 6 * maxDocument,
        env: safeEnv,
      },
      (error, output) => {
        signal.removeEventListener('abort', cancel);
        if (error) cancel();
        if (error) return reject(error);
        try {
          resolve(JSON.parse(output));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
    function cancel() {
      if (!child.pid) return;
      if (grouped) {
        try {
          process.kill(-child.pid, 'SIGTERM');
          setTimeout(() => {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              // The worker exited during cleanup.
            }
          }, 1000).unref();
        } catch {
          child.kill('SIGKILL');
        }
      } else {
        execFile(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true },
          () => child.kill(),
        );
      }
    }
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

export async function collectScraplingPage(
  url,
  {
    reason = '',
    signal,
    python = process.env.SCRAPLING_PYTHON,
    readResourceImpl = readResource,
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
  if (!installed || active || availableMemory() < 1024 ** 3) {
    return { ...snapshot, status: 'unavailable' };
  }
  const timeout = AbortSignal.timeout(30000);
  const finished = new AbortController();
  const stop = AbortSignal.any([timeout, finished.signal, ...(signal ? [signal] : [])]);
  const { server, token, readChecked } = browserGateway(initial, stop, readResourceImpl);
  active = true;
  try {
    const document = await readChecked(initial.href, 'document');
    if (!document.body)
      return { ...snapshot, status: document.status === 403 ? 'blocked' : 'failed' };
    if (
      /<title>\s*(?:just a moment|access denied|security verification)[.\s!]*<\/title>/i.test(
        document.body.toString('utf8'),
      )
    )
      return { ...snapshot, status: 'blocked' };
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const result = await runWorker(
      python,
      {
        url: document.url,
        body: document.body.toString('base64'),
        type: document.type,
        gateway: 'http://127.0.0.1:' + server.address().port,
        token,
      },
      stop,
    );
    const final = websiteUrl(result.url);
    if (result.status !== 'ok' || !final || domainKey(final.href) !== domainKey(initial.href)) {
      const status = ['timeout', 'unavailable'].includes(result.status) ? result.status : 'failed';
      return { ...snapshot, status, resources: result.resources };
    }
    const { content, links, versions, resources } = result;
    const text = researchPageText(content, content.length);
    return {
      ...snapshot,
      final_url: final.href,
      acquired_at: new Date().toISOString(),
      status: hasUsableResearchText(text, content) ? 'ok' : 'failed',
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
      status: timeout.aborted ? 'timeout' : error.code === 'ENOENT' ? 'unavailable' : 'failed',
    };
  } finally {
    finished.abort();
    server.closeAllConnections();
    server.close();
    active = false;
  }
}
