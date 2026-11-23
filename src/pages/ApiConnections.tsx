import { useSearchParams } from 'react-router-dom';
import { SectionWorkspace } from '../components/SectionWorkspace';
import { useEffect, useState } from 'react';
import { Database, Globe2, LoaderCircle, RefreshCw, Save, Settings2, Sparkles } from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { Badge } from '../components/ui';
import { useWorkspace } from '../app/WorkspaceProvider';
import { connectionsApi } from '../services/acquisition';
import { leadLibrary } from '../services/leadLibrary';
import type { ConnectionSettings } from '../domain/types';
import {
  createConnectionForm,
  connectionFormFields,
  connectionFormPayload,
  updateConnectionForm,
} from '../domain/connection-settings.mjs';
import type { ConnectionFormAction } from '../domain/connection-settings.mjs';

const connectionViews = [
  { id: 'search', label: '搜索 API', icon: Globe2 },
  { id: 'feishu', label: '飞书同步', icon: Database },
  { id: 'models', label: '大语言模型 API', icon: Sparkles },
];
const groups = [
  {
    title: '官网搜索与网页读取',
    icon: Globe2,
    view: 'search',
    prefix: 'WEB_SEARCH_',
    detail: '搜索企业官网并读取网页正文，网页服务可独立替换。',
  },
  {
    title: '企业研究 · 大语言模型',
    icon: Sparkles,
    view: 'models',
    prefix: 'RESEARCH_MODEL_',
    detail: '依据证据生成企业画像并执行准入判断。模型服务独立配置，可替换。',
  },
  {
    title: '素材库 · DeepSeek 文档解析',
    icon: Sparkles,
    view: 'models',
    prefix: 'MATERIAL_DEEPSEEK_',
    detail:
      'PDF、Word 和 PowerPoint 发送至 DeepSeek 官方接口。可使用专用密钥，留空时复用已配置的官方 DeepSeek 密钥。',
  },
  {
    title: '产品资料 · 图纸与规格识别',
    icon: Sparkles,
    view: 'models',
    prefix: 'DOCUMENT_MODEL_',
    detail:
      '选用支持图片、PDF 和 Responses API 的模型。点击 AI 提取时将原文件发送至此服务，提取结果需人工审核。',
  },
  {
    title: '客户入库 · 飞书',
    icon: Database,
    view: 'feishu',
    prefix: 'FEISHU_',
    detail: '填写飞书应用凭证及目标多维表格标识，应用需有该表的读写权限。',
  },
];
const providerOptions: Record<string, { value: string; label: string }[]> = {
  WEB_SEARCH_PROVIDER: [
    { value: 'tavily', label: 'Tavily' },
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'http', label: '兼容 HTTP 服务' },
  ],
  RESEARCH_MODEL_PROVIDER: [
    { value: 'deepseek', label: 'DeepSeek' },
    { value: 'openai_compatible', label: 'OpenAI 兼容服务' },
  ],
};

export function ApiConnections() {
  const [params, setParams] = useSearchParams();
  const view = connectionViews.find((item) => item.id === params.get('tab')) || connectionViews[0];
  const { notify } = useWorkspace();
  const [settings, setSettings] = useState<ConnectionSettings | null>(null);
  const [form, setForm] = useState(createConnectionForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fields = settings ? connectionFormFields(settings, form) : [];
  function accept(value: ConnectionSettings) {
    setSettings(value);
    setForm(createConnectionForm());
  }
  function update(action: ConnectionFormAction) {
    if (!settings) return;
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
  return (
    <SectionWorkspace
      title="API 连接"
      icon={Settings2}
      selected={view.id}
      sections={[{ items: connectionViews }]}
      onSelect={(tab) => {
        const next = new URLSearchParams(params);
        next.set('tab', tab);
        setParams(next);
      }}
    >
      <div className="section-page">
        <PageHeading eyebrow="API CONNECTIONS" title={view.label}>
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
              <strong>连接配置</strong>
              <p>切换栏目会保留当前修改，保存时一并生效。已保存密钥仅显示脱敏摘要。</p>
            </div>
            {settings && (
              <Badge tone={settings.ready ? 'green' : 'amber'}>
                {settings.ready ? '全部连接必填项已填写' : '部分连接待补充必填项'}
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
            groups
              .filter((group) => group.view === view.id)
              .map((group) => (
                <section className="panel connection-group" key={group.prefix}>
                  <div className="connection-group-heading">
                    <group.icon size={21} />
                    <div>
                      <h2>{group.title}</h2>
                      <p>{group.detail}</p>
                    </div>
                  </div>
                  <fieldset className="form-grid" disabled={busy}>
                    {fields
                      .filter(
                        (field) =>
                          field.key.startsWith(group.prefix) &&
                          field.key !== 'RESEARCH_MODEL_REASONING_EFFORT',
                      )
                      .map((field) => {
                        const editing = form.editingSecrets.includes(field.key);
                        const showMask = field.secret && field.configured && !editing;
                        const options = providerOptions[field.key];
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
                              {options ? (
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
                                  {!options.some((option) => option.value === field.value) && (
                                    <option value={field.value}>
                                      {field.value || '选择提供方'}
                                    </option>
                                  )}
                                  {options.map((option) => (
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
                            {field.description && (
                              <small className="muted">{field.description}</small>
                            )}
                            <div className="connection-clear-row">
                              {field.configured && !options && (
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
                保存全部修改
              </button>
            </div>
          )}
        </form>
      </div>
    </SectionWorkspace>
  );
}
