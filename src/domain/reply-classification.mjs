export const BUSINESS_REPLY_LABELS = Object.freeze({
  positive: '积极回复',
  refusal: '明确拒绝',
  referral: '渠道转介',
  notification: '客服通知',
  bounce: '退信',
  unverified: '待核实',
  other: '其他真人回复',
});
export const POSITIVE_REQUEST_LABELS = Object.freeze({
  quote: '索价',
  catalog: '索目录',
  meeting: '约见',
});

export function emptyBusinessCounts() {
  return Object.fromEntries(Object.keys(BUSINESS_REPLY_LABELS).map((kind) => [kind, 0]));
}
