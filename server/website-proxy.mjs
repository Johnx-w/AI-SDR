import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
let systemProxy;
let checkedAt = 0;

export function parseWindowsWebsiteProxy(enabled, server) {
  if (Number(enabled) !== 1) return '';
  const entries = String(server || '')
    .trim()
    .split(';');
  const https = entries.find((entry) => /^https=/i.test(entry.trim()));
  const address = https ? https.trim().slice(6) : entries.find((entry) => !entry.includes('='));
  if (!address?.trim()) return '';
  return /^https?:\/\//i.test(address.trim()) ? address.trim() : 'http://' + address.trim();
}

async function windowsProxy() {
  if (Date.now() - checkedAt < 30000) return systemProxy;
  try {
    const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const read = async (name) => {
      const { stdout } = await run('reg.exe', ['query', key, '/v', name], {
        windowsHide: true,
        timeout: 2000,
      });
      return stdout.match(/REG_(?:DWORD|SZ)\s+([^\r\n]+)/)?.[1]?.trim() || '';
    };
    const [enabled, server] = await Promise.all([read('ProxyEnable'), read('ProxyServer')]);
    systemProxy = parseWindowsWebsiteProxy(enabled, server);
  } catch {
    systemProxy = '';
  }
  checkedAt = Date.now();
  return systemProxy;
}

// This is confined to public website reads; API credentials never use this route.
export async function websiteProxyUrl() {
  const value =
    process.env.WEBSITE_HTTPS_PROXY?.trim() ||
    (process.platform === 'win32' ? await windowsProxy() : '');
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) throw new Error();
    return url;
  } catch {
    throw new Error('官网代理地址无效，须使用 HTTP 或 HTTPS 代理');
  }
}
