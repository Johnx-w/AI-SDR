// Global admission policy, independent of the task's optional type/portrait/audience filters.
// Values must have passed source-quote verification in parseCompanyResearch.
export function customerEligibility({ entity_type }) {
  const decision = (status, code, reason) => ({ status, code, reason });
  if (entity_type === 'individual')
    return decision('rejected', 'individual_consumer', '个人消费者或个人求购账号，不属于企业客户');
  if (entity_type !== 'business')
    return decision('insufficient_evidence', 'entity_unknown', '未能核实为经营主体，暂不入库');
  // Product fit and mandatory requirements are evaluated per supply direction.
  // Local suppliers and factories remain eligible business entities.
  return decision('eligible', 'eligible_business', null);
}
