// Preserve complete lines and sentences when possible, without splitting a decimal or surrogate pair.
export function* splitMaterialText(text, limit = 1600) {
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const breaks = [...window.matchAll(/\n|[。！？]|[.!?](?=\s)|\s+/gu)];
      const boundary = breaks.filter((m) => m.index >= limit / 2).at(-1);
      if (boundary) end = start + boundary.index + boundary[0].length;
      else if (/[\uD800-\uDBFF]/u.test(text[end - 1])) end--;
    }
    const part = text.slice(start, end).trim();
    if (part) yield part;
    start = end;
  }
}
