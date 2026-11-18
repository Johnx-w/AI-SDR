import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { build } from 'vite';

test('首页懒加载脚本和样式的 Brotli 内容与最终发布文件逐字节一致', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'shadeflow-precompress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), '<script type="module" src="/main.js"></script>');
  await writeFile(join(root, 'main.js'), 'import("./dashboard.js")');
  await writeFile(
    join(root, 'dashboard.js'),
    'import "./dashboard.css"; document.title = "工作台";',
  );
  await writeFile(join(root, 'dashboard.css'), 'body { color: green; }');
  await build({
    root,
    configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
    logLevel: 'silent',
  });
  const assets = join(root, 'dist', 'assets');
  const files = (await readdir(assets)).filter((name) => /\.(js|css)$/.test(name));
  assert.ok(files.filter((name) => name.endsWith('.js')).length >= 2);
  assert.ok(files.some((name) => name.endsWith('.css')));
  for (const name of files) {
    const raw = await readFile(join(assets, name));
    const decoded = brotliDecompressSync(await readFile(join(assets, name + '.br')));
    assert.ok(raw.equals(decoded), name + ' 的压缩版本与原文件不同');
  }
});
