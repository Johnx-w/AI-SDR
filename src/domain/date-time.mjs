const beijingClock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatBeijingTime(value, fallback = '时间未知') {
  if (value === undefined || value === null || value === '') return fallback;
  let input = value;
  if (typeof input === 'string') {
    input = input.trim();
    if (!input) return fallback;
    if (/^\d{13}$/.test(input)) input = Number(input);
    // Local dates entered in the Chinese workspace always mean Beijing time.
    else if (/^\d{4}-\d{2}-\d{2}$/.test(input)) input += 'T00:00:00+08:00';
    else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(input))
      input = input.replace(' ', 'T') + '+08:00';
  }
  const date = new Date(input);
  if (!Number.isFinite(date.getTime())) return fallback;
  const parts = Object.fromEntries(
    beijingClock.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}（北京时间）`;
}

export function formatBeijingText(value) {
  const text = String(value ?? '');
  // Keep URLs intact; timestamps in source links identify the original evidence.
  return text.replace(
    /https?:\/\/[^\s<>"'）)]+|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/g,
    (match) => (/^https?:\/\//.test(match) ? match : formatBeijingTime(match, match)),
  );
}
