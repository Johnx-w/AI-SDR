import { useEffect, useState } from 'react';
import { Database, Globe2, LoaderCircle, RefreshCw, Save, Sparkles } from 'lucide-react';
import { PageHeading } from '../components/PageHeading';
import { Badge } from '../components/ui';
import { useWorkspace } from '../app/WorkspaceProvider';
import { connectionsApi } from '../services/acquisition';
import type { ConnectionSettings } from '../domain/types';

const groups = [
  {
    title: '网页搜索 · Tavily',
    icon: Globe2,
    prefix: 'TAVILY_',
    detail: '用于搜索企业官网与获取网页正文。',
  },
  {
    title: '企业研究 · DeepSeek',
    icon: Sparkles,
    prefix: 'DEEPSEEK_',
    detail: '用于依据官网证据提取企业画像，并执行客户准入判断。',
  },
  {
    title: '客户入库 · 飞书',
    icon: Database,
    prefix: 'FEISHU_',
    detail: '填写飞书应用凭证及目标多维表格标识，应用需有该表的读写权限。',
  },
];

export function ApiConnections() {
  const { notify } = useWorkspace();
  const [settings, setSettings] = useState<ConnectionSettings | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [clear, setClear] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function accept(value: ConnectionSettings) {
    setSettings(value);
    setDraft(Object.fromEntries(value.fields.map((field) => [field.key, field.value])));
    setClear([]);
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
    setBusy(true);
    setError('');
    try {
      accept(await connectionsApi.save(draft, clear));
      notify('API 配置已保存，直连引擎已使用新配置');
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setBusy(false);
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
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        autoComplete="off"
      >
        <div className="connection-settings-summary">
          <div>
            <strong>Node.js 直连配置</strong>
            <p>凭证保存在本机服务端。密钥留空保留原值，保存后立即生效。</p>
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
              <fieldset className="form-grid" disabled={busy}>
                {settings.fields
                  .filter((field) => field.key.startsWith(group.prefix))
                  .map((field) => (
                    <div className="connection-field" key={field.key}>
                      <label htmlFor={field.key}>
                        <span className="connection-field-heading">
                          {field.label}
                          <small>
                            {field.configured
                              ? '已填写'
                              : field.key === 'DEEPSEEK_MODEL'
                                ? '可使用默认模型'
                                : '必填'}
                          </small>
                        </span>
                      </label>
                      <input
                        id={field.key}
                        aria-label={field.label}
                        type={field.secret ? 'password' : 'text'}
                        autoComplete={field.secret ? 'new-password' : 'off'}
                        spellCheck={false}
                        value={draft[field.key] || ''}
                        disabled={clear.includes(field.key)}
                        maxLength={2000}
                        placeholder={
                          field.secret && field.configured
                            ? '已设置，留空保留；输入新值可替换'
                            : `填写 ${field.label}`
                        }
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, [field.key]: event.target.value }))
                        }
                      />
                      {field.configured && (
                        <label className="connection-clear">
                          <input
                            aria-label={`清除 ${field.label}`}
                            type="checkbox"
                            checked={clear.includes(field.key)}
                            onChange={(event) =>
                              setClear((current) =>
                                event.target.checked
                                  ? [...current, field.key]
                                  : current.filter((key) => key !== field.key),
                              )
                            }
                          />
                          清除已保存值
                        </label>
                      )}
                    </div>
                  ))}
              </fieldset>
            </section>
          ))}
        {settings && (
          <div className="connection-save">
            <p className="muted">
              “已填写”表示配置齐备，实际连接结果以任务记录为准。有未结束的任务时，需先完成或核对任务再修改连接。
            </p>
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
