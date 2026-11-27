export const websiteAdmissionVersion = 'website-admission-v1';

export const admissionFactDescriptions = {
  third_party_profile: '候选企业只在第三方页面被介绍，未取得其独立官网',
  trade_show_operator: '当前主体是展会主办方',
  marketplace_operator: '当前主体是交易平台运营方',
  unrelated_operator: '当前主体是集团本体、资讯、资助、旅游或其他无关经营方',
  general_retailer: '当前主体是综合百货或综合家居商',
  home_only_retail: '综合百货或综合家居商仅有现货或家用定制业务证据',
  commercial_custom_supply: '当前主体直接承接酒店、办公室等商业窗饰定制供货',
  complete_supply: '有合格完整室内窗饰或户外遮阳主营，当前主体供应、销售或供应并安装',
  component_resale: '当前主体有窗饰专用配件或面料的经销证据',
  installation_only: '当前主体只安装维修或明确由客户自备产品',
  component_manufacture_only: '当前主营只有自产窗饰专用配件或面料，未经营成品或经销他牌',
  excluded_use_only:
    '当前产品仅属固定玻璃顶棚或车棚、铝百叶凉亭、窗膜、防火挡烟帘、舞台帷幕等待排用途',
};

// Facts have passed source-quote verification in parseCompanyResearch.
export function customerEligibility({ entity_type, admission_facts }) {
  const decision = (status, code, reason) => ({ status, code, reason });
  const recognized = (code) => admission_facts?.includes(code);
  const reject = (code) => decision('rejected', code, admissionFactDescriptions[code]);
  if (recognized('third_party_profile'))
    return decision(
      'insufficient_evidence',
      'official_site_missing',
      admissionFactDescriptions.third_party_profile,
    );
  if (entity_type === 'individual')
    return decision('rejected', 'individual_consumer', '个人消费者或个人求购账号，不属于企业客户');
  if (entity_type !== 'business')
    return decision('insufficient_evidence', 'entity_unknown', '未能核实为经营主体，暂不入库');
  if (!admission_facts) return decision('eligible', 'eligible_business', null);
  const excludedSubject = [
    'trade_show_operator',
    'marketplace_operator',
    'unrelated_operator',
  ].find(recognized);
  if (excludedSubject) return reject(excludedSubject);
  if (recognized('commercial_custom_supply'))
    return decision('eligible', 'commercial_custom_supply', null);
  if (recognized('general_retailer'))
    return recognized('home_only_retail')
      ? reject('home_only_retail')
      : decision(
          'insufficient_evidence',
          'commercial_supply_missing',
          '综合百货或家居商的商业窗饰定制供货尚未核实',
        );
  const supply = ['complete_supply', 'component_resale'].find(recognized);
  if (supply) {
    if (recognized('installation_only'))
      return decision('insufficient_evidence', 'supply_conflict', '官网供货与仅安装的证据冲突');
    return decision('eligible', supply, null);
  }
  const excludedActivity = [
    'installation_only',
    'component_manufacture_only',
    'excluded_use_only',
  ].find(recognized);
  if (excludedActivity) return reject(excludedActivity);
  return decision(
    'insufficient_evidence',
    'operating_evidence_missing',
    '官网尚未核实主营产品、用途或供货角色',
  );
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
