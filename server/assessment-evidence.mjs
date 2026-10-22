import { productsRelevant, windowProductDirections } from './relevance.mjs';
import { isAllProductScope } from '../src/domain/acquisition-products.mjs';

export const assessmentKinds = [
  'core_product',
  'secondary_product',
  'adjacent_product',
  'unrelated_product',
  'specialist_supply',
  'general_supply',
  'installation_only',
  'no_supply_role',
  'current_supply_process',
  'custom_made',
  'motorized_system',
  'commercial_specification',
  'company_since',
  'company_years',
  'operating_outlet',
  'active_dealer',
  'completed_project',
  'completed_commercial_project',
  'identity_conflict',
  'mandatory_requirement',
];

export const assessmentOpportunitySchema = {
  type: 'array',
  maxItems: 6,
  items: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['finished', 'materials', 'samples'] },
      product: { type: 'string', minLength: 2, maxLength: 160 },
      facts: {
        type: 'array',
        maxItems: 60,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: assessmentKinds },
            value: { type: 'string', maxLength: 300 },
            quote: { type: 'string', minLength: 3, maxLength: 600 },
            source_url: { type: 'string' },
          },
          required: ['kind', 'value', 'quote', 'source_url'],
          additionalProperties: false,
        },
      },
    },
    required: ['direction', 'product', 'facts'],
    additionalProperties: false,
  },
};

export const assessmentInstructions = `
另输出 assessment_opportunities 数组，最多6个，按“实际产品族×供货方向”分别记录评分所需事实，不输出分数或评级。direction=finished成品/materials半成品及材料配件/samples样本展示；product是官网实际可证实的具体产品名称，不能直接复制未证实的搜索词。specific范围只研究target相关产品；all范围研究全部适用窗饰成品及半成品材料配件，优先环境仅影响搜索顺序，不排除另一环境的真实业务；all默认不研究独立样本展示业务。不把多个方向混在一起。每项facts为{kind,value,quote,source_url}，引文必须来自输入pages中同一连续原文，无证据就省略。
成品经营、制造与材料配件业务分开取证。官网明确经营窗饰专用面料、型材、零件、电机或半成品可支持materials潜在适配机会，不要求其已经公开求购；只有自产成品不能自动生成其材料配件清单、采购需求或材料方向的计分事实。目录不等于企业采购需求，不能推断其愿意外采、兼容我方规格或已有合作意愿。
kind含义：core_product=实际核心/专营产品；secondary_product=综合业务的明确副线；adjacent_product=充分证实仅邻近业务；unrelated_product=明确不经营/无关。specialist_supply=专业供货/定制经销零售/批发/品牌/供货工程，或材料方向的相关制造；general_supply=综合建材/工程中的产品供货；installation_only=明确只做安装维修不供货；no_supply_role=明确无适用供货角色。目录不自动证明主营，没找到不代表不经营。
current_supply_process=当前同产品询价/量尺/定制下单/交付流程；custom_made=同产品按尺寸/面料/结构定制；motorized_system=同产品电动或自动化；commercial_specification=同产品明确商用工程材料/系统规格（只有commercial宣传词不够）。这些value简述事实，不能把另一个产品的电动特性挪来。
company_since的value为同一企业持续经营起始年YYYY或完整日期YYYY-MM-DD；company_years为官网明确该企业持续经营的完整年数。员工/创始人个人经验、团队合计经验、版权年份不算企业年限。operating_outlet每条是有具体地址的现营网点；active_dealer每条是一个可识别的实际经销商；未来网点、服务城市、移动展厅覆盖城市不能算。value直接复制可识别的网点/经销商名称或地址。
completed_project每条为相关产品的已交付案例；completed_commercial_project还须明确商业客户。value直接复制可区分项目的名称/地点/日期标题。要有完成交付叙述和具体产品，示意图、评论、同项目不同房间/多张图不拆算；不能把“能承接项目”当已完成案例。
identity_conflict仅为有明确证据的主体矛盾；mandatory_requirement只为明确排他/强制供应商或产品条件，普通品牌展示/本地制造宣传不算。company_name、生产方式、客群和经营范围仍按各自证据输出，本地企业和自有工厂都可能是有效买方。`;

const compact = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const directions = new Set(['finished', 'materials', 'samples']);
const allowed = new Set(assessmentKinds);
const identifiedKinds = new Set([
  'operating_outlet',
  'active_dealer',
  'completed_project',
  'completed_commercial_project',
]);
const productKinds = new Set(['unrelated_product']);
const directionFactKinds = new Set([
  'core_product',
  'secondary_product',
  'adjacent_product',
  'unrelated_product',
  'specialist_supply',
  'general_supply',
  'current_supply_process',
  'custom_made',
  'motorized_system',
  'commercial_specification',
]);
const genericWindowProduct =
  /^(?:(?:indoor|outdoor|semi[- ]?finished)\s+)?(?:window\s+(?:coverings?|furnishings?|treatments?)|blinds?|shades?|curtains?|drapery)(?:\s+(?:components?|parts?|materials?|fabrics?|accessories|hardware))?$|^(?:室内|室外|半成品)?(?:窗饰|窗帘)(?:成品|半成品|材料|配件|零件|面料)?$/i;
const supportsBroadProduct = (evidence, product, direction) =>
  windowProductDirections(evidence).includes(direction) &&
  (genericWindowProduct.test(product) ||
    compact(evidence).toLowerCase().includes(compact(product).toLowerCase()) ||
    productsRelevant([evidence], { product_scope: 'specific', product }) === 'matched');

export function verifiedAssessmentOpportunities(
  raw,
  pages,
  target = {},
  verifiedProducts = [],
  verifiedProductFacts = [],
) {
  if (!Array.isArray(raw)) return [];
  const allScope =
    isAllProductScope(target) &&
    Boolean(target.product_scope || target.product || target.products?.length);
  const result = [];
  const seen = new Set();
  for (const opportunity of raw.slice(0, 6)) {
    if (
      !opportunity ||
      !directions.has(opportunity.direction) ||
      typeof opportunity.product !== 'string'
    )
      continue;
    const product = opportunity.product.trim().slice(0, 160);
    if (product.length < 2 || (target.product && productsRelevant([product], target) !== 'matched'))
      continue;
    if (
      !allScope &&
      target.products?.length &&
      !target.products.some(
        (selected) =>
          selected.direction === opportunity.direction &&
          productsRelevant([product], { product: selected.value, products: [selected] }) ===
            'matched',
      )
    )
      continue;
    if (
      allScope &&
      (!['finished', 'materials'].includes(opportunity.direction) ||
        !windowProductDirections(product).includes(opportunity.direction))
    )
      continue;
    const related = allScope
      ? verifiedProductFacts.length
        ? verifiedProductFacts.some(
            (fact) =>
              typeof fact.value === 'string' &&
              supportsBroadProduct(fact.value, product, opportunity.direction) &&
              supportsBroadProduct(fact.quote, product, opportunity.direction),
          )
        : verifiedProducts.some((value) =>
            supportsBroadProduct(value, product, opportunity.direction),
          )
      : productsRelevant(verifiedProducts, { product }) === 'matched';
    const key = opportunity.direction + ':' + compact(product).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const facts = [];
    for (const fact of (Array.isArray(opportunity.facts) ? opportunity.facts : []).slice(0, 60)) {
      if (
        !fact ||
        !allowed.has(fact.kind) ||
        typeof fact.quote !== 'string' ||
        typeof fact.value !== 'string'
      )
        continue;
      const page = pages.find((p) => p.source_url === fact.source_url);
      if (!page || fact.quote.trim().length < 3 || fact.quote.length > 600) continue;
      // Only whitespace is normalized. Partial lines, summaries and joined quotes are rejected.
      const quote = compact(fact.quote);
      if (!compact(page.text).includes(quote)) continue;
      if (
        allScope &&
        directionFactKinds.has(fact.kind) &&
        !supportsBroadProduct(quote, product, opportunity.direction)
      )
        continue;
      if (productKinds.has(fact.kind) && productsRelevant([quote], { product }) !== 'matched')
        continue;
      const value = fact.value.trim().slice(0, 300);
      if (
        identifiedKinds.has(fact.kind) &&
        (!value || !compact(quote).toLowerCase().includes(compact(value).toLowerCase()))
      )
        continue;
      if (
        fact.kind === 'company_years' &&
        (!/^\d{1,3}$/.test(value) ||
          !new RegExp('\\b' + value + '\\s*\\+?\\s*(?:years?|年)', 'i').test(quote))
      )
        continue;
      if (
        fact.kind === 'company_years' &&
        (!/\b(?:for|established|founded|business|company|operat\w*|suppl\w*|serv(?:ed|ing))\b|经营|成立|创立/i.test(
          quote,
        ) ||
          /combined experience|collective experience|团队合计|个人经验/i.test(quote))
      )
        continue;
      if (
        fact.kind === 'company_since' &&
        (!/^\d{4}(?:-\d{2}-\d{2})?$/.test(value) || !quote.includes(value.slice(0, 4)))
      )
        continue;
      facts.push({ kind: fact.kind, value, quote, source_url: page.source_url });
    }
    // A model-supplied product label must also match the independently quote-checked catalog/procurement facts.
    if (!related && !facts.some((f) => f.kind === 'unrelated_product')) continue;
    result.push({ direction: opportunity.direction, product, facts });
  }
  return result;
}
