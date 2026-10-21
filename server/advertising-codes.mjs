// Read public tracking configuration from HTML; never execute third-party scripts.
export function extractAdvertisingCodes(content, sourceUrl) {
  const html = String(content || '');
  const snippets = [
    ...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>|<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi),
  ].map((m) => m[0]);
  const rules = [
    ['Google Ads', /(?:gtag\s*\([^)]{0,120}?|(?:src|id)\s*[=:][^>]{0,150}?)\b(AW-\d{5,20})\b/gi],
    ['Meta Pixel', /fbq\s*\(\s*["']init["']\s*,\s*["'](\d{5,25})["']/gi],
    ['Meta Pixel', /facebook\.com\/tr\?[^"'<>]*?\bid=(\d{5,25})/gi],
    [
      'Microsoft UET',
      /\bti\s*[:=]\s*["']?(\d{5,20})["']?[^;]{0,200}?(?:uetq|UET)|(?:uetq|UET)[^;]{0,200}?\bti\s*[:=]\s*["']?(\d{5,20})/gi,
    ],
    ['LinkedIn Insight', /_linkedin_partner_id\s*=\s*["']?(\d{3,20})/gi],
    ['TikTok Pixel', /ttq\.load\s*\(\s*["']([A-Z0-9]{10,40})["']/gi],
    [
      'Google Tag Manager',
      /googletagmanager\.com\/(?:gtm\.js|ns\.html)\?[^"'<>]*?\bid=(GTM-[A-Z0-9]{4,20})/gi,
    ],
  ];
  const found = [];
  for (const snippet of snippets)
    for (const [platform, rule] of rules) {
      for (const match of snippet.matchAll(rule))
        found.push({
          platform,
          id: match[1] || match[2],
          source_url: sourceUrl,
          quote: match[0].slice(0, 240),
        });
    }
  return [...new Map(found.map((item) => [item.platform + ':' + item.id, item])).values()];
}
