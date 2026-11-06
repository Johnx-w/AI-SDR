// Global admission policy, independent of the task's optional type/portrait filters.
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

// A failed market/search condition does not disqualify the whole company.
export function isDevelopmentCustomer(lead) {
  if (typeof lead.developmentEligible === 'boolean') return lead.developmentEligible;
  const assessment = lead.assessment;
  if (assessment?.entityType === 'individual') return false;
  const opportunities = assessment?.opportunities || [];
  return (
    !opportunities.length ||
    !opportunities.every((opportunity) => {
      const { P, R } = opportunity.dimensions || {};
      return !P?.conflict && !R?.conflict && (P?.score === 0 || R?.score === 0);
    })
  );
}
