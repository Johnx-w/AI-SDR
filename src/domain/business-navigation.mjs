import { overviewRange, taskBucket } from './overview-rules.mjs';

const states = ['pending', 'completed', 'skipped', 'cancelled'];

export function businessNavigation(params, now = Date.now()) {
  const tab = 'tasks';
  const state = states.includes(params.get('state')) ? params.get('state') : 'all';
  const bucket = ['overdue', 'today', 'due'].includes(params.get('bucket'))
    ? params.get('bucket')
    : '';
  const requestedAt = params.get('asOf');
  const asOf = requestedAt && Number.isFinite(Date.parse(requestedAt)) ? requestedAt : undefined;
  return {
    tab,
    state,
    bucket,
    focusedId: params.get('task') || '',
    range: overviewRange('7d', asOf || now),
    frozen: !!asOf,
  };
}

export function matchesTaskNavigation(task, navigation) {
  if (navigation.focusedId && task.id !== navigation.focusedId) return false;
  if (navigation.state !== 'all' && task.status !== navigation.state) return false;
  if (!navigation.bucket) return true;
  const bucket = taskBucket(task, navigation.range);
  return navigation.bucket === 'due'
    ? bucket === 'overdue' || bucket === 'today'
    : bucket === navigation.bucket;
}

export function updateBusinessNavigation(params, key, value) {
  const next = new URLSearchParams(params);
  if (['customerId', 'state', 'bucket', 'q'].includes(key)) {
    next.delete('task');
    if (key === 'state') {
      next.delete('bucket');
      next.delete('asOf');
    } else if (key === 'bucket') next.delete('state');
  }
  if (value && value !== 'all') next.set(key, value);
  else next.delete(key);
  if (key === 'bucket' && !value) next.delete('asOf');
  return next;
}
