import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = fileURLToPath(new URL('./docling/material_reader.py', import.meta.url));
const bundled = fileURLToPath(new URL('./docling/reader-linux', import.meta.url));
const vendor = fileURLToPath(new URL('../vendor/docling/', import.meta.url));
const projectPython = fileURLToPath(
  new URL(
    process.platform === 'win32' ? '../.venv/Scripts/python.exe' : '../.venv/bin/python',
    import.meta.url,
  ),
);
let pending = Promise.resolve();

// The conversion can materialize all embedded images. Run one conversion per server at a time.
export function convertDocument(bytes, extension) {
  const job = pending.then(
    () =>
      new Promise((resolve, reject) => {
        const packaged = existsSync(bundled);
        const command = packaged
          ? bundled
          : process.env.DOCLING_PYTHON ||
            (existsSync(projectPython)
              ? projectPython
              : process.platform === 'win32'
                ? 'python'
                : 'python3');
        const cache = join(tmpdir(), 'shadeflow-docling-' + (process.getuid?.() ?? 'local'));
        const worker = execFile(
          command,
          packaged ? [extension] : [source, extension],
          {
            windowsHide: true,
            timeout: 150000,
            maxBuffer: 96 * 1024 ** 2,
            encoding: 'buffer',
            env: {
              ...process.env,
              ...(!packaged && { PYTHONPATH: vendor, PYTHONDONTWRITEBYTECODE: '1' }),
              OPENBLAS_NUM_THREADS: '1',
              SCIE_BASE: cache,
              PEX_ROOT: join(cache, 'pex'),
            },
          },
          (error, stdout, stderr) => {
            if (error) {
              const limit = stderr?.toString().includes('每张工作表最多');
              return reject(
                Object.assign(
                  new Error(
                    limit
                      ? '每张工作表最多 20000 行、150 列'
                      : 'Docling 无法完整解析 ' +
                        extension.toUpperCase() +
                        ' 原件，请检查文件后重试。',
                  ),
                  { status: limit ? 413 : 422, cause: error },
                ),
              );
            }
            try {
              resolve(JSON.parse(stdout.toString('utf8')));
            } catch (cause) {
              reject(
                Object.assign(new Error('Docling 返回的文档结构不完整。'), { status: 502, cause }),
              );
            }
          },
        );
        worker.stdin.on('error', () => {}); // A rejected document can close the child before stdin drains.
        worker.stdin.end(bytes);
      }),
  );
  pending = job.catch(() => {});
  return job;
}
