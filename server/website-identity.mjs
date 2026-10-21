export function domainKey(value) {
  try {
    const u = new URL(value);
    const host = u.hostname
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\.$/, '');
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      !host.includes('.') ||
      /[:\d]$/.test(host)
    )
      return '';
    return host;
  } catch {
    return '';
  }
}
