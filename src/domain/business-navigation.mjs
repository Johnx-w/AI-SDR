import { activeDemand, overviewRange, taskBucket } from './overview-rules.mjs';

const states = {
  demands: [
    'active',
    'new',
    'clarifying',
    'quoting',
    'sampling',
    'negotiating',
    'won',
    'lost',
    'closed',
  ],
  tasks: ['pending', 'paused', 'completed', 'cancelled'],
  messages: ['inbound', 'outbound', 'note'],
};

export function businessNavigation(params, now = Date.now()) {
  const tab = Object.hasOwn(states, params.get('tab')) ? params.get('tab') : 'demands';
  const state = states[tab].includes(params.get('state')) ? params.get('state') : 'all';
  const bucket =
    tab === 'tasks' && ['overdue', 'today', 'paused', 'due'].includes(params.get('bucket'))
      ? params.get('bucket')
      : '';
  const requestedAt = params.get('asOf');
  const asOf = requestedAt && Number.isFinite(Date.parse(requestedAt)) ? requestedAt : undefined;
  return {
    tab,
    state,
    bucket,
    focusedId:
      params.get(tab === 'tasks' ? 'task' : tab === 'demands' ? 'demand' : 'message') || '',
    range: overviewRange('7d', asOf || now),
    frozen: !!asOf,
  };
}

export function matchesDemandNavigation(demand, navigation) {
  return (
    (!navigation.focusedId || demand.id === navigation.focusedId) &&
    (navigation.state === 'all' ||
      (navigation.state === 'active' ? activeDemand(demand) : demand.stage === navigation.state))
  );
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
  if (key === 'tab') {
    for (const name of ['state', 'bucket', 'asOf', 'task', 'demand', 'message', 'q'])
      next.delete(name);
  } else if (['customerId', 'productId', 'state', 'bucket', 'q'].includes(key)) {
    for (const name of ['task', 'demand', 'message']) next.delete(name);
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
