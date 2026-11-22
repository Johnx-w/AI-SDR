export function mailSite(url: string): string;
export function siteBrand(website: string): string;
export function siteAllowsProduct(
  product: { sourceUrl?: string; brands?: string[]; materialOnly?: boolean },
  mailbox: { website: string; email?: string; brandName?: string },
  requireSite?: boolean,
): boolean;
export function mentionsOtherSite(question: string, mailbox: { website: string }): boolean;
