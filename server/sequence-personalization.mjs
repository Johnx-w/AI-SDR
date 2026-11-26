export const personalizationPolicy =
  '\nFor each personalization_rules entry, write its plain English email fragment in the additional JSON field named by its key. Use only the provided recipient evidence or thread history and approved sender facts. Never infer a buyer need or invent facts. If evidence is insufficient, return an empty string for that fragment. No placeholders, greeting, signature or new commercial claims.';

export function addPersonalizedFields(schema, rules) {
  for (const { key } of rules) {
    schema.required.push(key);
    schema.properties[key] = { type: 'string' };
  }
}

export function personalizedValues(draft, rules) {
  const values = {};
  for (const { key, label } of rules) {
    const text = draft[key];
    if (
      typeof text !== 'string' ||
      !text.trim() ||
      text.length > 1200 ||
      /[{}\x00-\x08\x0b-\x1f\x7f]/u.test(text)
    )
      throw Object.assign(new Error('无法为当前客户生成「' + label + '」，请核对资料或变量指引'), {
        status: 422,
      });
    values[key] = text.trim();
  }
  return values;
}
