import { normalizePhone, normalizePhoneLines } from './phone-format.mjs';
import { formatRelatedProducts } from './product-format.mjs';
import { readAssessmentSummary } from './customer-assessment.mjs';
import { domainKey } from './website-identity.mjs';

export const fieldText = (value) => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(fieldText).filter(Boolean).join('\n');
  if (typeof value === 'object') return value.text || value.link || value.name || '';
  return String(value);
};
export function mapFeishuRecord(record) {
  const f = record.fields || {};
  let profile = {};
  try {
    profile = JSON.parse(fieldText(f['画像JSON']) || '{}');
  } catch {
    /* 原始字段仍可查看。 */
  }
  const read = (key) => fieldText(f[key]);
  const grade = read('用户评级') || read('客户等级') || read('用户等级');
  const assessment = readAssessmentSummary(read('评级依据'));
  const contactEvidence = Array.isArray(profile.latest_research?.contact_evidence)
    ? profile.latest_research.contact_evidence
    : [];
  const values = (kind) =>
    [
      ...new Set(contactEvidence.filter((c) => c.kind === kind && c.value).map((c) => c.value)),
    ].join('\n');
  return {
    id: record.record_id,
    name: read('公司名称') || read('客户名称') || profile.company_name || '未命名公司',
    domain: domainKey(read('来源链接')) || profile.website_key || '',
    market: read('国家') || '待核实',
    type:
      {
        installer: '服务商',
        service_provider: '服务商',
        distributor: '经销商',
        wholesaler: '批发商',
        retailer: '零售商',
        contractor: '工程承包商',
        manufacturer: '工厂',
        other: '其他行业',
        unknown: '待核实',
      }[read('客户类型')] ||
      read('客户类型') ||
      '待核实',
    product: formatRelatedProducts(read('相关产品')),
    match: '',
    score: assessment?.score ?? null,
    assessment,
    grade: ['A', 'B', 'C', '待核实', '待补全', '暂不开发'].includes(grade) ? grade : '未评级',
    ratingReason: read('评级依据'),
    status: read('开发状态') || '未记录',
    region: read('州 / 城市'),
    city: '',
    address: read('详细地址'),
    serviceAreas: read('服务地区'),
    social: ['Facebook', 'Instagram', 'LinkedIn'].flatMap((platform) =>
      read(platform)
        .split('\n')
        .filter(Boolean)
        .map((url) => ({ platform, url, source_url: read('来源链接'), quote: '官网公开链接' })),
    ),
    locationEvidence: [
      ...(profile.website_metadata?.addresses || []),
      ...(profile.website_metadata?.service_areas || []),
    ],
    contact: read('联系人'),
    email: read('邮箱') || values('email'),
    phone: normalizePhoneLines(read('电话') || values('phone'), read('国家')),
    website: read('来源链接'),
    source: '',
    mainProductPreference: read('主营产品偏好'),
    advertisingCodes: read('广告代码'),
    demandProducts: read('需求产品'),
    industryProfile: read('客户行业画像'),
    audience: read('服务客群'),
    evidence: read('主营产品偏好') || '尚无主营产品分析',
    facts: profile.facts || [],
    contactEvidence: contactEvidence.flatMap((c) =>
      c.kind !== 'phone'
        ? [c]
        : (() => {
            const phone = normalizePhone(c.value, read('国家'));
            return phone ? [{ ...c, ...phone }] : [];
          })(),
    ),
    updatedAt: Number(read('最近研究时间')) || profile.latest_research?.at || null,
    fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, fieldText(v)])),
  };
}
export async function readFeishu({ env, fetchImpl }) {
  let endpoint;
  try {
    endpoint = new URL(env.FEISHU_READ_WEBHOOK_URL);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.origin !== new URL(env.N8N_BASE_URL || 'https://vynox.app.n8n.cloud').origin ||
      !endpoint.pathname.startsWith('/webhook/') ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error();
  } catch {
    throw Object.assign(new Error('飞书只读入口未配置，请检查服务端 FEISHU_READ_WEBHOOK_URL。'), {
      status: 503,
    });
  }
  if (!env.N8N_WEBHOOK_SECRET)
    throw Object.assign(new Error('飞书读取认证未配置。'), { status: 503 });
  const records = [];
  const seen = new Set();
  let cursor = '';
  for (let page = 0; page < 100; page++) {
    const url = new URL(endpoint);
    if (cursor) url.searchParams.set('cursor', cursor);
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: { 'X-Shadeflow-Key': env.N8N_WEBHOOK_SECRET },
      });
    } catch {
      throw Object.assign(new Error('飞书读取超时或连接失败，请重试。'), { status: 502 });
    }
    if (!response.ok)
      throw Object.assign(
        new Error(`飞书读取失败（HTTP ${response.status}），请检查只读工作流。`),
        { status: 502 },
      );
    const payload = await response.json();
    if (payload.code !== 0 || !Array.isArray(payload.data?.items))
      throw Object.assign(new Error('飞书返回异常，未加载客户数据。'), { status: 502 });
    records.push(...payload.data.items);
    if (!payload.data.has_more)
      return {
        leads: records.map(mapFeishuRecord),
        syncedAt: new Date().toISOString(),
        source: 'feishu',
        total: records.length,
      };
    cursor = payload.data.page_token;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
  throw Object.assign(new Error('飞书分页未完整读取，请检查分页响应。'), { status: 502 });
}
