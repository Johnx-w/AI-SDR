import {
  productsRelevant,
  businessProductRelation,
  windowProductDirections,
  targetProductTerms,
} from './relevance.mjs';
import { isAllProductScope, productTerms } from '../src/domain/acquisition-products.mjs';

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
另输出 assessment_opportunities 数组，最多6个，按“实际产品族×经营形态”分别记录初始开发优先级所需事实，不输出分数或评级。direction=finished成品/materials半成品及材料配件/samples样本展示；product是官网实际可证实的具体产品名称，不能直接复制未证实的搜索词。specific范围研究target相关产品及相关材料、配件的潜在客户业务；all范围研究全部适用窗饰成品及半成品材料配件，优先环境仅影响搜索顺序，不排除另一环境的真实业务；all默认不研究独立样本展示业务。不把多个方向混在一起。每项facts为{kind,value,quote,source_url}，引文必须来自输入pages中同一连续原文，无证据就省略。
例如搜索卷帘面料时，经营卷帘的企业可保留开发机会：用finished记录其真实卷帘业务及事实，面料采购方式、规格、采购量和负责人留待沟通。未查明自产、用料或采购不影响企业初评；不能把这类潜在关联写成已确认的面料经营或采购事实。
成品经营、制造与材料配件业务分开取证。官网明确经营窗饰专用面料、型材、零件、电机或半成品可支持materials潜在适配机会，不要求其已经公开求购；只有自产成品不能自动生成其材料配件清单、采购需求或材料方向的计分事实。目录不等于企业采购需求，不能推断其愿意外采、兼容我方规格或已有合作意愿。
所有范围均须核对供货形态：Roller Shades等成品不能因direction填写materials就变成面料/配件机会；顾客选择面料颜色、升降方式、电动选项和成品购物结账不是材料贸易或材料加工流程。材料方向须有材料/配件本身的经营、供货或明确制造用料依据，P/R/D/V各引文也须适用于该材料产品；不能把成品零售的专业角色、定制或电动特征搬给材料。明确生产窗饰并实际使用特定材料的制造事实可支持相应用料适配，不要求公开求购；没有用料依据则留未知。
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
const materialWords =
  /\b(?:semi[- ]?finished|components?|parts?|motors?|fabrics?|textiles?|cloth|brackets?|headrails?|springs?|slats?|tubes?|tracks?|rails?|profiles?|extrusions?|hardware|accessories|mechanisms?|clutch(?:es)?|chains?|cords?)\b|半成品|材料|配件|零件|电机|制头|弹簧|安装码|叶片|型材|轨道|面料|卷管/i;
const sampleWords =
  /\b(?:sample (?:books?|cards?|kits?)|swatches?|display (?:kits?|cases?))\b|样本册|样册|样卡|展示套件|展示箱/i;
const productDirections = (text) => {
  const window = windowProductDirections(text);
  if (window.length) return window;
  if (sampleWords.test(text)) return ['samples'];
  return materialWords.test(text) ? ['materials'] : [];
};
const manufacturingUse = (text) =>
  compact(text)
    .split(/[.!?;。]/)
    .some(
      (clause) =>
        /\bwe\s+(?:(?:also|directly|locally|exclusively|proudly)\s+){0,3}(?:manufactur\w*|produc\w*|assembl\w*|fabricat\w*|make)\b|\bwe are (?:a |an )?(?:manufacturer|producer|fabricator)\b|\b(?:in|at) our (?:own )?(?:factor(?:y|ies)|workshop|manufacturing facility)\b|\bour (?:own )?(?:factor(?:y|ies)|workshop)\b[^.!?;]{0,80}\b(?:manufactur\w*|produc\w*|assembl\w*|fabricat\w*)\b|(?:我们|本厂)(?:自行|自己|专业|主要)?(?:生产|制造|加工|组装)|(?:自有|本公司|我们(?:的)?)(?:工厂|生产基地|车间)/i.test(
          clause,
        ) && /\b(?:using|uses?|from|with|consum\w*)\b|使用|采用|用料/i.test(clause),
    );
const directionEvidence = (evidence, direction) => {
  if (direction !== 'materials') return compact(evidence);
  // Consumer configuration of a finished blind is not a material sales or
  // production process. An explicit material roll/bulk offer or factory use is
  // kept, even when the same sentence also mentions choices/customisation.
  return compact(evidence)
    .split(/(?<=[.!?;])\s+/)
    .filter(
      (sentence) =>
        !/\b(?:choose|select|customization|customisation|check\s*out|cart|your measurements)\b|选择面料|选色|购物车|结账/i.test(
          sentence,
        ) ||
        /\b(?:by the roll|per (?:roll|metre|meter|yard)|bulk|wholesale)\b|按卷|每米|批发/i.test(
          sentence,
        ) ||
        manufacturingUse(sentence),
    )
    .join(' ');
};
const supportsProductEvidence = (evidence, product, direction) => {
  evidence = directionEvidence(evidence, direction);
  return (
    productDirections(evidence).includes(direction) &&
    (genericWindowProduct.test(product) ||
      compact(evidence).toLowerCase().includes(compact(product).toLowerCase()) ||
      productsRelevant([evidence], { product_scope: 'specific', product }) === 'matched')
  );
};
const supportsManufacturingMaterial = (fact, product) => {
  if (!manufacturingUse(fact.quote) || !supportsProductEvidence(fact.quote, product, 'materials'))
    return false;
  const family = product
    .replace(new RegExp(materialWords.source, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (
    windowProductDirections(fact.value).includes('finished') &&
    (!family || productsRelevant([fact.value], { product: family }) === 'matched')
  );
};

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
    const relation = businessProductRelation([product], target);
    const potentialInput =
      relation.kind === 'potential_input' && opportunity.direction === 'finished';
    if (product.length < 2 || (target.product && relation.status !== 'matched')) continue;
    const productForms = productDirections(product);
    if (productForms.length !== 1 || !productForms.includes(opportunity.direction)) continue;
    if (
      !allScope &&
      !potentialInput &&
      productTerms(target).length &&
      !productTerms(target)
        .flatMap(targetProductTerms)
        .some(
          (selected) =>
            productDirections(selected).includes(opportunity.direction) &&
            productsRelevant([product], { product: selected }) === 'matched',
        )
    )
      continue;
    if (
      !allScope &&
      !potentialInput &&
      target.products?.length &&
      !target.products.some(
        (selected) =>
          selected.direction === opportunity.direction &&
          productsRelevant([product], { product: selected.value, products: [selected] }) ===
            'matched',
      )
    )
      continue;
    if (allScope && !['finished', 'materials'].includes(opportunity.direction)) continue;
    const related = verifiedProductFacts.length
      ? verifiedProductFacts.some(
          (fact) =>
            typeof fact.value === 'string' &&
            ((supportsProductEvidence(fact.value, product, opportunity.direction) &&
              supportsProductEvidence(fact.quote, product, opportunity.direction)) ||
              (opportunity.direction === 'materials' &&
                supportsManufacturingMaterial(fact, product))),
        )
      : verifiedProducts.some((value) =>
          supportsProductEvidence(value, product, opportunity.direction),
        );
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
        directionFactKinds.has(fact.kind) &&
        !supportsProductEvidence(quote, product, opportunity.direction)
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
    result.push({
      direction: opportunity.direction,
      product,
      facts,
      ...(potentialInput
        ? { relationship: 'potential_input', target_product: target.product }
        : {}),
    });
  }
  return result;
}
