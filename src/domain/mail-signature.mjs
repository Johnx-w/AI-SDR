export const MAX_SIGNATURE_LOGO_BYTES = 256 * 1024;

export const signaturePlainTextHtml = (value) =>
  value
    .replace(
      /[&<>"']/g,
      (character) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
    )
    .replace(/\r?\n/g, '<br>');

export function renderMailboxSignature(mailbox) {
  const design = mailbox.signatureDesign;
  if (!design) {
    const text = mailbox.signature || '';
    return { text, html: signaturePlainTextHtml(text) };
  }
  const name = mailbox.displayName || '';
  const email = mailbox.email || '';
  const fields = [design.closing, name, design.companyName, design.address, design.website, email];
  const text = fields.filter(Boolean).join('\n');
  const html = fields
    .map((value, index) => {
      if (!value) return '';
      const escaped = signaturePlainTextHtml(value);
      if (index === 1) return `<strong>${escaped}</strong>`;
      if (index === 4) {
        try {
          const url = new URL(value);
          if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password)
            return `<a href="${signaturePlainTextHtml(url.href)}">${escaped}</a>`;
        } catch {}
      }
      if (index === 5) return `<a href="mailto:${escaped}">${escaped}</a>`;
      return escaped;
    })
    .filter(Boolean)
    .join('<br>');
  const logo = design.logo;
  const image = logo
    ? `<br><br><img src="data:${signaturePlainTextHtml(logo.contentType)};base64,${signaturePlainTextHtml(logo.contentBase64)}" width="${design.logoWidth}" alt="${signaturePlainTextHtml(design.companyName || 'Company logo')}">`
    : '';
  return { text, html: `<div>${html}${image}</div>` };
}
