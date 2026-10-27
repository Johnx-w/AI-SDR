import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMailboxSignature } from '../src/domain/mail-signature.mjs';
import { normalizeSignatureDesign, embedSignatureImages } from '../server/mail-signature.mjs';
import { normalizeReplyContent } from '../server/mail-content.mjs';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
const design = () => ({
  closing: 'Best regards,',
  companyName: 'Shuangsheng Shutter',
  address: 'Dongguan City, Guangdong Province, China 523000',
  website: 'https://shuangshengshutter.com',
  logo: { name: 'logo.png', contentType: 'image/png', contentBase64: png },
  logoWidth: 160,
});

test('signature form renders one escaped identity with linked contact details and preserves legacy text', () => {
  const mailbox = {
    displayName: 'Alice <Sales>',
    email: 'sl01@shuangshengshutter.com',
    signatureDesign: normalizeSignatureDesign(design()),
  };
  const rendered = renderMailboxSignature(mailbox);
  assert.match(rendered.text, /^Best regards,\nAlice <Sales>\nShuangsheng Shutter/);
  assert.match(rendered.html, /<strong>Alice &lt;Sales&gt;<\/strong>/);
  assert.match(rendered.html, /href="https:\/\/shuangshengshutter.com\/"/);
  assert.match(rendered.html, /href="mailto:sl01@shuangshengshutter.com"/);
  assert.match(rendered.html, /width="160"/);
  assert.equal((rendered.html.match(/<img /g) || []).length, 1);
  assert.deepEqual(renderMailboxSignature({ signature: 'Old <team>\nContact' }), {
    text: 'Old <team>\nContact',
    html: 'Old &lt;team&gt;<br>Contact',
  });
  assert.equal(
    normalizeSignatureDesign({ ...design(), website: 'company.example' }).website,
    'https://company.example/',
  );
});

test('signature boundary rejects active content, fake images, oversized uploads and unsupported layout', () => {
  for (const patch of [
    { website: 'javascript:alert(1)' },
    { website: 'https://user:pass@example.com' },
    { closing: 'Best\r\nBcc: outsider@example.com' },
    { logoWidth: 900 },
    { logoWidth: '160' },
    {
      logo: {
        ...design().logo,
        contentBase64: Buffer.from('<svg onload="alert(1)"></svg>').toString('base64'),
      },
    },
    { logo: { ...design().logo, contentType: 'image/jpeg' } },
    { logo: { ...design().logo, contentType: ['image/png'], contentBase64: [png] } },
    { logo: { ...design().logo, contentBase64: Buffer.alloc(256 * 1024 + 1).toString('base64') } },
    { logo: { ...design().logo, path: 'C:/secret' } },
    { html: '<script>bad()</script>' },
  ])
    assert.throws(() => normalizeSignatureDesign({ ...design(), ...patch }), { status: 400 });
});

test('reply drafts keep the validated logo, discard remote images and embed one CID part per image', () => {
  const signature = renderMailboxSignature({
    displayName: 'Alice',
    email: 'sales@example.com',
    signatureDesign: normalizeSignatureDesign(design()),
  });
  const content = normalizeReplyContent({
    bodyHtml: `<p>Hello Buyer</p>${signature.html}<img src="https://tracker.example/pixel"><img src="data:image/png;base64,bm90LXBuZw=="><img src="data:image/svg+xml;base64,PHN2Zz4=">`,
  });
  assert.match(content.bodyHtml, /<img src="data:image\/png/);
  assert.doesNotMatch(content.bodyHtml, /tracker|bm90LXBuZw|svg/);
  assert.match(content.bodyText, /Best regards,\nAlice\nShuangsheng Shutter/);
  assert.doesNotMatch(content.bodyText, /base64/);
  const embedded = embedSignatureImages(content.bodyHtml + signature.html);
  assert.equal(embedded.attachments.length, 1);
  assert.equal(embedded.attachments[0].contentDisposition, 'inline');
  assert.deepEqual(embedded.attachments[0].content, Buffer.from(png, 'base64'));
  assert.match(embedded.html, new RegExp(`cid:${embedded.attachments[0].cid}`));
  assert.doesNotMatch(embedded.html, /data:image/);
});
