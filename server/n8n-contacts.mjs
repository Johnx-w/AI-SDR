import { extractContacts } from './contact-extractor.mjs';
import { phoneHelpers } from './phone-format.mjs';
import { mergeResearchFields } from './company-research.mjs';
import { customerFieldHelpers } from './customer-fields.mjs';

export function upgradePhoneWriteDecision(original) {
  const start = original.lastIndexOf("const rec=$('可查询?')");
  if (start < 0) throw new Error('未找到预期的飞书写入判定节点');
  let code = original
    .slice(start)
    .replace(
      'const old=exact[0],fields={...rec.update_fields};',
      'const old=exact[0];const fields={...rec.update_fields};',
    );
  const fieldsStart = code.indexOf('const fields=');
  const updateStart = code.lastIndexOf("return result('update'");
  if (fieldsStart < 0 || updateStart <= fieldsStart) throw new Error('飞书合并节点结构已变化');
  code =
    code.slice(0, fieldsStart) +
    'const fields=mergeResearchFields(old.fields,rec.update_fields);' +
    code.slice(updateStart);
  return (
    phoneHelpers + '\n' + customerFieldHelpers + '\n' + mergeResearchFields.toString() + '\n' + code
  );
}

// 只替换既有入库节点的联系提取段，不改业务画像、分流、去重及写入逻辑。
export function improveContactNode(original) {
  if (original.includes('CONTACT_EXTRACTION_RULE_VERSION'))
    throw new Error('联系规则已升级，请勿重复应用');
  const start = original.indexOf('  const body =');
  const end = original.indexOf('  const target =', start);
  if (start < 0 || end < 0 || !original.slice(start, end).includes('const phones ='))
    throw new Error('未找到预期的原始联系方式提取段');
  const improved =
    original.slice(0, start) +
    `
  const foundContacts = pages.filter(p => hostKey(p.url) === key).flatMap(p => extractContacts({
    content: p.raw_content || '', sourceUrl: p.url || r.source_url,
    country: r.actual_country || cfg.target_country || cfg.country || ''
  }));
  const contacts = [...new Map(foundContacts.map(c => [c.kind + ':' + c.normalized, c])).values()];
  const emails = contacts.filter(c => c.kind === 'email').map(c => c.value);
  const phones = contacts.filter(c => c.kind === 'phone').map(c => c.value);
` +
    original.slice(end);
  const evidencePattern =
    /\[\.\.\.contactEvidence\(emails,\s*['"]email['"]\),\s*\.\.\.contactEvidence\(phones,\s*['"]phone['"]\)\]/;
  if (!evidencePattern.test(improved)) throw new Error('原始联系证据结构不符合预期');
  return (
    `const CONTACT_EXTRACTION_RULE_VERSION = 'multi-market-v2';\n${phoneHelpers}\n${extractContacts.toString()}\n` +
    improved
      .replace(evidencePattern, 'contacts')
      .replace(
        "status:'已研究',contact_evidence:",
        "status:'已研究',contact_extraction_version:CONTACT_EXTRACTION_RULE_VERSION,contact_evidence:",
      )
  );
}
