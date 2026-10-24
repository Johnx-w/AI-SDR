import { createHash } from 'node:crypto';
import { CustomsStore } from './customs-store.mjs';
import { createCustomsProvider } from './customs-provider.mjs';
import {
  customsSearchPlan,
  CUSTOMS_PRODUCT_PACKS,
  CUSTOMS_SCOPE_VERSION,
  obviousLogisticsBuyer,
  shipmentProductMatch,
} from './customs-products.mjs';

export { customsSearchPlan, CUSTOMS_PRODUCT_PACKS, CUSTOMS_SCOPE_VERSION };
export { customsConfig } from './customs-provider.mjs';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const normalized = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
const iso = (date) => new Date(date).toISOString().slice(0, 10);
function windowAt(now, incremental) {
  const end = new Date(now),
    start = new Date(now);
  if (incremental) start.setUTCDate(start.getUTCDate() - 30);
  else {
    const day = start.getUTCDate();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 12);
    const lastDay = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0),
    ).getUTCDate();
    start.setUTCDate(Math.min(day, lastDay));
  }
  return { start_date: iso(start), end_date: iso(end) };
}
function metrics(records) {
  const bills = new Set(records.map((r) => r.bill_of_lading_number).filter(Boolean));
  const dates = records
    .map((r) => r.date)
    .filter(Boolean)
    .sort();
  return {
    record_count: records.length,
    bill_of_lading_count: bills.size,
    unnumbered_record_count: records.filter((r) => !r.bill_of_lading_number).length,
    active_months: [...new Set(dates.map((d) => d.slice(0, 7)))],
    last_event_date: dates.at(-1) || null,
    frequency_semantics: 'observed_bills_not_purchase_orders',
  };
}
export function groupShipmentBuyers(records, family) {
  const grouped = new Map();
  for (const record of records) {
    const { buyer } = record;
    const identity = buyer.id
      ? ['provider_id', buyer.id]
      : ['unverified_name_address', normalized(buyer.name), normalized(buyer.address)];
    const key = hash([record.provider, buyer.role, identity]);
    let item = grouped.get(key);
    if (!item) {
      item = {
        id: key,
        supplier_buyer_id: buyer.id,
        name: buyer.name,
        address: buyer.address,
        country: buyer.country,
        product_family: family,
        records: [],
        identity_status: buyer.id
          ? 'provider_identity_candidate'
          : buyer.address
            ? 'name_address_candidate'
            : 'name_only_unverified',
      };
      grouped.set(key, item);
    }
    item.records.push(record);
  }
  return [...grouped.values()].map((buyer) => ({
    ...buyer,
    shipments: buyer.records,
    metrics: metrics(buyer.records),
  }));
}

export class CustomsDiscovery {
  constructor({ env = {}, fetchImpl = fetch, store, provider, now = () => new Date() } = {}) {
    this.env = env;
    this.provider = provider || createCustomsProvider({ env, fetchImpl });
    if (!this.provider.id || typeof this.provider.searchShipments !== 'function')
      throw fail('海关供应商需实现 id 和 searchShipments(query)', 503);
    this.store =
      store ||
      new CustomsStore(
        env.CUSTOMS_DB_PATH || env.ACQUISITION_DB_PATH || env.BATCH_DB_PATH || ':memory:',
      );
    this.ownsStore = !store;
    this.now = now;
  }
  async discover(input = {}, search = {}) {
    const family = search.family || search.product_family;
    if (!CUSTOMS_PRODUCT_PACKS.some((p) => p.family === family))
      throw fail(
        '海关产品范围不受支持，请选择窗饰面料、组件、透气窗、室内成品、户外遮阳或窗饰样本',
      );
    const runId = search.run_id;
    if (typeof runId !== 'string' || !runId.trim()) throw fail('海关发现需提供稳定的 run_id');
    const supplied = Number(search.remaining_budget ?? 300);
    if (!Number.isInteger(supplied) || supplied < 0) throw fail('海关剩余逐票预算必须为非负整数');
    const run = this.store.run(runId);
    const remaining = Math.max(0, Math.min(supplied, 300 - run.used - run.reserved));
    const terms = Array.isArray(search.products)
      ? search.products.filter((s) => typeof s === 'string' && s.trim())
      : [];
    const codes = Array.isArray(search.hs_codes)
      ? search.hs_codes.map(String).filter((s) => /^\d{2,10}$/.test(s))
      : [];
    if ((!terms.length && !codes.length) || (terms.length && codes.length))
      throw fail('产品词与 HS 必须使用独立查询通道');
    const country = search.country || input.country || 'North America';
    if (
      !['US', 'CA', 'United States', 'Canada', 'North America', '美国', '加拿大', '北美'].includes(
        country,
      )
    )
      throw fail('首期海关发现仅支持美国和加拿大经营买家');
    const sourceMarkets = search.source_markets || ['US'];
    if (JSON.stringify(sourceMarkets) !== '["US"]')
      throw fail('首期只启用已验证的美国披露记录源；不等于买家经营国');
    const series = hash([
      this.provider.id,
      search.scope_version || CUSTOMS_SCOPE_VERSION,
      country,
      family,
      terms,
      codes,
      sourceMarkets,
    ]);
    const cursor = this.store.cursor(series);
    const bindingKey = hash([series, search.date_range || null]);
    const binding = search.page_no === undefined ? this.store.runSearch(runId, bindingKey) : null;
    const dateRange =
      binding?.date_range ||
      search.date_range ||
      (!cursor?.completed ? cursor?.date_range : null) ||
      windowAt(this.now(), !!cursor?.baseline_completed);
    const a = Date.parse(dateRange.start_date),
      b = Date.parse(dateRange.end_date);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a > b || b - a > 366 * 86400000)
      throw fail('海关观察窗口必须是有效的最多 12 个月起止日期');
    const pageNo =
      search.page_no ?? binding?.page_no ?? (!cursor?.completed ? cursor?.page_no : null) ?? 1;
    const pageSize =
      search.page_size ??
      binding?.page_size ??
      (!cursor?.completed ? cursor?.page_size : null) ??
      Math.min(50, remaining || 50);
    if (
      !Number.isInteger(pageNo) ||
      pageNo < 1 ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 50
    )
      throw fail('海关分页必须为正整数，单页最多 50 条');
    let query = {
      family,
      products: terms,
      hs_codes: codes,
      source_markets: sourceMarkets,
      date_range: dateRange,
      page_no: pageNo,
      page_size: pageSize,
      scope_version: search.scope_version || CUSTOMS_SCOPE_VERSION,
    };
    // Bind an implicit initial search to its effective page before any paid
    // request. If the worker dies before saving its buyer queue, retrying the
    // same run replays this cached page instead of skipping to the cursor.
    if (search.page_no === undefined) query = this.store.bindRunSearch(runId, bindingKey, query);
    const pageId = hash([this.provider.id, query]);
    let cached = this.store.page(pageId),
      cacheHit = !!cached;
    const usage = {
      returned_records: 0,
      charged_records: 0,
      credits: this.provider.id === 'billofladingdata' ? 0 : null,
      cache_hits: cached ? 1 : 0,
      duplicate_records: 0,
      rejected_product: 0,
      rejected_logistics: 0,
      rejected_unknown_buyer: 0,
      run_used_records: run.used,
      run_reserved_records: run.reserved,
      remaining_budget: remaining,
      query,
    };
    if (cached && cached.status !== 'complete')
      throw fail('上次海关逐票请求计费结果待核对；已保留请求和预算，不自动重发', 409);
    if (!cached) {
      // A persisted page sequence retains its page size. Shrinking it midstream
      // changes offsets and silently skips or repeats upstream records.
      if (remaining < query.page_size)
        return { buyers: [], usage: { ...usage, budget_exhausted: true } };
      cached = this.store.reserve(
        pageId,
        runId,
        query.page_size,
        Math.min(300, run.used + run.reserved + supplied),
        query,
      );
      if (cached) {
        cacheHit = true;
        usage.cache_hits = 1;
        if (cached.status !== 'complete')
          throw fail('该海关页面正在处理或计费结果待核对；未重复请求', 409);
      } else {
        try {
          const result = await this.provider.searchShipments(query);
          if (!Array.isArray(result.records) || result.records.length > query.page_size)
            throw fail('海关供应商返回记录数或格式不符合约定', 502);
          this.store.complete(pageId, result);
          cached = this.store.page(pageId);
        } catch (error) {
          this.store.uncertain(pageId);
          throw error;
        }
      }
    }
    const result = cached.result;
    usage.returned_records = result.records.length;
    usage.charged_records = cacheHit ? 0 : result.records.length;
    if (this.provider.id === 'billofladingdata') usage.credits = usage.charged_records;
    const accepted = [],
      seen = new Set();
    for (const [index, record] of result.records.entries()) {
      if (!record?.buyer || typeof record.description !== 'string')
        throw fail('海关适配器返回的记录未归一化', 502);
      // Stable record ID is the strong dedupe key. Without it, preserve separate
      // rows; a B/L alone must never collapse distinct parties or cargo lines.
      const recordKey = record.id ? this.provider.id + ':' + record.id : pageId + ':' + index;
      const seenOtherPage = this.store.firstPageForRecord(runId, recordKey, pageId) !== pageId;
      const seenInFamily =
        this.store.firstPageForRecord(runId, family + ':' + recordKey, pageId) !== pageId;
      if (seen.has(recordKey) || seenOtherPage) usage.duplicate_records++;
      if (seen.has(recordKey) || seenInFamily) continue;
      seen.add(recordKey);
      if (!shipmentProductMatch(record.description, family)) {
        usage.rejected_product++;
        continue;
      }
      if (
        !record.buyer.name ||
        /^(?:to order|unknown|n\/?a|not available)$/i.test(record.buyer.name)
      ) {
        usage.rejected_unknown_buyer++;
        continue;
      }
      if (obviousLogisticsBuyer(record.buyer.name, record.buyer.role)) {
        usage.rejected_logistics++;
        continue;
      }
      accepted.push({ ...record, query_context: query });
    }
    const more =
      result.has_more ??
      (Number.isFinite(result.total)
        ? query.page_no * query.page_size < result.total
        : result.records.length === query.page_size);
    const updated = this.store.run(runId);
    usage.run_used_records = updated.used;
    usage.run_reserved_records = updated.reserved;
    usage.remaining_budget = Math.max(
      0,
      Math.min(supplied - usage.charged_records, 300 - updated.used - updated.reserved),
    );
    const next = more
      ? {
          ...search,
          source_kind: 'customs',
          family,
          country,
          products: terms,
          hs_codes: codes,
          source_markets: sourceMarkets,
          page_no: query.page_no + 1,
          page_size: query.page_size,
          date_range: query.date_range,
          scope_version: query.scope_version,
          remaining_budget: usage.remaining_budget,
        }
      : undefined;
    this.store.saveCursor(series, {
      date_range: query.date_range,
      page_no: query.page_no + 1,
      page_size: query.page_size,
      completed: !more,
      baseline_completed: !!cursor?.baseline_completed || !more,
      updated_at: new Date(this.now()).toISOString(),
    });
    return {
      buyers: groupShipmentBuyers(accepted, family),
      usage,
      ...(next ? { next_search: next } : {}),
    };
  }
  close() {
    if (this.ownsStore) this.store.close();
  }
}
