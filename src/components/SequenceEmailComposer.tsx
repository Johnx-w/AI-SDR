import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft,
  Braces,
  ChevronRight,
  Mail,
  Monitor,
  PanelRightClose,
  PencilLine,
  Plus,
  RefreshCw,
  Smartphone,
  Sparkles,
  WandSparkles,
} from 'lucide-react';
import { outreachApi } from '../outreachApi';
import {
  expandTemplate,
  normalizeTemplate,
  variableLabels,
  type EmailTemplate,
  type CustomVariable,
} from '../domain/sequence-email.mjs';

type Mode = 'email' | 'opener' | 'ps' | 'subject' | 'rewrite';
type Contact = { id: string; company: string; email: string };
type Preview = {
  subject: string;
  body: string;
  greeting: string;
  signature: string;
  to: string;
  variables?: Record<string, string>;
};
const modes: Record<Mode, string> = {
  email: '整封邮件',
  opener: '开场白',
  ps: '附言（P.S.）',
  subject: '邮件主题',
  rewrite: '改写选区',
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : '操作失败，请重试');
type Props = {
  library: CustomVariable[];
  first: boolean;
  template: EmailTemplate;
  onChange: (v: EmailTemplate) => void;
  previewInput: Record<string, unknown>;
  settings: ReactNode;
  customer: string;
  onCustomer: (v: string) => void;
};

export function SequenceEmailComposer({
  first,
  library,
  template,
  onChange,
  previewInput,
  settings,
  customer,
  onCustomer,
}: Props) {
  const [panel, setPanel] = useState<'menu' | 'variables' | 'settings' | 'custom' | Mode | null>(
    'menu',
  );
  const [tone, setTone] = useState('default'),
    [guidelines, setGuidelines] = useState(''),
    [signals, setSignals] = useState(['customer', 'product']);
  const [variableName, setVariableName] = useState(''),
    [variableGuide, setVariableGuide] = useState(''),
    [editKey, setEditKey] = useState('');
  const available = new Map([...library, ...(template.variables || [])].map((v) => [v.key, v]));
  const [selection, setSelection] = useState({ start: 0, end: 0 }),
    [field, setField] = useState<'subject' | 'body'>('body');
  const bodyRef = useRef<HTMLTextAreaElement>(null),
    subjectRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<{ key: string; subject: string; text: string } | null>(null);
  const [working, setWorking] = useState(false),
    [aiError, setAiError] = useState('');
  const [preview, setPreview] = useState<{ key: string; value: Preview } | null>(null),
    [loading, setLoading] = useState(false),
    [previewError, setPreviewError] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [contactError, setContactError] = useState('');
  const [phone, setPhone] = useState(false);
  const previewKey = JSON.stringify([customer, previewInput, template.variables]);
  const previewRequest = useRef(0);
  useEffect(() => {
    previewRequest.current++;
    setLoading(false);
    setPreviewError('');
  }, [previewKey]);
  async function loadContacts(after = '', signal?: AbortSignal) {
    try {
      const data = await outreachApi<{ items: Contact[]; next: string | null }>(
        '/sequence-policy/contacts?after=' + encodeURIComponent(after),
        { signal },
      );
      if (signal?.aborted) return;
      setContacts((old) =>
        after ? [...old, ...data.items.filter((c) => !old.some((o) => o.id === c.id))] : data.items,
      );
      setCursor(data.next);
      setContactError('');
    } catch (e) {
      if (!signal?.aborted) setContactError(errorText(e));
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void loadContacts('', controller.signal);
    return () => controller.abort();
  }, []);
  async function generatePreview() {
    const id = ++previewRequest.current;
    setLoading(true);
    setPreviewError('');
    try {
      const value = await outreachApi<Preview>('/sequence-policy/preview', {
        method: 'POST',
        body: JSON.stringify({ ...previewInput, customer, template }),
      });
      if (id === previewRequest.current) setPreview({ key: previewKey, value });
    } catch (e) {
      if (id === previewRequest.current) {
        setPreview(null);
        setPreviewError(errorText(e));
      }
    } finally {
      if (id === previewRequest.current) setLoading(false);
    }
  }
  const sample = preview?.key === previewKey ? preview.value : null;
  let subject = '',
    body = '',
    expansionError = '';
  if (sample) {
    try {
      normalizeTemplate(template, first);
      subject =
        first && sample.variables
          ? expandTemplate(template.subject, sample.variables)
          : sample.subject;
      body = sample.variables
        ? [sample.greeting, expandTemplate(template.body, sample.variables), sample.signature].join(
            '\n\n',
          )
        : sample.body;
    } catch (e) {
      expansionError = errorText(e);
    }
  }
  const selected = template.body.slice(selection.start, selection.end);
  const requestKey = JSON.stringify([panel, template, field, selection, tone, guidelines, signals]);
  const suggestion = result?.key === requestKey ? result : null;
  function previewSuggestion(text: string) {
    if (!sample?.variables) return text;
    try {
      return expandTemplate(text, sample.variables);
    } catch {
      return text;
    }
  }
  function open(next: typeof panel) {
    setPanel(next);
    setAiError('');
    setResult(null);
  }
  async function suggest() {
    setWorking(true);
    setAiError('');
    try {
      const v = await outreachApi<{ subject: string; text: string }>('/sequence-policy/assist', {
        method: 'POST',
        body: JSON.stringify({
          mode: panel,
          first,
          template,
          selection: panel === 'rewrite' ? selected : '',
          guidelines,
          tone,
          signals,
        }),
      });
      setResult({ ...v, key: requestKey });
    } catch (e) {
      setAiError(errorText(e));
    } finally {
      setWorking(false);
    }
  }
  function insert(
    target: 'subject' | 'body',
    start: number,
    end: number,
    text: string,
    variables = template.variables,
  ) {
    const original = template[target];
    onChange({
      ...template,
      variables,
      [target]: original.slice(0, start) + text + original.slice(end),
    });
    requestAnimationFrame(() => {
      const el = target === 'subject' ? subjectRef.current : bodyRef.current;
      el?.focus();
      el?.setSelectionRange(start + text.length, start + text.length);
    });
  }
  function putVariable(key: string, custom?: CustomVariable) {
    const target = first ? field : 'body';
    const el = target === 'subject' ? subjectRef.current : bodyRef.current;
    const vars = custom
      ? [...(template.variables || []).filter((v) => v.key !== key), custom]
      : template.variables;
    insert(
      target,
      el?.selectionStart ?? template[target].length,
      el?.selectionEnd ?? template[target].length,
      '{{' + key + '}}',
      vars,
    );
  }
  function editVariable(v?: CustomVariable) {
    setVariableName(v?.label || '');
    setVariableGuide(v?.instruction || '');
    setEditKey(v?.key || '');
    open('custom');
  }
  function saveVariable() {
    const label = variableName.trim(),
      instruction = variableGuide.trim();
    const key =
      editKey ||
      'custom_' +
        (label.replace(/[^a-zA-Z0-9_\p{Script=Han}]+/gu, '_').slice(0, 40) ||
          crypto.randomUUID().slice(0, 8));
    if (!editKey && available.has(key)) {
      setAiError('此名称已存在，请从变量列表中选择或更换名称');
      return;
    }
    const v = { key, label, instruction };
    if (editKey && (template.subject + template.body).includes('{{' + key + '}}'))
      onChange({
        ...template,
        variables: [...(template.variables || []).filter((x) => x.key !== key), v],
      });
    else putVariable(key, v);
    open('variables');
  }
  function apply() {
    if (!suggestion) return;
    if (panel === 'email')
      onChange({ ...template, subject: first ? suggestion.subject : '', body: suggestion.text });
    else if (panel === 'subject') onChange({ ...template, subject: suggestion.subject });
    else if (panel === 'rewrite') insert('body', selection.start, selection.end, suggestion.text);
    else if (panel === 'opener')
      onChange({ ...template, body: suggestion.text + '\n\n' + template.body });
    else if (panel === 'ps')
      onChange({ ...template, body: template.body + '\n\n' + suggestion.text });
    open('menu');
  }
  const action = (name: string, click: () => void, icon: ReactNode, desc?: string) => (
    <button key={name} type="button" className="composer-action" onClick={click}>
      {icon}
      <span>
        <strong>{name}</strong>
        {desc && <small>{desc}</small>}
      </span>
      <ChevronRight size={14} />
    </button>
  );
  const mode = panel && Object.hasOwn(modes, panel) ? (panel as Mode) : null;
  return (
    <div className={'sequence-studio' + (!panel ? ' closed' : '')}>
      <section className="compose-paper">
        <header>
          <h3>编辑模板</h3>
          <button type="button" className="assist-toggle" onClick={() => open('menu')}>
            <Sparkles size={14} /> AI 写作
          </button>
        </header>
        <label>
          主题
          <input
            ref={subjectRef}
            maxLength={150}
            value={first ? template.subject : '回复上一封邮件'}
            readOnly={!first}
            onFocus={() => setField('subject')}
            onChange={(e) => onChange({ ...template, subject: e.target.value })}
          />
        </label>
        <label className="body-field">
          正文
          <textarea
            aria-label="邮件正文模板"
            ref={bodyRef}
            maxLength={6000}
            value={template.body}
            onFocus={() => setField('body')}
            onSelect={(e) =>
              setSelection({
                start: e.currentTarget.selectionStart,
                end: e.currentTarget.selectionEnd,
              })
            }
            onChange={(e) => onChange({ ...template, body: e.target.value })}
          />
        </label>
        <div className="compose-tools">
          <small>使用 AI 个性化</small>
          <div>
            {(['email', 'opener', 'ps'] as Mode[]).map((m) => (
              <button type="button" key={m} onClick={() => open(m)}>
                {modes[m]}
              </button>
            ))}
          </div>
          <div>
            <button type="button" onClick={() => open('variables')}>
              <Braces size={14} /> 插入变量
            </button>
            <button
              type="button"
              disabled={field !== 'body' || !selected}
              onClick={() => open('rewrite')}
            >
              <WandSparkles size={14} /> 改写选区
            </button>
          </div>
        </div>
        <footer>称呼和邮箱签名自动添加</footer>
      </section>
      <section className="compose-preview" aria-label="英文样信">
        <header>
          <h3>联系人预览</h3>
          <div className="device-switch">
            {(
              [
                [false, Monitor, '桌面'],
                [true, Smartphone, '手机'],
              ] as const
            ).map(([mobile, Icon, label]) => {
              const Device = Icon;
              return (
                <button
                  type="button"
                  key={String(label)}
                  aria-label={String(label) + '预览'}
                  aria-pressed={phone === mobile}
                  onClick={() => setPhone(Boolean(mobile))}
                >
                  <Device size={15} />
                </button>
              );
            })}
          </div>
        </header>
        <label>
          预览联系人
          <select
            aria-label="预览联系人"
            value={customer}
            onChange={(e) => onCustomer(e.target.value)}
          >
            <option value="">选择联系人</option>
            <optgroup label="示例客户">
              <option value="dealer">卷帘经销商 · Example Dealer</option>
              <option value="workshop">组装工厂 · Example Workshop</option>
            </optgroup>
            {contacts.length > 0 && (
              <optgroup label="已发送首封的联系人">
                {contacts.map((c) => (
                  <option key={c.id} value={'record:' + c.id}>
                    {c.company} · {c.email}
                  </option>
                ))}
              </optgroup>
            )}
            {customer.startsWith('record:') &&
              !contacts.some((c) => 'record:' + c.id === customer) && (
                <option value={customer}>已选联系人</option>
              )}
          </select>
        </label>
        {cursor && (
          <button type="button" className="text-link" onClick={() => void loadContacts(cursor)}>
            更多联系人
          </button>
        )}
        {contactError && (
          <button type="button" className="text-link" onClick={() => void loadContacts()}>
            联系人加载失败，重试
          </button>
        )}
        <button
          type="button"
          className="preview-trigger"
          disabled={!customer || loading}
          onClick={() => void generatePreview()}
        >
          <RefreshCw size={13} />
          {loading ? '生成中…' : sample ? '刷新预览' : '生成预览'}
        </button>
        <div className={'preview-paper' + (phone ? ' narrow' : '')}>
          {sample && !expansionError ? (
            <article>
              <small>收件人　{sample.to}</small>
              <strong>{subject}</strong>
              <p>{body}</p>
            </article>
          ) : (
            <div className="preview-empty">
              <Mail size={21} />
              <span>
                {previewError ||
                  expansionError ||
                  (!customer ? '请选择联系人' : '生成预览后在这里查看邮件')}
              </span>
            </div>
          )}
        </div>
      </section>
      {panel && (
        <aside className="compose-assistant">
          <header>
            {panel !== 'menu' && (
              <button type="button" aria-label="返回 AI 工具" onClick={() => open('menu')}>
                <ArrowLeft size={15} />
              </button>
            )}
            <h3>
              {panel === 'menu'
                ? 'AI 写作助手'
                : panel === 'variables'
                  ? '插入变量'
                  : panel === 'settings'
                    ? '个性化设置'
                    : panel === 'custom'
                      ? '自定义 AI 变量'
                      : mode
                        ? modes[mode]
                        : ''}
            </h3>
            <button type="button" aria-label="收起助手" onClick={() => open(null)}>
              <PanelRightClose size={15} />
            </button>
          </header>
          {panel === 'menu' ? (
            <>
              <small>创建</small>
              {action(
                '整封邮件',
                () => open('email'),
                <Sparkles size={17} />,
                '生成主题和个性化正文',
              )}
              {action(
                'AI 片段',
                () => open('opener'),
                <PencilLine size={17} />,
                '添加开场白或附言',
              )}
              {first &&
                action('邮件主题', () => open('subject'), <Mail size={17} />, '单独起草主题行')}
              {action(
                '自定义 AI 变量',
                () => editVariable(),
                <Plus size={17} />,
                '为每位客户生成指定内容',
              )}
              <small>使用已有内容</small>
              {action(
                '插入变量',
                () => open('variables'),
                <Braces size={17} />,
                '使用客户、产品或 AI 内容',
              )}
              {action(
                '个性化设置',
                () => open('settings'),
                <WandSparkles size={17} />,
                '调整每位客户的生成规则',
              )}
            </>
          ) : panel === 'settings' ? (
            settings
          ) : panel === 'custom' ? (
            <div className="assistant-form">
              <label>
                变量名称
                <input
                  maxLength={60}
                  value={variableName}
                  onChange={(e) => setVariableName(e.target.value)}
                  placeholder="例如：采购切入点"
                />
              </label>
              <label>
                变量写作指引
                <textarea
                  maxLength={600}
                  rows={4}
                  value={variableGuide}
                  onChange={(e) => setVariableGuide(e.target.value)}
                  placeholder="用一句话说明客户已经公开的产品与本次联系有什么关系。"
                />
              </label>
              {aiError && <p role="alert">{aiError}</p>}
              <button
                type="button"
                className="assist-primary"
                disabled={!variableName.trim() || !variableGuide.trim()}
                onClick={saveVariable}
              >
                {editKey ? '应用变量' : '插入变量'}
              </button>
            </div>
          ) : panel === 'variables' ? (
            <div className="variable-list">
              {Object.entries(variableLabels)
                .filter(
                  ([k]) =>
                    (first || k !== 'ai_subject') &&
                    (field !== 'subject' || !['ai_body', 'ai_opener', 'ai_question'].includes(k)),
                )
                .map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      putVariable(key);
                    }}
                  >
                    <Plus size={14} />
                    {label}
                    <code>{'{{' + key + '}}'}</code>
                  </button>
                ))}
              {[...available.values()].map((v) => (
                <div className="custom-variable" key={v.key}>
                  <button type="button" onClick={() => putVariable(v.key, v)}>
                    <Plus size={14} />
                    {v.label}
                  </button>
                  <button
                    type="button"
                    aria-label={'编辑变量 ' + v.label}
                    onClick={() => editVariable(v)}
                  >
                    <PencilLine size={14} />
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => editVariable()}>
                <Sparkles size={14} />
                新建 AI 变量
              </button>
            </div>
          ) : (
            <div className="assistant-form">
              {(mode === 'opener' || mode === 'ps') && (
                <div className="chip-row">
                  {(['opener', 'ps'] as Mode[]).map((m) => (
                    <button type="button" key={m} aria-pressed={mode === m} onClick={() => open(m)}>
                      {modes[m]}
                    </button>
                  ))}
                </div>
              )}
              {mode === 'rewrite' ? (
                <>
                  <label>
                    已选文字<blockquote>{selected || '请在正文中选中文字'}</blockquote>
                  </label>
                  <div className="chip-row">
                    {['缩短', '扩写', '简化表达', '改为要点'].map((v) => (
                      <button
                        type="button"
                        key={v}
                        aria-pressed={guidelines === v}
                        onClick={() => setGuidelines(v)}
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <strong>参考信息</strong>
                  <div className="chip-row">
                    {[
                      ['customer', '客户经营资料'],
                      ['product', '已核实产品'],
                    ].map(([k, v]) => (
                      <button
                        type="button"
                        key={k}
                        aria-pressed={signals.includes(k)}
                        onClick={() =>
                          setSignals((old) =>
                            old.includes(k) ? old.filter((x) => x !== k) : [...old, k],
                          )
                        }
                      >
                        {v}
                      </button>
                    ))}
                  </div>
                </>
              )}
              <strong>语气</strong>
              <div className="chip-row">
                {Object.entries({
                  default: '默认',
                  direct: '直接',
                  formal: '正式',
                  casual: '随和',
                  creative: '创意',
                  custom: '自定义',
                }).map(([k, v]) => (
                  <button
                    type="button"
                    key={k}
                    aria-pressed={tone === k}
                    onClick={() => setTone(k)}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <label>
                写作指引
                <textarea
                  rows={3}
                  maxLength={1200}
                  placeholder={tone === 'custom' ? '描述你想要的语气' : '例如：只问一个采购问题'}
                  value={guidelines}
                  onChange={(e) => setGuidelines(e.target.value)}
                />
              </label>
              {aiError && <p role="alert">{aiError}</p>}
              {suggestion && (
                <div className="suggestion" aria-live="polite">
                  <strong>建议稿</strong>
                  {suggestion.subject && <b>{previewSuggestion(suggestion.subject)}</b>}
                  <p>{previewSuggestion(suggestion.text)}</p>
                  <button type="button" className="assist-primary" onClick={apply}>
                    采用建议
                  </button>
                </div>
              )}
              <button
                type="button"
                className="assist-primary"
                disabled={
                  working ||
                  (mode === 'rewrite' && !selected) ||
                  (tone === 'custom' && !guidelines.trim())
                }
                onClick={() => void suggest()}
              >
                <Sparkles size={14} />
                {working ? '生成中…' : suggestion ? '重新生成' : '生成建议'}
              </button>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
