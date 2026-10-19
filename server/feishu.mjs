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
  const contactEvidence = Array.isArray(profile.latest_research?.contact_evidence)
    ? profile.latest_research.contact_evidence
    : [];
  const values = (kind) =>
    [
      ...new Set(contactEvidence.filter((c) => c.kind === kind && c.value).map((c) => c.value)),
    ].join('\n');
  return {
    id: record.record_id,
    name: read('客户名称') || profile.company_name || '未命名客户',
    domain: profile.website_key || '',
    market: read('国家') || '待核实',
    type: read('客户类型') || 'unknown',
    product: read('相关产品'),
    match: read('匹配状态') || '待核实',
    score: null,
    grade: '未评分',
    status: read('开发状态') || '未记录',
    region: '',
    city: '',
    contact: read('联系人'),
    email: read('邮箱') || values('email'),
    phone: read('电话') || values('phone'),
    website: read('来源链接'),
    source: read('来源渠道'),
    evidence: profile.match_reason || '尚无研究结论',
    facts: profile.facts || [],
    contactEvidence,
    updatedAt: profile.latest_research?.at || null,
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
