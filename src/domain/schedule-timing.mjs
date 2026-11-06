export const weekdays = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

export function scheduleWeekdays(timing) {
  // Old weekly plans repeat on their start date's weekday.
  return timing.weekdays === undefined
    ? [new Date(`${timing.startDate}T00:00:00Z`).getUTCDay() || 7]
    : timing.weekdays;
}

export function scheduleRepeatLabel(timing) {
  if (timing.repeat !== 'weekly') return timing.repeat === 'daily' ? '每天' : '仅执行一次';
  const selected = scheduleWeekdays(timing);
  if (selected.length === 7) return '每天';
  return selected.length
    ? '每周' +
        weekdays
          .filter(({ value }) => selected.includes(value))
          .map(({ label }) => label.slice(1))
          .join('、')
    : '每周（待选星期）';
}

const fail = (status, message) => Object.assign(new Error(message), { status });
const day = 86400000;

// Older plans stored one `time`; new plans store a minute-precision list.
function timingTimes(timing) {
  return Array.isArray(timing.times) ? timing.times : [timing.time];
}

export function validateTiming(timing, now = Date.now()) {
  if (
    !timing ||
    !['once', 'daily', 'weekly'].includes(timing.repeat) ||
    !/^20\d\d-\d{2}-\d{2}$/.test(timing.startDate || '') ||
    (timing.timezone && timing.timezone !== 'Asia/Shanghai')
  )
    throw fail(400, '请选择有效的日期、时间和执行周期（北京时间）');
  if (timing.times !== undefined && !Array.isArray(timing.times))
    throw fail(400, '执行时间须为时间点列表');
  const selected = timingTimes(timing);
  if (
    !selected.length ||
    selected.length > 24 ||
    selected.some((time) => typeof time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
  )
    throw fail(400, '请设置 1–24 个执行时间，精确到分钟');
  if (timing.repeat === 'once' && selected.length !== 1)
    throw fail(400, '仅执行一次只能设置一个时间点');
  if (new Set(selected).size !== selected.length) throw fail(400, '执行时间不能重复');
  const times = [...selected].sort();
  const normalized = {
    repeat: timing.repeat,
    startDate: timing.startDate,
    times,
    timezone: 'Asia/Shanghai',
  };
  const first = Date.parse(`${normalized.startDate}T${times[0]}:00+08:00`);
  if (
    !Number.isFinite(first) ||
    new Date(first + 8 * 3600000).toISOString().slice(0, 10) !== normalized.startDate
  )
    throw fail(400, '执行日期无效');
  if (normalized.repeat === 'weekly') {
    const weekdays = scheduleWeekdays(timing);
    if (
      !Array.isArray(weekdays) ||
      !weekdays.length ||
      weekdays.length > 7 ||
      weekdays.some((value) => !Number.isInteger(value) || value < 1 || value > 7) ||
      new Set(weekdays).size !== weekdays.length
    )
      throw fail(400, '每周执行请选择 1–7 个不重复的星期');
    normalized.weekdays = [...weekdays].sort((a, b) => a - b);
  }
  if (normalized.repeat === 'once' && first <= now)
    throw fail(400, '指定日期的所有执行时间必须晚于当前时间');
  return normalized;
}

export function nextOccurrence(timing, after) {
  const interval = (timing.repeat === 'weekly' ? 7 : 1) * day;
  const startWeekday = new Date(`${timing.startDate}T00:00:00Z`).getUTCDay() || 7;
  const offsets =
    timing.repeat === 'weekly'
      ? scheduleWeekdays(timing).map((weekday) => (weekday - startWeekday + 7) % 7)
      : [0];
  const candidates = offsets.flatMap((offset) =>
    timingTimes(timing).flatMap((time) => {
      const first = Date.parse(`${timing.startDate}T${time}:00+08:00`) + offset * day;
      if (first > after) return [first];
      if (timing.repeat === 'once') return [];
      return [first + (Math.floor((after - first) / interval) + 1) * interval];
    }),
  );
  return candidates.length ? new Date(Math.min(...candidates)).toISOString() : null;
}
