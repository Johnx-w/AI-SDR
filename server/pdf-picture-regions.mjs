// PDFium exposes the native object bounds on its WASM module. Coordinates start at
// the bottom left of the page. Keep extraction and the raster crop on the same page.
export function pictureRegions(page) {
  const { originalWidth: w, originalHeight: h } = page.getOriginalSize();
  const wasm = page.module,
    ptr = wasm._malloc(16),
    labels = [],
    images = [];
  try {
    for (const obj of page.objects()) {
      if (obj.type !== 'text' && obj.type !== 'image') continue;
      if (!wasm._FPDFPageObj_GetBounds(obj.objectIdx, ptr, ptr + 4, ptr + 8, ptr + 12)) continue;
      const [x, y, r, b] = new Float32Array(wasm.HEAPU8.buffer, ptr, 4);
      if (obj.type === 'text') {
        labels.push({ mid: (y + b) / 2, text: obj.getText() });
        continue;
      }
      if (r - x < 5 || b - y < 5 || (r - x) * (b - y) > w * h * 0.8) continue;
      images.push({
        y,
        b,
        box: [x / w, (h - b) / h, r / w, (h - y) / h].map((v) =>
          Math.min(1000, Math.max(0, Math.round(v * 1000))),
        ),
      });
    }
    return images.slice(0, 150).map(({ box, y, b }, id) => ({
      id,
      box,
      caption: labels
        .filter((t) => t.mid >= y && t.mid <= b)
        .map((t) => t.text)
        .join('')
        .slice(0, 1200),
    }));
  } finally {
    wasm._free(ptr);
  }
}
