import choices from '../src/domain/mail-writing-options.json' with { type: 'json' };

export function normalizeWritingOptions(input = {}) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((k) => !Object.hasOwn(choices, k))
  )
    throw invalid();
  const options = {};
  for (const [field, values] of Object.entries(choices)) {
    if (input[field] === undefined || input[field] === '') continue;
    if (typeof input[field] !== 'string' || !Object.hasOwn(values, input[field])) throw invalid();
    options[field] = input[field];
  }
  return Object.keys(options).length ? options : undefined;
}

function invalid() {
  return Object.assign(new Error('请选择有效的邮件写法'), { status: 400 });
}

export function firstWritingRequirements(body, closing, options) {
  const text = (field) => choices[field][options?.[field]]?.[1];
  return {
    firstBodyInstruction: [text('angle'), text('tone'), body].filter(Boolean).join('\n'),
    firstInstruction: [text('reply'), closing].filter(Boolean).join('\n'),
  };
}

export function followWritingRequirement(note, options) {
  const requirements = firstWritingRequirements('', '', options);
  return [requirements.firstBodyInstruction, requirements.firstInstruction, note]
    .filter(Boolean)
    .join('\n');
}
