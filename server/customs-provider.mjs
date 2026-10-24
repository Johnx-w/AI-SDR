import { createHash } from 'node:crypto';

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const date = (v) => {
  const s = text(v)
    .replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
    .slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString().slice(0, 10) === s
    ? s
    : null;
};
const quantity = (value, unit) =>
  value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))
    ? { value: Number(value), unit: text(unit) || null }
    : null;

function endpointUrl(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw fail('CUSTOMS_BASE_URL 必须是有效接口地址', 503);
  }
  if (
    endpoint.protocol !== 'https:' &&
    !(
      endpoint.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
    )
  )
    throw fail('海关接口必须使用 HTTPS', 503);
  if (endpoint.username || endpoint.password || endpoint.hash || endpoint.search)
    throw fail('海关接口地址不可包含账号密码、查询参数或片段', 503);
  return endpoint.href;
}

export function customsConfig(env = {}) {
  const provider = env.CUSTOMS_PROVIDER || '';
  const missing = [];
  if (!['billofladingdata', 'http'].includes(provider)) missing.push('CUSTOMS_PROVIDER');
  if (
    provider === 'billofladingdata' &&
    !(env.CUSTOMS_API_KEY || env.BILLOFLADINGDATA_API_KEY)?.trim()
  )
    missing.push('CUSTOMS_API_KEY');
  if (provider === 'http' && !(env.CUSTOMS_BASE_URL || env.CUSTOMS_API_URL)?.trim())
    missing.push('CUSTOMS_BASE_URL');
  if (missing.length) return { provider, configured: false, missing };
  try {
    createCustomsProvider({ env });
    return { provider, configured: true, missing: [] };
  } catch (error) {
    return { provider, configured: false, missing: [], error: error.message };
  }
}

export function normalizeShipment(row, provider = 'customs') {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw fail('海关记录格式异常');
  const buyer = row.buyer || {};
  return {
    provider,
    id: text(row.id) || null,
    bill_of_lading_number: text(row.bill_of_lading_number) || null,
    date: date(row.date),
    date_type: text(row.date_type) || 'source_record_date',
    description: text(row.description),
    hs_code: text(row.hs_code) || null,
    buyer: {
      id: text(buyer.id) || null,
      name: text(buyer.name),
      address: text(buyer.address) || null,
      country: text(buyer.country) || null,
      role: text(buyer.role) || 'consignee',
    },
    seller:
      row.seller && typeof row.seller === 'object'
        ? {
            id: text(row.seller.id) || null,
            name: text(row.seller.name),
            address: text(row.seller.address) || null,
            country: text(row.seller.country) || null,
          }
        : null,
    import_market: text(row.import_market) || null,
    export_market: text(row.export_market) || null,
    manufacturing_origin: text(row.manufacturing_origin) || null,
    loading_port: text(row.loading_port) || null,
    unloading_port: text(row.unloading_port) || null,
    quantity: row.quantity ? quantity(row.quantity.value, row.quantity.unit) : null,
    weight: row.weight ? quantity(row.weight.value, row.weight.unit) : null,
    // Upstream zero usually means unavailable; do not turn it into zero spend.
    amount:
      row.amount?.value > 0
        ? { value: Number(row.amount.value), currency: text(row.amount.currency) || null }
        : null,
    source_url: text(row.source_url) || null,
    raw: row.raw || row,
  };
}

async function post(fetchImpl, endpoint, headers, body) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw fail('海关数据请求中断；计费状态待核对，未自动重发');
  }
  if (!response.ok)
    throw fail('海关数据请求失败（HTTP ' + response.status + '）；计费状态待核对，未自动重发');
  try {
    return await response.json();
  } catch {
    throw fail('海关数据响应格式异常；计费状态待核对，未自动重发');
  }
}

export class HttpCustomsProvider {
  constructor({ env = {}, fetchImpl = fetch } = {}) {
    const configured = env.CUSTOMS_BASE_URL || env.CUSTOMS_API_URL;
    if (!configured) throw fail('请配置海关数据标准接口 CUSTOMS_BASE_URL', 503);
    // For a normalized bridge BASE_URL is the complete POST endpoint; API_URL
    // remains an alias for early integrations, without adding hidden paths.
    this.endpoint = endpointUrl(configured);
    this.id = 'http:' + createHash('sha256').update(this.endpoint).digest('hex').slice(0, 12);
    this.key = env.CUSTOMS_API_KEY;
    this.fetch = fetchImpl;
  }
  async searchShipments(query) {
    const data = await post(
      this.fetch,
      this.endpoint,
      this.key ? { Authorization: 'Bearer ' + this.key } : {},
      query,
    );
    if (!Array.isArray(data.records)) throw fail('标准海关接口必须返回 records 数组');
    if (data.records.length > query.page_size)
      throw fail('海关接口返回记录超出请求上限，已暂停核对');
    return {
      records: data.records.map((row) => normalizeShipment(row, this.id)),
      total: Number.isFinite(data.total) ? data.total : null,
      has_more: typeof data.has_more === 'boolean' ? data.has_more : null,
    };
  }
}

// Verified against https://billofladingdata.com/api-documentation on 2026-10-23.
// Its documented standardized records do not guarantee importer IDs/addresses.
// Extra identity columns require an explicit verified field mapping, not guessing.
export class BillOfLadingDataProvider {
  constructor({ env = {}, fetchImpl = fetch } = {}) {
    this.id = 'billofladingdata';
    const base = env.CUSTOMS_BASE_URL || 'https://tradedata.billofladingdata.com';
    this.endpoint = endpointUrl(
      base.replace(/\/$/, '') +
        (base.replace(/\/$/, '').endsWith('/partner-api/shipping-records')
          ? ''
          : '/partner-api/shipping-records'),
    );
    this.key = env.CUSTOMS_API_KEY || env.BILLOFLADINGDATA_API_KEY;
    if (!this.key) throw fail('请配置 CUSTOMS_API_KEY 或 BILLOFLADINGDATA_API_KEY', 503);
    this.fetch = fetchImpl;
    try {
      this.fields = JSON.parse(env.CUSTOMS_FIELD_MAP || '{}');
    } catch {
      throw fail('CUSTOMS_FIELD_MAP 必须为 JSON 对象', 503);
    }
    if (!this.fields || typeof this.fields !== 'object' || Array.isArray(this.fields))
      throw fail('CUSTOMS_FIELD_MAP 必须为 JSON 对象', 503);
  }
  async searchShipments(query) {
    const body = {
      type: 'imp',
      page_size: query.page_size,
      page_no: query.page_no,
      date_range: query.date_range,
      import_countries: query.source_markets || ['US'],
      ...(query.products?.length ? { products: query.products } : {}),
      ...(query.hs_codes?.length ? { hs_codes: query.hs_codes } : {}),
    };
    const data = await post(this.fetch, this.endpoint, { 'api-key': this.key }, body);
    if (data.code !== 200 || !Array.isArray(data.data?.records))
      throw fail('BillOfLadingData 返回状态或记录格式异常；未自动重发');
    if (data.data.records.length > query.page_size)
      throw fail('BillOfLadingData 返回记录超出请求上限，已暂停核对');
    const value = (row, name) =>
      typeof this.fields[name] === 'string'
        ? this.fields[name].split('.').reduce((a, k) => a?.[k], row)
        : undefined;
    const records = data.data.records.map((row) =>
      normalizeShipment(
        {
          raw: row,
          id: row.id,
          date: row.bydate,
          description: row.products,
          hs_code: row.hs_code,
          bill_of_lading_number: row.bill_of_lading_nbr,
          buyer: {
            name: row.consignee_name,
            id: value(row, 'buyer_id'),
            address: value(row, 'buyer_address'),
            role: 'consignee',
          },
          seller: { name: row.shipper_name },
          import_market: row.country_imp,
          export_market: row.country_exp,
          loading_port: row.start_port,
          unloading_port: row.end_port,
          quantity: { value: row.manifest_qty, unit: row.manifest_units },
          weight: { value: row.weight, unit: row.weight_unit },
          amount: { value: row.amount },
        },
        this.id,
      ),
    );
    return { records, total: Number.isFinite(data.data.total) ? data.data.total : null };
  }
}

export function createCustomsProvider({ env = {}, fetchImpl = fetch } = {}) {
  if (env.CUSTOMS_PROVIDER === 'billofladingdata')
    return new BillOfLadingDataProvider({ env, fetchImpl });
  if (env.CUSTOMS_PROVIDER === 'http') return new HttpCustomsProvider({ env, fetchImpl });
  throw fail('请配置 CUSTOMS_PROVIDER（billofladingdata 或 http）；不自动选择或购买数据源', 503);
}
