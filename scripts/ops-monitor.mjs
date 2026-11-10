import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const HOUR = 3600000;
const statePath = '/var/lib/shadeflow-monitor/state.json';
const snapshotRoot = '/var/backups/shadeflow';

function tail(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const data = Buffer.alloc(Math.min(size, 4 * 1024 * 1024));
    readSync(fd, data, 0, data.length, size - data.length);
    return data.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

export function backupStatus(log, target = snapshotRoot) {
  const jobs = new Map();
  for (const line of log.split('\n')) {
    const id = /\btskid=(\S+)/.exec(line)?.[1];
    if (!id) continue;
    const job = jobs.get(id) || {};
    const filters =
      /first target item \[([^\]]*)\], include filter : \[([^\]]*)\], exclude filter : \[([^\]]*)\]/.exec(
        line,
      );
    if (filters) job.filters = filters.slice(1);
    if (/(?:FULL|INCR) backup completed successfully/.test(line))
      job.completedAt = Date.parse(/time="([^"]+)"/.exec(line)?.[1]);
    jobs.set(id, job);
  }
  const latest = [...jobs.values()]
    .filter((job) => Number.isFinite(job.completedAt))
    .sort((a, b) => b.completedAt - a.completedAt)[0];
  if (!latest?.filters) return { completedAt: latest?.completedAt, covered: null };
  const [source, includes, excludes] = latest.filters;
  const contains = (parent, child) =>
    parent === '/' ||
    child === parent.replace(/\/$/, '') ||
    child.startsWith(`${parent.replace(/\/$/, '')}/`);
  // shortcut: only the observed HBR absolute-directory format is accepted; recheck after plan/client changes.
  if (includes || !source.startsWith('/') || /[*?\[\],]/.test(source + excludes))
    return { completedAt: latest.completedAt, covered: null };
  const excluded = excludes
    .split(/\s+/)
    .filter(Boolean)
    .some((path) => contains(path, target) || contains(target, path));
  return { completedAt: latest.completedAt, covered: contains(source, target) && !excluded };
}

export async function notifyChanges(previous, issues, send, now = Date.now()) {
  const ids = Object.keys(issues).sort();
  const changed = JSON.stringify(ids) !== JSON.stringify(previous.ids || []);
  const reminder = ids.length > 0 && now - (previous.notifiedAt || 0) >= 24 * HOUR;
  if (!changed && !reminder) return { state: previous, sent: false };
  const recovered = (previous.ids || []).filter((id) => !ids.includes(id));
  await send({
    subject: ids.length ? '[AI-SDR 运维告警] 需要检查' : '[AI-SDR 运维恢复] 检查项已恢复',
    text: `检查时间：${new Date(now).toISOString()}\n\n${ids.length ? ids.map((id) => `${id}：${issues[id]}`).join('\n') : '此前告警项已恢复。'}${recovered.length ? `\n\n已恢复：${recovered.join('、')}` : ''}\n\n同一异常每24小时提醒一次，状态变化立即通知。此邮件不包含业务记录或密钥。`,
  });
  return { state: { ids, notifiedAt: now }, sent: true };
}

export async function inspect(config) {
  const issues = {};
  const observations = {};
  const probe = async (id, check) => {
    try {
      await check();
    } catch {
      issues[id] = '检查失败，需检查服务日志或文件权限';
    }
  };
  await probe('service', async () => {
    const active = execFileSync('systemctl', ['is-active', 'shadeflow.service'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const response = await fetch('http://127.0.0.1:14311/api/health', {
      signal: AbortSignal.timeout(5000),
    });
    assert(active === 'active' && response.ok && (await response.json()).ok === true);
    observations.service = 'healthy';
  });
  await probe('disk', () => {
    const disk = statfsSync('/var/backups');
    const used = 1 - disk.bavail / disk.blocks;
    observations.diskUsedPercent = Math.round(used * 100);
    if (used >= 0.85) issues.disk = '磁盘可用空间低于15%，请检查备份及日志容量';
    if (disk.files && disk.ffree / disk.files < 0.1) issues.disk = '可用 inode 低于10%';
  });
  let snapshot;
  await probe('local-backup', () => {
    const status = execFileSync(
      'systemctl',
      ['show', 'shadeflow-backup.service', '--property=Result', '--value'],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(status.trim(), 'success');
    snapshot = JSON.parse(readFileSync(`${snapshotRoot}/latest.json`, 'utf8'));
    assert(existsSync(snapshot.archive));
    const age = Date.now() - Date.parse(snapshot.completedAt);
    assert(Number.isFinite(age) && age >= 0 && age < 30 * HOUR);
    observations.localBackupAt = snapshot.completedAt;
  });
  await probe('cloud-backup', () => {
    assert.equal(
      execFileSync('systemctl', ['is-active', 'hbrclient.service'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
      'active',
    );
    const result = backupStatus(tail(config.backupLog));
    observations.cloudBackupAt = result.completedAt
      ? new Date(result.completedAt).toISOString()
      : null;
    if (result.covered !== true)
      issues['cloud-backup'] =
        '无法确认云备份日志覆盖 /var/backups/shadeflow，请检查计划和排除目录';
    if (!result.completedAt || Date.now() - result.completedAt > 30 * HOUR)
      issues['cloud-backup'] = '超过30小时没有成功云备份记录';
    if (
      snapshot &&
      result.completedAt < Date.parse(snapshot.startedAt) &&
      !existsSync('/var/lib/shadeflow-monitor/cloud-restore-verified.json')
    )
      issues['cloud-backup'] = '新备份副本尚未进入成功云备份；原 /srv 数据被基础版排除';
  });
  await probe('cloud-restore', () => {
    if (!existsSync('/var/lib/shadeflow-monitor/cloud-restore-verified.json')) {
      issues['cloud-restore'] =
        '尚未完成云端副本的隔离恢复验收；本机发布备份恢复通过不能替代云端验收';
      return;
    }
    const proof = JSON.parse(
      readFileSync('/var/lib/shadeflow-monitor/cloud-restore-verified.json', 'utf8'),
    );
    assert(proof.ok === true && typeof proof.sha256 === 'string' && proof.sha256.length === 64);
    observations.cloudRestoreAt = proof.verifiedAt;
  });
  return { issues, observations };
}

async function main() {
  const mode = process.argv[2] || 'run';
  assert(['run', '--check', '--test-email'].includes(mode));
  const config = JSON.parse(readFileSync('/srv/shadeflow/ops/monitor.json', 'utf8'));
  const send = async (message) => {
    const { OutreachMailboxes } = await import(
      '/srv/shadeflow/current/server/outreach-mailboxes.mjs'
    );
    // The shared credential reader chmods its key; keep that write off the business directory.
    const temporary = mkdtempSync(join(tmpdir(), 'shadeflow-ops-mail-'));
    try {
      for (const name of ['mailboxes.json', '.credential-key']) {
        copyFileSync(`/srv/shadeflow/app/.data/outreach/${name}`, join(temporary, name));
      }
      const mailboxes = new OutreachMailboxes({
        path: join(temporary, 'mailboxes.json'),
        seedPath: null,
      });
      const result = await mailboxes.send(config.mailboxId, {
        ...message,
        to: config.recipient,
        expectedAccount: config.mailboxEmail,
        messageId: `<ops-${randomUUID()}@${config.mailboxEmail.split('@')[1]}>`,
      });
      assert(
        result.accepted.includes(config.recipient) && result.rejected.length === 0,
        'SMTP 未接受收件人',
      );
    } finally {
      rmSync(temporary, { recursive: true });
    }
  };
  if (mode === '--test-email') {
    await send({
      subject: '[AI-SDR 运维测试] 邮箱告警通道验证',
      text: '这是一封经授权发送的运维测试邮件。接收地址已配置为本邮箱。此测试不触发获客、客户发信任务或业务数据变更。',
    });
    console.log(JSON.stringify({ testEmail: 'smtp-accepted', recipient: config.recipient }));
    return;
  }
  const result = await inspect(config);
  if (mode === '--check') {
    console.log(JSON.stringify(result));
    process.exitCode = Object.keys(result.issues).length ? 1 : 0;
    return;
  }
  mkdirSync('/var/lib/shadeflow-monitor', { recursive: true, mode: 0o700 });
  const previous = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  const notification = await notifyChanges(previous, result.issues, send);
  writeFileSync(`${statePath}.tmp`, JSON.stringify(notification.state), { mode: 0o600 });
  renameSync(`${statePath}.tmp`, statePath);
  console.log(JSON.stringify({ ...result, emailSent: notification.sent }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      'SHADEFLOW_MONITOR_FAILED：检查配置、发件邮箱状态和网络；未确认的通知将在下次重试',
    );
    process.exitCode = 1;
  });
}
