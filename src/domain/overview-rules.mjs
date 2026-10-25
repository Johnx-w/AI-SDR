const dayMs = 86400000;
const offsetMs = 8 * 3600000;
const fail = (message) => Object.assign(new Error(message), { status: 400 });

export function overviewRange(period = '7d', at = Date.now()) {
  if (!['today', '7d', '30d'].includes(period)) throw fail('请选择今日、近 7 天或近 30 天');
  const time = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(time)) throw fail('统计时间无效');
  const today = Math.floor((time + offsetMs) / dayMs) * dayMs - offsetMs;
  const days = period === 'today' ? 1 : period === '7d' ? 7 : 30;
  return {
    period,
    label: period === 'today' ? '今日' : `近 ${days} 天`,
    start: new Date(today - (days - 1) * dayMs).toISOString(),
    end: new Date(time).toISOString(),
    todayStart: new Date(today).toISOString(),
    todayEnd: new Date(today + dayMs).toISOString(),
    asOf: new Date(time).toISOString(),
  };
}

export function taskBucket(task, range) {
  if (task.status === 'paused') return 'paused';
  if (task.status !== 'pending') return '';
  const due = Date.parse(task.dueAt);
  if (!Number.isFinite(due)) return '';
  if (due < Date.parse(range.asOf)) return 'overdue';
  if (due < Date.parse(range.todayEnd)) return 'today';
  return '';
}

export function activeDemand(demand) {
  return ['new', 'clarifying', 'quoting', 'sampling', 'negotiating'].includes(demand.stage);
}
