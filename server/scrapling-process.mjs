import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// The shell has no children before joining the leaf and execs only fixed positional arguments.
const joinCgroup = 'printf "%s\\n" "$$" > "$1/cgroup.procs" || exit 125; shift; exec "$@"';
let pendingLinuxGroup;

const linuxGroupControls = {
  hasGroup(group) {
    try {
      process.kill(-group, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      throw error;
    }
  },
  list: () => readdir('/proc'),
  stat: (pid) => readFile('/proc/' + pid + '/stat', 'utf8'),
  now: () => performance.now(),
  wait: delay,
};

export async function waitForLinuxProcessGroupExit(group, controls = linuxGroupControls) {
  const deadline = controls.now() + 2000;
  const checkDeadline = () => {
    if (controls.now() >= deadline) throw new Error('Scrapling process group is still active');
  };
  while (controls.hasGroup(group)) {
    let live = false;
    for (const pid of await controls.list()) {
      checkDeadline();
      if (!/^\d+$/.test(pid)) continue;
      let stat;
      try {
        stat = await controls.stat(pid);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
        throw error;
      }
      const [state, , groupId] = stat.slice(stat.lastIndexOf(') ') + 2).split(' ', 4);
      if (groupId === String(group) && !['Z', 'X', 'x'].includes(state)) {
        live = true;
        break;
      }
    }
    if (!live) return;
    await controls.wait(20);
  }
}

export async function runScraplingWorker(
  executable,
  args,
  { env, input, signal, maxBuffer, cgroup },
) {
  const grouped = process.platform !== 'win32';
  const linuxFallback = process.platform === 'linux' && !cgroup;
  if (linuxFallback && pendingLinuxGroup) {
    try {
      await waitForLinuxProcessGroupExit(pendingLinuxGroup);
      pendingLinuxGroup = undefined;
    } catch {
      return { status: 'failed', failure_reason: 'worker_cleanup_failed' };
    }
    signal.throwIfAborted();
  }
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
      cleanup ??= (
        cgroup
          ? cgroup.close()
          : linuxFallback && child.pid
            ? waitForLinuxProcessGroupExit(child.pid)
            : undefined
      )?.catch(() => {
        if (linuxFallback) pendingLinuxGroup = child.pid;
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
