import { acquisitionConfig } from './acquisition-config.mjs';
import { FeishuClient } from './feishu-direct.mjs';
import { NativeAcquisition } from './native-acquisition.mjs';
import { CustomerArchive } from './customer-archive.mjs';

// HTTP routes and the batch scheduler share the direct acquisition service.
export function createAcquisitionProvider({
  env,
  fetchImpl = fetch,
  nativeImpl,
  customerLibrary,
  isMaintaining = () => false,
} = {}) {
  const config = acquisitionConfig(env);
  const feishu = new FeishuClient({ env, fetchImpl, isMaintaining });
  let native;
  const customers = customerLibrary
    ? new CustomerArchive({
        library: customerLibrary,
        isMaintaining,
        remote: nativeImpl instanceof NativeAcquisition ? nativeImpl.feishu : feishu,
        decorate: (data) => (service().decorateLeads ? service().decorateLeads(data) : data),
      })
    : feishu;
  const service = () =>
    (native ??= nativeImpl || new NativeAcquisition({ env, fetchImpl, feishu: customers }));
  if (nativeImpl instanceof NativeAcquisition && customerLibrary) nativeImpl.feishu = customers;
  return {
    get syncing() {
      return !!customers.syncing;
    },
    syncCustomers: () => customers.sync?.(),
    saveCustomerFields: (id, fields) => customers.write('update', fields, id),
    customerRecord: (id) => customers.record(id),
    customerRemoteId: (id) => customers.remoteId?.(id) ?? (id.startsWith('local_') ? null : id),
    closeArchive: () => customers.close?.(),
    decorateLeads: (data) => (service().decorateLeads ? service().decorateLeads(data) : data),
    info: {
      ...config,
      configured: config.nativeReady,
      transport: 'direct',
      webProvider: config.webSearchProvider,
      modelProvider: config.researchModelProvider,
      note: config.nativeReady
        ? '后端使用网页检索和研究模型，结果保存至项目数据库。'
        : '后端直连配置缺失：' + config.missing.join('、'),
    },
    currentAssessments: () => service().assessments.current(),
    assessmentInfo: () => service().assessmentInfo(),
    assessRecord: (...args) => service().assessRecord(...args),
    updateContacts: async (...args) => {
      const result = await service().updateContacts(...args);
      return {
        ...result,
        lead: service().decorateLeads
          ? service().decorateLeads({ leads: [result.lead] }).leads[0]
          : result.lead,
      };
    },
    supplementRecord: (...args) => service().supplementRecord(...args),
    pendingSupplement: (...args) => service().pendingSupplement(...args),
    assessmentHistory: (...args) => service().assessmentHistory(...args),
    discover: (...args) => service().discover(...args),
    research: (...args) => service().research(...args),
    reviewEvidence: (id) => {
      const operation = id ? service().store?.get(id) : null;
      const research = operation?.research || {};
      if (!operation) return null;
      const groupedFacts = new Map();
      for (const { field, value, quote, source_url, snapshot_id, quote_offset } of research.facts ||
        []) {
        if (
          ![
            'company_name',
            'products',
            'entity_type',
            'admission_facts',
            'legal_company_name',
          ].includes(field)
        )
          continue;
        const key = JSON.stringify([field, quote, source_url]);
        const fact = groupedFacts.get(key) || {
          field,
          quote,
          source_url,
          values: [],
          ...(snapshot_id ? { snapshot_id, quote_offset } : {}),
        };
        const normalizedValue = String(value ?? '').trim();
        if (normalizedValue && !fact.values.includes(normalizedValue)) {
          fact.values.push(normalizedValue);
        }
        groupedFacts.set(key, fact);
      }
      return {
        company_name: research.company_name || null,
        identity_status: research.company_identity?.status || 'unverified',
        product_match: research.product_match || 'unknown',
        products: (research.products || []).slice(0, 20),
        checked_urls: (operation.checked_urls || []).slice(0, 5),
        ...(operation.collection_attempts
          ? { collection_attempts: operation.collection_attempts }
          : {}),
        ...(operation.collection_gaps?.length
          ? { collection_gaps: operation.collection_gaps }
          : {}),
        facts: [...groupedFacts.values()]
          .slice(0, 15)
          .map(({ values, ...fact }) => ({ ...fact, value: values.join('、') })),
      };
    },
    status: (id) => service().status(id),
    close: () => {
      const pending = customers.close?.();
      if (pending) return pending.finally(() => native?.close());
      native?.close();
    },
  };
}
