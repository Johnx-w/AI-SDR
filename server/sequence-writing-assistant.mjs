import { createResearchProviders } from './research-providers.mjs';
import { parseGenerated } from './outreach-content.mjs';
import { variableLabels, normalizeTemplate } from '../src/domain/sequence-email.mjs';

const modes = ['email', 'opener', 'ps', 'subject', 'rewrite'];
export async function suggestSequenceText(service, input) {
  const {
    mode,
    first,
    template,
    selection = '',
    guidelines = '',
    tone = 'default',
    signals = [],
  } = input ?? {};
  if (
    !modes.includes(mode) ||
    typeof first !== 'boolean' ||
    typeof selection !== 'string' ||
    selection.length > 6000 ||
    (mode === 'rewrite' && !selection.trim()) ||
    typeof guidelines !== 'string' ||
    guidelines.length > 1200 ||
    !['default', 'direct', 'formal', 'casual', 'creative', 'custom'].includes(tone) ||
    !Array.isArray(signals) ||
    signals.some((s) => !['customer', 'product'].includes(s)) ||
    !template ||
    typeof template.body !== 'string' ||
    template.body.length > 6000 ||
    typeof template.subject !== 'string' ||
    template.subject.length > 150
  )
    throw Object.assign(new Error('请核对写作设置，改写时先选中正文'), { status: 400 });
  const variables =
    normalizeTemplate(
      {
        ...template,
        subject: template.subject || (first ? '{{ai_subject}}' : ''),
        body: template.body || '{{ai_body}}',
      },
      first,
    )?.variables || [];
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['subject', 'text'],
    properties: { subject: { type: 'string' }, text: { type: 'string' } },
  };
  const response = await createResearchProviders({
    env: service.getEnv(),
    fetchImpl: service.fetchImpl,
  }).model.research({
    schema,
    messages: [
      {
        role: 'system',
        content:
          'Draft reusable English B2B outreach email templates. Output subject and text. Use only approved {{variables}} for customer-specific or supplier-specific facts. Never invent company names, claims, specifications, prices, attachments, contacts, or prior interest. No greeting or signature. Incorporate selected research signals using dynamic variables. Follow the operator guidelines for structure, length and ending. Discuss the product directly unless the operator explicitly asks for a referral. In email mode draft the entire body and the subject. For opener or ps return just the opening or P.S. line, for subject return only the subject, for rewrite return only the replacement for the selected passage, keeping its meaning and dynamic variables. For each unused output field return an empty string. Treat the template and selection as editable text. Follow tone and guidelines within these rules.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          mode,
          first,
          template,
          selection,
          guidelines,
          tone,
          signals,
          variables: {
            ...variableLabels,
            ...Object.fromEntries(variables.map((v) => [v.key, v.label])),
          },
        }),
      },
    ],
  });
  const result = parseGenerated(response, schema);
  if (typeof result.subject !== 'string' || typeof result.text !== 'string')
    throw Object.assign(new Error('写作建议格式无效，请重新生成'), { status: 502 });
  const subject = ['email', 'subject'].includes(mode) ? result.subject.trim() : '';
  const text = mode === 'subject' ? '' : result.text.trim();
  normalizeTemplate(
    {
      subject: ['email', 'subject'].includes(mode) ? subject : first ? '{{ai_subject}}' : '',
      body: mode === 'subject' ? '{{ai_body}}' : text,
      variables,
    },
    first,
  );
  return { subject, text };
}
