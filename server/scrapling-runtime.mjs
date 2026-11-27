import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const chromiumRevisionDirectory = 'chromium_headless_shell-1255';
export const chromiumVersion = '159.0.8154.6';
export const chromiumExecutable =
  chromiumRevisionDirectory + '/chrome-headless-shell-linux64/chrome-headless-shell';
const installation = '/opt/shadeflow/chromium';

function rootOwned(path) {
  const info = lstatSync(path);
  assert(
    info.uid === 0 && (info.mode & 0o022) === 0 && !info.isSymbolicLink(),
    '官网采集浏览器路径必须归 root 管理且不能被其他账户改写：' + path,
  );
  return info;
}

export function releaseChromiumDirectory(bundled) {
  try {
    lstatSync(installation);
  } catch (error) {
    if (error.code === 'ENOENT') return bundled;
    throw error;
  }
  const executable = join(installation, chromiumExecutable);
  assert(rootOwned(executable).isFile(), '官网采集缺少锁定的系统浏览器：' + executable);
  for (let path = dirname(executable); path !== '/'; path = dirname(path)) {
    assert(rootOwned(path).isDirectory(), '官网采集浏览器父路径必须为普通目录：' + path);
  }
  return installation;
}

async function fileDigest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function verifyBrowserTree(approved, installed) {
  const source = lstatSync(approved);
  const target = rootOwned(installed);
  if (source.isDirectory()) {
    assert(target.isDirectory(), '官网采集系统浏览器目录结构不符：' + installed);
    const names = readdirSync(approved).sort();
    assert.deepEqual(readdirSync(installed).sort(), names, '官网采集系统浏览器文件列表不符');
    for (const name of names) await verifyBrowserTree(join(approved, name), join(installed, name));
  } else {
    assert(source.isFile() && target.isFile(), '官网采集系统浏览器只允许普通文件：' + installed);
    assert.equal(
      await fileDigest(installed),
      await fileDigest(approved),
      '官网采集系统浏览器与本次发布包不一致：' + installed,
    );
  }
}

export async function verifyReleaseChromium(bundled) {
  const selected = releaseChromiumDirectory(bundled);
  if (selected !== bundled) {
    const tree = dirname(chromiumExecutable);
    await verifyBrowserTree(join(bundled, tree), join(selected, tree));
  }
  return selected;
}
