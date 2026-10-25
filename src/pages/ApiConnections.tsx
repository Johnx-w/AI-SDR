import { useEffect, useRef, useState } from 'react';
import { Database, Globe2, LoaderCircle, RefreshCw, Save, Sparkles } from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { Badge } from '../components/ui';
import { useWorkspace } from '../app/WorkspaceProvider';
import { connectionsApi } from '../services/acquisition';
import { leadLibrary } from '../services/leadLibrary';
import type { ConnectionModelCatalog, ConnectionSettings } from '../domain/types';
import {
  createConnectionForm,
  connectionFormFields,
  connectionFormPayload,
  updateConnectionForm,
} from '../domain/connection-settings.mjs';
import type { ConnectionFormAction } from '../domain/connection-settings.mjs';

const groups = [
  {
    title: '官网搜索与网页读取',
    icon: Globe2,
    prefix: 'WEB_SEARCH_',
    detail: '搜索企业官网并读取网页正文，网页服务可独立替换。',
  },
  {
    title: '海关记录找买家',
    icon: Database,
    prefix: 'CUSTOMS_',
    detail:
      '可选连接。按具体货物发现北美面料、组件和 plantation shutters 买方，再进行官网核实。数据服务商可更换，未配置不影响官网通道。',
  },
  {
    title: '企业研究 · 大语言模型',
    icon: Sparkles,
    prefix: 'RESEARCH_MODEL_',
    detail: '依据证据生成企业画像并执行准入判断。模型服务独立配置，可替换。',
  },
  {
    title: '客户入库 · 飞书',
    icon: Database,
    prefix: 'FEISHU_',
    detail: '填写飞书应用凭证及目标多维表格标识，应用需有该表的读写权限。',
  },
];
const providerOptions: Record<string, { value: string; label: string }[]> = {
  RESEARCH_MODEL_REASONING_EFFORT: [
    { value: 'none', label: '关闭推理' },
    { value: 'low', label: '低' },
    { value: 'high', label: '高' },
    { value: 'max', label: '最高' },
  ],
  WEB_SEARCH_PROVIDER: [
    { value: 'tavily', label: 'Tavily' },
    { value: 'http', label: '兼容 HTTP 服务' },
  ],
  RESEARCH_MODEL_PROVIDER: [
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'openai_compatible', label: 'OpenAI 兼容服务' },
  ],
  CUSTOMS_PROVIDER: [
    { value: 'billofladingdata', label: 'BillOfLadingData' },
    { value: 'http', label: '兼容 HTTP 服务' },
  ],
};
const modelConnectionKeys = new Set([
  'RESEARCH_MODEL_PROVIDER',
  'RESEARCH_MODEL_BASE_URL',
  'RESEARCH_MODEL_API_KEY',
]);

export function ApiConnections() {
  const { notify } = useWorkspace();
  const [settings, setSettings] = useState<ConnectionSettings | null>(null);
  const [form, setForm] = useState(createConnectionForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [catalog, setCatalog] = useState<ConnectionModelCatalog | null>(null);
  const [modelError, setModelError] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const modelRequest = useRef(0);
  const fields = settings ? connectionFormFields(settings, form) : [];
  const selectedModel = fields.find((field) => field.key === 'RESEARCH_MODEL_MODEL')?.value || '';
  function invalidateModels() {
    modelRequest.current++;
    setCatalog(null);
    setModelError('');
    setModelsLoading(false);
  }
  function accept(value: ConnectionSettings) {
    setSettings(value);
    setForm(createConnectionForm());
    invalidateModels();
  }
  function update(action: ConnectionFormAction) {
    if (!settings) return;
    if (modelConnectionKeys.has(action.key)) invalidateModels();
    setForm((current) => updateConnectionForm(settings, current, action));
  }
  async function load() {
    setBusy(true);
    setError('');
    try {
      accept(await connectionsApi.get());
    } catch (e) {
      setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      modelRequest.current++;
    };
  }, []);
  async function save() {
    if (!settings) return;
    setBusy(true);
    setError('');
    try {
      const payload = connectionFormPayload(settings, form);
      accept(await connectionsApi.save(payload.values, payload.clear));
      leadLibrary.reset();
      notify('API 配置已保存，直连引擎已使用新配置');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  async function readModels() {
    if (!settings) return;
    const request = ++modelRequest.current;
    setModelsLoading(true);
    setModelError('');
    setCatalog(null);
    const payload = connectionFormPayload(settings, form);
    const values = Object.fromEntries(
      Object.entries(payload.values).filter(([key]) => key.startsWith('RESEARCH_MODEL_')),
    );
    const clear = payload.clear.filter((key) => /^(RESEARCH_MODEL_|DEEPSEEK_)/.test(key));
    try {
      const response = await connectionsApi.models(values, clear);
      if (request === modelRequest.current) setCatalog(response);
    } catch (e) {
      if (request === modelRequest.current)
        setModelError(e instanceof Error ? e.message : '读取模型目录失败，可手动填写模型名称');
    } finally {
      if (request === modelRequest.current) setModelsLoading(false);
    }
  }
  return (
    <>
      <PageHeading eyebrow="API CONNECTIONS" title="API 连接">
        <button className="btn secondary" disabled={busy} onClick={() => void load()}>
          <RefreshCw size={15} />
          重新读取
        </button>
      </PageHeading>
      <form
        className="connection-settings"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        autoComplete="off"
      >
        <div className="connection-settings-summary">
          <div>
            <strong>Node.js 直连配置</strong>
            <p>
              发现来源、海关服务与研究模型可分别替换。已保存密钥以脱敏摘要显示，修改时重新输入。
            </p>
          </div>
          {settings && (
            <Badge tone={settings.ready ? 'green' : 'amber'}>
              {settings.ready ? '必填项已填写' : '待补充必填项'}
            </Badge>
          )}
        </div>
        {error && (
          <div className="error-message" role="alert">
            {error}
          </div>
        )}
        {!settings && busy && <p className="muted">正在读取配置…</p>}
        {settings &&
          groups.map((group) => (
            <section className="panel connection-group" key={group.prefix}>
              <div className="connection-group-heading">
                <group.icon size={21} />
                <div>
                  <h2>{group.title}</h2>
                  <p>{group.detail}</p>
                </div>
              </div>
              {group.prefix === 'RESEARCH_MODEL_' && (
                <div className="connection-model-tools">
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy || modelsLoading}
                    onClick={() => void readModels()}
                  >
                    {modelsLoading ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <RefreshCw size={15} />
                    )}
                    读取可用模型
                  </button>
                  <p className="muted">从当前 API 读取模型目录，也可手动填写。</p>
                  {modelError && (
                    <p className="error-message" role="alert">
                      {modelError}
                    </p>
                  )}
                  {catalog && (
                    <p className="muted" role="status">
                      {catalog.status === 'available'
                        ? `已读取 ${catalog.models.length} 个模型；研究能力以实际调用为准。`
                        : catalog.message || '该服务不支持列出模型，请手动填写模型名称。'}
                    </p>
                  )}
                </div>
              )}
              <fieldset className="form-grid" disabled={busy}>
                {fields
                  .filter((field) => field.key.startsWith(group.prefix))
                  .map((field) => {
                    const editing = form.editingSecrets.includes(field.key);
                    const showMask = field.secret && field.configured && !editing;
                    const modelField = field.key === 'RESEARCH_MODEL_MODEL';
                    return (
                      <div className="connection-field" key={field.key}>
                        <label htmlFor={field.key} className="connection-field-label">
                          <span>{field.label}</span>
                          <small>
                            {field.cleared
                              ? '待清除'
                              : field.configured
                                ? '已保存'
                                : field.required
                                  ? '必填'
                                  : '可修改'}
                          </small>
                        </label>
                        <div className="connection-control-row">
                          {providerOptions[field.key] ? (
                            <select
                              id={field.key}
                              aria-label={field.label}
                              value={field.value}
                              disabled={field.cleared}
                              onChange={(event) =>
                                update({
                                  type: 'change',
                                  key: field.key,
                                  value: event.target.value,
                                })
                              }
                            >
                              {!providerOptions[field.key].some(
                                (option) => option.value === field.value,
                              ) && (
                                <option value={field.value}>{field.value || '选择提供方'}</option>
                              )}
                              {providerOptions[field.key].map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <input
                              id={field.key}
                              aria-label={field.label}
                              type={field.secret && !showMask ? 'password' : 'text'}
                              value={showMask ? field.maskedValue || '********' : field.value}
                              readOnly={showMask}
                              autoComplete={field.secret && !showMask ? 'new-password' : 'off'}
                              spellCheck={false}
                              disabled={field.cleared}
                              maxLength={2000}
                              placeholder={
                                field.secret && field.configured
                                  ? '输入新密钥以替换'
                                  : modelField
                                    ? '选择目录模型或手动填写模型 ID'
                                    : `填写 ${field.label}`
                              }
                              onChange={(event) =>
                                update({
                                  type: 'change',
                                  key: field.key,
                                  value: event.target.value,
                                })
                              }
                            />
                          )}
                          {field.secret && field.configured && (
                            <button
                              type="button"
                              className="btn subtle"
                              aria-label={`${editing ? '取消修改' : '修改'} ${field.label}`}
                              disabled={field.cleared}
                              onClick={() =>
                                update({
                                  type: editing ? 'cancel_secret' : 'edit_secret',
                                  key: field.key,
                                })
                              }
                            >
                              {editing ? '取消' : '修改'}
                            </button>
                          )}
                        </div>
                        {modelField &&
                          catalog?.status === 'available' &&
                          catalog.models.length > 0 && (
                            <select
                              className="connection-model-directory"
                              aria-label="可用模型目录"
                              value=""
                              disabled={field.cleared}
                              onChange={(event) => {
                                if (event.target.value)
                                  update({
                                    type: 'change',
                                    key: field.key,
                                    value: event.target.value,
                                  });
                              }}
                            >
                              <option value="">从目录选择模型（可继续手动填写）</option>
                              {catalog.models.map((model) => (
                                <option key={model.id} value={model.id}>
                                  {model.name ? `${model.name} · ${model.id}` : model.id}
                                </option>
                              ))}
                            </select>
                          )}
                        {modelField &&
                          catalog?.status === 'available' &&
                          selectedModel &&
                          !catalog.models.some((model) => model.id === selectedModel) && (
                            <small className="muted">
                              当前填写的模型不在目录中，已保留；可继续手动填写。
                            </small>
                          )}
                        {field.description && <small className="muted">{field.description}</small>}
                        <div className="connection-clear-row">
                          {field.configured && !providerOptions[field.key] && (
                            <label className="connection-clear">
                              <input
                                aria-label={`清除 ${field.label}`}
                                type="checkbox"
                                checked={field.cleared}
                                onChange={(event) =>
                                  update({
                                    type: 'clear',
                                    key: field.key,
                                    checked: event.target.checked,
                                  })
                                }
                              />
                              清除已保存值
                            </label>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </fieldset>
            </section>
          ))}
        {settings && (
          <div className="connection-save">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}
              保存并启用直连配置
            </button>
          </div>
        )}
      </form>
    </>
  );
}
