import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, writeSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function deploymentCommand(command) {
  const match = /^deploy ([a-f0-9]{40}) ([a-f0-9]{64})$/.exec(command || '');
  assert(match, '部署密钥仅允许deploy及完整提交号和SHA256');
  return { revision: match[1], digest: match[2] };
}

async function main() {
  const { revision, digest } = deploymentCommand(process.env.SSH_ORIGINAL_COMMAND);
  const incoming = '/srv/shadeflow/incoming';
  mkdirSync(incoming, { recursive: true, mode: 0o700 });
  const upload = randomUUID() + '.tar';
  const archive = join(incoming, upload);
  const fd = openSync(archive, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  try {
    try {
      for await (const chunk of process.stdin) {
        size += chunk.length;
        assert(size <= 512 * 1024 * 1024, '发布包超过512MB');
        hash.update(chunk);
        writeSync(fd, chunk);
      }
    } finally {
      closeSync(fd);
    }
    assert(size > 0 && hash.digest('hex') === digest, '发布包为空或SHA256不符');
    execFileSync(
      process.execPath,
      ['/srv/shadeflow/ops/release-server.mjs', 'deploy-cd', revision, digest, upload],
      { stdio: 'inherit' },
    );
  } finally {
    rmSync(archive, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
