import { productsRelevant, targetProductTerms } from './relevance.mjs';

// Global admission policy, independent of the task's optional type/portrait/audience filters.
// Values must have passed source-quote verification in parseCompanyResearch.
export function customerEligibility(
  { entity_type, production_model, operating_model, manufactured_products = [] },
  target = {},
) {
  const decision = (status, code, reason) => ({ status, code, reason });
  if (entity_type === 'individual')
    return decision('rejected', 'individual_consumer', '个人消费者或个人求购账号，不属于企业客户');
  if (operating_model === 'local_only')
    return decision('rejected', 'local_only', '纯本地安装商或零售门店，不入库');
  if (production_model === 'own_factory') {
    const overlap = productsRelevant(manufactured_products, target);
    // A factory's broader category (e.g. awnings) also overlaps a specific target
    // (e.g. cassette awnings). Final sales matching remains strictly target-specific.
    const broaderOverlap = manufactured_products.some(
      (product) => productsRelevant(targetProductTerms(target.product), { product }) === 'matched',
    );
    if (overlap === 'matched' || broaderOverlap)
      return decision('rejected', 'same_category_factory', '自有工厂生产目标同品类产品，属于同行');
    if (overlap === 'unknown' || overlap === 'unrestricted')
      return decision(
        'insufficient_evidence',
        'factory_products_unknown',
        '自有工厂的实际生产品类未核实，暂不入库',
      );
  }
  if (entity_type !== 'business')
    return decision('insufficient_evidence', 'entity_unknown', '未能核实为经营主体，暂不入库');
  if (!['own_factory', 'no_own_factory'].includes(production_model))
    return decision(
      'insufficient_evidence',
      'production_unknown',
      '生产方式缺乏证据，无法排除同品类自有工厂，暂不入库',
    );
  if (operating_model !== 'beyond_local')
    return decision(
      'insufficient_evidence',
      'scope_unknown',
      '经营范围缺乏证据，无法排除纯本地安装或零售，暂不入库',
    );
  return decision('eligible', 'eligible_business', null);
}
