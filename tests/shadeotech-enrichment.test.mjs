import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { readHtmlResponse } from '../server/branding.mjs';
import {
  combineWebsiteEvidence,
  enrichmentFields,
  websiteTextExcerpt,
} from '../server/website-metadata.mjs';
import { checkExtractedCandidates } from '../server/n8n-acquisition.mjs';
import vm from 'node:vm';
import { mergeSupplementCode } from '../server/n8n-enrichment.mjs';
import { extractContacts } from '../server/contact-extractor.mjs';
const url = 'https://shadeotech.com/contact-shadeotech-window-fashions/';
const fixture = await readFile(
  new URL('./fixtures/shadeotech-contact.html', import.meta.url),
  'utf8',
);

test('明确标注 Fax 的 tel 链接和可见号码不进入电话字段，保留真正电话', () => {
  for (const content of [
    'Phone number: <a href="tel:4694993322">469-499-3322</a> Fax number: <a href="tel:4694993323">469-499-3323</a>',
    'Phone number: [469-499-3322](tel:4694993322) Fax number: [469-499-3323](tel:4694993323)',
  ]) {
    const c = extractContacts({ content, sourceUrl: url, country: 'United States' });
    assert.deepEqual(
      c.filter((x) => x.kind === 'phone').map((x) => x.normalized),
      ['+14694993322'],
    );
  }
});

test('Shadeotech 页尾三个社媒、地图地址和明确城市列表均可提取；不收录 Houzz 或后续商品列表', () => {
  const e = combineWebsiteEvidence([{ url, content: fixture }]);
  assert.deepEqual(e.social.map((s) => s.platform).sort(), ['Facebook', 'Instagram', 'WhatsApp']);
  assert.equal(e.social.find((s) => s.platform === 'WhatsApp').url, 'https://wa.me/14694993322');
  const a = e.addresses[0];
  assert.equal(a.street, '3235 Skylane Dr. Unit 111');
  assert.equal(a.city, 'Carrollton');
  assert.equal(a.region, 'TX');
  assert.equal(a.postal_code, '75006');
  assert.equal(a.country, 'United States');
  assert.equal(a.map_url, 'https://maps.app.goo.gl/PAFh2THBiuCAuuLJA');
  assert.equal(e.service_areas.length, 55);
  assert.ok(e.service_areas.some((x) => x.name === 'Dallas, TX'));
  assert.ok(e.service_areas.some((x) => x.name === 'Wylie, TX'));
  assert.ok(
    e.service_areas.every((x) => fixture.includes(x.quote) && fixture.includes(x.section_quote)),
  );
  assert.ok(!e.service_areas.some((x) => /Stock|Price|Hide similarities/.test(x.name)));
  const out = enrichmentFields({ company_name: 'Shadeotech' }, e).fields;
  assert.equal(out['城市'], 'Carrollton');
  assert.equal(out.WhatsApp, 'https://wa.me/14694993322');
  assert.equal(out.Facebook, 'https://www.facebook.com/shadeotech');
  assert.equal(out.Instagram, 'https://www.instagram.com/shadeotech');
  assert.equal(out['服务地区'].split('\n').length, 55);
  assert.equal(out.Houzz, undefined);
});
test('完整读取大于512KB页面的页尾；超过4MB明确失败而非成功返回残缺前缀', async () => {
  const prefix = Buffer.from('<html><body>' + ' '.repeat(1230000));
  const out = await readHtmlResponse(
    Readable.from([prefix, Buffer.from(fixture), Buffer.from('</body></html>')]),
  );
  assert.ok(out.html.includes('wa.me/14694993322'));
  assert.ok(out.html.endsWith('</body></html>'));
  await assert.rejects(
    readHtmlResponse(Readable.from([Buffer.alloc(4 * 1024 * 1024), Buffer.from('x')])),
    /读取上限/,
  );
});
test('内嵌图片不占用 Dify 正文窗口，保留真实联系证据及来源；同地址跨页合并不丢地图链接', () => {
  const content =
    '![](data:image/png;base64,' + 'A'.repeat(150000) + ')\n\nCompany products\n' + fixture;
  const p = checkExtractedCandidates({ source_url: url }, [
    { results: [{ url, raw_content: content }] },
  ]);
  assert.ok(p.page_text.includes('3235 Skylane'));
  assert.ok(!p.page_text.includes('data:image'));
  assert.ok(p.page_text.length <= 12000);
  assert.equal(p.source_url, url);
  assert.equal(p.has_text, true);
  const e = combineWebsiteEvidence([
    { url, content: fixture },
    {
      url: 'https://shadeotech.com/',
      content: '3235 Skylane Dr. Unit 111, Carrollton, TX, 75006.',
    },
  ]);
  assert.equal(e.addresses[0].map_url, 'https://maps.app.goo.gl/PAFh2THBiuCAuuLJA');
  const merged = vm.runInNewContext('(function(){' + mergeSupplementCode + '})()', {
    $: () => ({
      first: () => ({ json: { source_url: url, page_text: 'Contact', website_metadata: e } }),
    }),
    $input: {
      first: () => ({
        json: {
          results: [{ url, raw_content: '3235 Skylane Dr. Unit 111, Carrollton, TX, 75006.' }],
        },
      }),
    },
  });
  assert.equal(
    merged[0].json.website_metadata.addresses[0].map_url,
    'https://maps.app.goo.gl/PAFh2THBiuCAuuLJA',
  );
  assert.equal(websiteTextExcerpt('![](data:image/png;base64,AAAA)'), '');
});
