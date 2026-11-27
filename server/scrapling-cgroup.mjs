import {
  accessSync,
  constants,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const mount = '/sys/fs/cgroup';
const scopes = [
  '/system.slice/shadeflow.service',
  '/system.slice/shadeflow-scrapling-probe.service',
];
const limit = 1024 ** 3;
const read = (path, file) => readFileSync(join(path, file), 'utf8').trim();
const write = (path, file, value) => writeFileSync(join(path, file), String(value));

export function scraplingCgroupParent(required) {
  if (process.platform !== 'linux') return null;
  let membership;
  try {
    membership = /^0::(.*)$/m.exec(readFileSync('/proc/self/cgroup', 'utf8'))?.[1];
  } catch (error) {
    if (!required) return null;
    throw error;
  }
  const scope = scopes.find((path) => membership === path || membership?.startsWith(path + '/'));
  if (scope && membership === scope + '/app' && statfsSync(mount).type === 0x63677270)
    return mount + scope;
  if (required || scope) throw new Error('Scrapling cgroup delegation unavailable');
  return null;
}

export function createScraplingCgroup(parent) {
  const path = join(parent, 'scrapling-worker');
  if (!read(parent, 'cgroup.subtree_control').split(/\s+/).includes('memory'))
    write(parent, 'cgroup.subtree_control', '+memory');
  mkdirSync(path);
  try {
    write(path, 'memory.max', limit);
    write(path, 'memory.swap.max', 0);
    write(path, 'memory.oom.group', 1);
    if (
      read(path, 'memory.max') !== String(limit) ||
      read(path, 'memory.swap.max') !== '0' ||
      read(path, 'memory.oom.group') !== '1' ||
      !/^oom \d+$/m.test(read(path, 'memory.events')) ||
      !/^\d+$/.test(read(path, 'memory.peak'))
    ) {
      throw new Error('Scrapling cgroup limits unavailable');
    }
    accessSync(join(path, 'cgroup.kill'), constants.W_OK);
  } catch (error) {
    rmdirSync(path);
    throw error;
  }
  return {
    path,
    async close() {
      write(path, 'cgroup.kill', 1);
      const deadline = performance.now() + 2000;
      while (!/^populated 0$/m.test(read(path, 'cgroup.events'))) {
        if (performance.now() >= deadline) throw new Error('Scrapling cgroup is still populated');
        await delay(20);
      }
      const events = read(path, 'memory.events');
      const peak = Number(read(path, 'memory.peak'));
      rmdirSync(path);
      return {
        oom: /^(?:oom|oom_kill|oom_group_kill) [1-9]\d*$/m.test(events),
        resources: { cgroup_limit_bytes: limit, cgroup_peak_bytes: peak },
      };
    },
  };
}
