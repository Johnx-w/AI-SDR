import { spawn } from 'node:child_process';

// The shell has no children before joining the leaf and execs only fixed positional arguments.
const joinCgroup = 'printf "%s\\n" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"';

export function runScraplingWorker(executable, args, { env, input, signal, maxBuffer, cgroup }) {
  const grouped = process.platform !== 'win32';
  return new Promise((resolve) => {
    const child = spawn(
      cgroup ? '/bin/sh' : executable,
      cgroup ? ['-c', joinCgroup, 'scrapling', cgroup.path, executable, ...args] : args,
      {
        windowsHide: true,
        detached: grouped,
        stdio: ['pipe', 'pipe', 'ignore'],
        env,
      },
    );
    const output = [];
    let length = 0;
    let failure;
    let cleanup;
    function killTree() {
      if (!child.pid) return;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else if (child.exitCode === null) child.kill('SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') failure ||= error;
      }
    }
    function cleanupTree() {
      killTree();
      cleanup ??= cgroup?.close().catch(() => {
        child.stdout.destroy();
        return { failed: true };
      });
    }
    child.on('error', (error) => (failure ||= error));
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > maxBuffer) {
        failure ||= new Error('Scrapling output exceeded the byte limit');
        killTree();
      } else output.push(chunk);
    });
    child.on('exit', cleanupTree);
    child.on('close', async (code) => {
      signal.removeEventListener('abort', killTree);
      if (cgroup && !cleanup) cleanupTree();
      const isolation = (await cleanup) || {};
      const resources = isolation.resources;
      if (isolation.failed)
        return resolve({ status: 'failed', failure_reason: 'worker_cleanup_failed' });
      if (isolation.oom || (!cgroup && code === 74))
        return resolve({
          status: 'memory_limit',
          failure_reason: 'worker_memory_limit',
          resources,
        });
      if (code === 125)
        return resolve({
          status: 'unavailable',
          failure_reason: 'worker_isolation_unavailable',
          resources,
        });
      if (code === 127 || failure?.code === 'ENOENT')
        return resolve({ status: 'unavailable', failure_reason: 'worker_unavailable', resources });
      if (code !== 0 || failure)
        return resolve({ status: 'failed', failure_reason: 'worker_crashed', resources });
      try {
        const result = JSON.parse(Buffer.concat(output, length).toString('utf8'));
        resolve({ ...result, resources: { ...result.resources, ...resources } });
      } catch {
        resolve({ status: 'failed', failure_reason: 'worker_output_invalid', resources });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
    signal.addEventListener('abort', killTree, { once: true });
    if (signal.aborted) killTree();
  });
}
