export const weekdays = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' },
];

export function scheduleRepeatLabel(timing) {
  if (timing.repeat === 'once') return '仅执行一次';
  const selected = timing.weekdays;
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

const defaultZone = 'Asia/Shanghai';

export function scheduleZoneLabel(timezone = defaultZone) {
  if (timezone === defaultZone) return '北京时间';
  try {
    return (
      new Intl.DateTimeFormat('zh-CN', { timeZone: timezone, timeZoneName: 'longGeneric' })
        .formatToParts()
        .find((part) => part.type === 'timeZoneName')?.value || timezone
    );
  } catch {
    return timezone;
  }
}

export function scheduleDate(timezone = defaultZone, now = Date.now()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: timezone }).format(now);
}

function wallClock(timezone) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const wall = (instant) => formatter.format(instant).replace(' ', 'T');
  return (date, time) => {
    const local = date + 'T' + time;
    const nominal = Date.parse(local + 'Z');
    if (timezone === defaultZone) return nominal - 8 * 3600000;
    // An ambiguous time runs once at the earlier instant; a skipped time has no occurrence.
    const candidates = [nominal - day, nominal + day].map(
      (sample) => nominal - (Date.parse(wall(sample) + 'Z') - sample),
    );
    return Math.min(...candidates.filter((candidate) => wall(candidate) === local));
  };
}

export function validateTiming(timing, now = Date.now()) {
  if (
    !timing ||
    !['once', 'weekly'].includes(timing.repeat) ||
    !/^20\d\d-\d{2}-\d{2}$/.test(timing.startDate || '')
  )
    throw fail(400, '请选择有效的日期、时间和执行周期');
  if (!Array.isArray(timing.times)) throw fail(400, '执行时间须为时间点列表');
  const selected = timing.times;
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
  const timezone = timing.timezone ?? defaultZone;
  if (typeof timezone !== 'string' || !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z_+-]+)+)$/.test(timezone))
    throw fail(400, '请选择有效的排程时区');
  let occurrence;
  try {
    occurrence = wallClock(timezone);
  } catch {
    throw fail(400, '请选择有效的排程时区');
  }
  if (timing.waitForPrevious !== undefined && typeof timing.waitForPrevious !== 'boolean')
    throw fail(400, '请明确是否等待前一轮执行');
  const normalized = {
    repeat: timing.repeat,
    startDate: timing.startDate,
    times,
    timezone,
    ...(timing.waitForPrevious ? { waitForPrevious: true } : {}),
  };
  const date = Date.parse(normalized.startDate + 'T00:00Z');
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== normalized.startDate)
    throw fail(400, '执行日期无效');
  if (normalized.repeat === 'weekly') {
    const weekdays = timing.weekdays;
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
  if (normalized.repeat === 'once') {
    const first = occurrence(normalized.startDate, times[0]);
    if (!Number.isFinite(first)) throw fail(400, '该时区在指定日期没有这个时间点');
    if (first <= now) throw fail(400, '指定日期的执行时间必须晚于当前时间');
  }
  return normalized;
}

export function nextOccurrence(timing, after) {
  const timezone = timing.timezone ?? defaultZone;
  const occurrence = wallClock(timezone);
  if (timing.repeat === 'once') {
    const instant = occurrence(timing.startDate, timing.times[0]);
    return instant > after && Number.isFinite(instant) ? new Date(instant).toISOString() : null;
  }
  const date = [timing.startDate, scheduleDate(timezone, after)].sort().at(-1);
  const firstDay = Date.parse(date + 'T00:00Z');
  // Include the following week if the only selected time falls in a daylight-saving gap.
  for (let offset = 0; offset <= 14; offset++) {
    const current = new Date(firstDay + offset * day);
    if (!timing.weekdays.includes(current.getUTCDay() || 7)) continue;
    const localDate = current.toISOString().slice(0, 10);
    const instant = Math.min(
      ...timing.times.map((time) => occurrence(localDate, time)).filter((time) => time > after),
    );
    if (Number.isFinite(instant)) return new Date(instant).toISOString();
  }
  return null;
}
