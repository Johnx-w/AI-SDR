export const variableLabels = {
  company: '客户公司',
  product: '匹配产品',
  brand: '发件品牌',
  ai_subject: 'AI 主题',
  ai_body: 'AI 正文',
  ai_opener: 'AI 开场白',
  ai_question: 'AI 回复问题',
};

export function defaultTemplate(first) {
  return { subject: first ? '{{ai_subject}}' : '', body: '{{ai_body}}' };
}

const invalid = (message) => Object.assign(new Error(message), { status: 400 });
export function normalizeTemplate(value, first) {
  if (value == null) return undefined;
  if (
    typeof value !== 'object' ||
    typeof value.body !== 'string' ||
    typeof value.subject !== 'string'
  )
    throw invalid('请输入邮件主题和正文');
  const body = value.body.trim(),
    subject = value.subject.trim();
  if (
    !body ||
    body.length > 6000 ||
    (first && !subject) ||
    subject.length > 150 ||
    /[\r\n]/u.test(subject) ||
    /[\x00-\x08\x0b-\x1f\x7f]/u.test(subject + body)
  )
    throw invalid('请核对主题和正文。主题最多 150 字，正文最多 6000 字');
  const variables = value.variables ?? [];
  if (
    !Array.isArray(variables) ||
    variables.length > 12 ||
    variables.some(
      (v) =>
        !v ||
        typeof v.key !== 'string' ||
        !/^custom_[a-zA-Z0-9_\p{Script=Han}]{1,40}$/u.test(v.key) ||
        typeof v.label !== 'string' ||
        !v.label.trim() ||
        v.label.length > 60 ||
        typeof v.instruction !== 'string' ||
        !v.instruction.trim() ||
        v.instruction.length > 600,
    ) ||
    new Set(variables.map((v) => v.key)).size !== variables.length
  )
    throw invalid('自定义变量需要名称和写作指引，每封最多 12 个');
  const labels = {
    ...variableLabels,
    ...Object.fromEntries(variables.map((v) => [v.key, v.label])),
  };
  for (const [key, text] of Object.entries({ subject, body })) {
    const rest = text.replace(/\{\{([a-zA-Z0-9_\p{Script=Han}]+)\}\}/gu, (_, name) => {
      if (
        !Object.hasOwn(labels, name) ||
        (key === 'subject' && ['ai_body', 'ai_opener', 'ai_question'].includes(name))
      )
        throw invalid('此处不能使用变量 {{' + name + '}}');
      return '';
    });
    if (/[{}]/u.test(rest)) throw invalid('请从变量菜单选择有效的邮件变量');
  }
  const defaults = defaultTemplate(first);
  const used = variables
    .filter((v) => (subject + body).includes('{{' + v.key + '}}'))
    .map((v) => ({ key: v.key, label: v.label.trim(), instruction: v.instruction.trim() }));
  return body === defaults.body && subject === defaults.subject
    ? undefined
    : { subject, body, ...(used.length > 0 && { variables: used }) };
}

export function mailVariables({ company, product, brand, subject, body }) {
  const paragraphs = body.trim().split(/\n\s*\n/u);
  const sentences = body.trim().match(/[^.!?\n]+[.!?](?=\s|$)/gu) || [];
  return {
    company,
    product,
    brand,
    ai_subject: subject,
    ai_body: body,
    ai_opener: paragraphs.length > 1 ? paragraphs[0] : sentences[0]?.trim() || body,
    ai_question: sentences.findLast((s) => s.endsWith('?'))?.trim() || '',
  };
}

export function repeatedBodyWarning(template = '') {
  if (template.split('{{ai_body}}').length > 2)
    return '模板重复插入了「AI 正文」，请确认预期效果。';
}

export function expandTemplate(text, variables) {
  return text.replace(/\{\{([a-zA-Z0-9_\p{Script=Han}]+)\}\}/gu, (_, name) => {
    const value = Object.hasOwn(variables, name) && variables[name];
    if (!value) throw invalid('当前联系人缺少变量「' + (variableLabels[name] || name) + '」');
    return value;
  });
}
