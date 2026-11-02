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
} = {}) {
  const config = acquisitionConfig(env);
  const feishu = new FeishuClient({ env, fetchImpl });
  let native;
  const customers = customerLibrary
    ? new CustomerArchive({
        library: customerLibrary,
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
        ? '后端直连网页检索、研究模型与飞书；真实任务结果见任务记录。'
        : '后端直连配置缺失：' + config.missing.join('、'),
    },
    readLeads: async () => {
      await customers.sync?.();
      const data = await feishu.readLeads();
      return service().decorateLeads ? service().decorateLeads(data) : data;
    },
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
      return operation
        ? {
            company_name: research.company_name || null,
            identity_status: research.company_identity?.status || 'unverified',
            product_match: research.product_match || 'unknown',
            products: (research.products || []).slice(0, 20),
            checked_urls: (operation.checked_urls || []).slice(0, 5),
            facts: (research.facts || [])
              .filter((fact) => ['company_name', 'products', 'entity_type'].includes(fact.field))
              .slice(0, 15)
              .map(({ field, value, quote, source_url }) => ({
                field,
                value,
                quote,
                source_url,
              })),
          }
        : null;
    },
    status: (id) => service().status(id),
    recoverRun: (id) => service().status(id),
    run: (...args) => service().run(...args),
    history: () => service().store.history(),
    close: () => {
      const pending = customers.close?.();
      if (pending) return pending.finally(() => native?.close());
      native?.close();
    },
  };
}
