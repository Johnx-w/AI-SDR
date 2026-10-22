import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from './ui';
import './AssessmentPanel.css';

type Dimension = { score: number | null; maximum: number; missing?: string };
export interface AssessmentSummary {
  id: string;
  score: number;
  grade?: string | null;
  status?: string;
  complete: boolean;
  ruleVersion: string;
  evaluatedAt?: string;
  product?: string;
  direction?: string;
  evidenceReason?: string;
  incompleteReason?: string | null;
  dimensions?: Record<string, Dimension>;
  missing?: string[];
  sync?: { status: string; error?: string | null; recordId?: string | null };
  manualOverride?: boolean;
}
interface Evaluation extends AssessmentSummary {
  reason: string;
}
interface Props {
  recordId: string;
  country: string;
  product: string;
  assessment?: AssessmentSummary | null;
  onChanged: () => Promise<void>;
}
const dimensionNames: Record<string, string> = {
  P: '产品契合',
  R: '采购角色',
  D: '持续经营',
  V: '供货能力需求',
  I: '海关采购表现',
};
const countryAliases: Record<string, string> = {
  美国: 'United States',
  澳大利亚: 'Australia',
  澳洲: 'Australia',
  加拿大: 'Canada',
  英国: 'United Kingdom',
  新西兰: 'New Zealand',
};
const time = (value?: string) => (value ? new Date(value).toLocaleString('zh-CN') : '时间未知');
type PendingAssessment = { key: string; country: string; product: string };
const pendingKey = (recordId: string) => 'shadeflow:pending-assessment:' + recordId;
function readPending(recordId: string): PendingAssessment | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey(recordId)) || 'null');
    return value &&
      /^[\w-]{8,100}$/.test(value.key) &&
      typeof value.country === 'string' &&
      typeof value.product === 'string'
      ? value
      : null;
  } catch {
    return null;
  }
}
function savePending(recordId: string, value: PendingAssessment | null) {
  try {
    if (value) sessionStorage.setItem(pendingKey(recordId), JSON.stringify(value));
    else sessionStorage.removeItem(pendingKey(recordId));
  } catch {
    /* A restricted browser still retains the operation ID in the mounted panel. */
  }
}

export function AssessmentPanel({ recordId, country, product, assessment, onChanged }: Props) {
  const [pending] = useState(() => readPending(recordId));
  const [selectedCountry, setCountry] = useState(
    pending?.country || countryAliases[country] || country,
  );
  const [selectedProduct, setProduct] = useState(
    pending?.product ||
      product
        .split(/\n|[、；;]/)
        .map((v) => v.replace(/\([^)]*\)|（[^）]*）/g, '').trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(', '),
  );
  const [markets, setMarkets] = useState<{ value: string; label?: string }[]>([]);
  const [history, setHistory] = useState<Evaluation[]>([]);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [retrying, setRetrying] = useState('');
  const [unresolved, setUnresolved] = useState(!!pending);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const requestId = useRef<string | null>(pending?.key || null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/assessments/rules', { signal: controller.signal })
      .then(async (r) => {
        const data = await r.json();
        if (r.ok) setMarkets(data.markets || []);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setReading(true);
    setHistoryError('');
    fetch('/api/v1/leads/real/' + recordId + '/assessments', { signal: controller.signal })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || '评估历史读取失败');
        if (!controller.signal.aborted) setHistory(data.assessments || []);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setHistoryError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setReading(false);
      });
    return () => controller.abort();
  }, [recordId, revision]);

  async function evaluate() {
    if (loading) return;
    setLoading(true);
    setError('');
    setMessage('');
    requestId.current ||= crypto.randomUUID();
    savePending(recordId, {
      key: requestId.current,
      country: selectedCountry,
      product: selectedProduct,
    });
    try {
      const response = await fetch('/api/v1/leads/real/' + recordId + '/assessments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId.current },
        body: JSON.stringify({ country: selectedCountry, product: selectedProduct }),
      });
      const data = await response.json();
      if (!response.ok) {
        if ([400, 404, 415].includes(response.status)) {
          requestId.current = null;
          savePending(recordId, null);
          setUnresolved(false);
        } else setUnresolved(true);
        throw new Error(data.error || '研究评级结果待核对');
      }
      requestId.current = null;
      savePending(recordId, null);
      setUnresolved(false);
      if (!data.assessment || !data['更新'])
        throw new Error(data.reason || '本轮没有完成客户评级，未生成虚构历史');
      setMessage('已更新T2评级，并同步T12历史。');
      await onChanged();
    } catch (e) {
      if (requestId.current) setUnresolved(true);
      setError((e as Error).message || '连接中断，请核对并继续本次评估');
    } finally {
      setLoading(false);
      setRevision((v) => v + 1);
    }
  }
  async function retry(entry: Evaluation) {
    setRetrying(entry.id);
    setHistoryError('');
    try {
      const response = await fetch(
        '/api/v1/leads/real/' + recordId + '/assessments/' + entry.id + '/retry',
        { method: 'POST' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'T12历史仍待核对');
      await onChanged();
    } catch (e) {
      setHistoryError((e as Error).message);
    } finally {
      setRetrying('');
      setRevision((v) => v + 1);
    }
  }
  return (
    <section className="assessment-panel">
      <header>
        <h3>初步评分</h3>
        <p>
          官网证据按产品40、采购角色30、持续经营20、供货能力需求10计分，合计100分。海关采购表现另行分析。
        </p>
      </header>
      {assessment && (
        <div className="assessment-current">
          <strong>
            {assessment.grade || assessment.status || '未评级'} · 已支持 {assessment.score}/100
          </strong>
          <Badge>{assessment.complete ? '评分维度完整' : '含未知维度'}</Badge>
          {assessment.manualOverride && <Badge>主表评级已人工修改</Badge>}
          {assessment.sync && (
            <Badge tone={assessment.sync.status === 'synced' ? 'green' : 'neutral'}>
              {assessment.sync.status === 'synced' ? 'T12已同步' : 'T12待核对'}
            </Badge>
          )}
          <span>
            {assessment.ruleVersion} · {time(assessment.evaluatedAt)}
          </span>
          {assessment.ruleVersion !== 'acquisition-v3.0' && (
            <p>当前显示旧版评估，分值与新版权重不同；重新研究评级后生成新版结果，旧记录保留。</p>
          )}
          {assessment.dimensions && (
            <div className="assessment-dimensions">
              {Object.entries(assessment.dimensions).map(([key, value]) => (
                <div key={key}>
                  <span>{dimensionNames[key] || key}</span>
                  <strong>
                    {value.score === null ? '未知' : value.score} / {value.maximum}
                  </strong>
                </div>
              ))}
            </div>
          )}
          <details className="assessment-evidence-current" open>
            <summary>评级依据与待补资料</summary>
            {assessment.evidenceReason && (
              <p className="assessment-reason">{assessment.evidenceReason}</p>
            )}
            {assessment.incompleteReason && <p>本轮研究限制：{assessment.incompleteReason}</p>}
            {!!assessment.missing?.length && <p>待补充：{assessment.missing.join('；')}</p>}
          </details>
        </div>
      )}
      <div className="assessment-form">
        <label>
          企业国家
          <select
            aria-label="研究评级企业国家"
            disabled={loading || unresolved}
            value={selectedCountry}
            onChange={(e) => setCountry(e.target.value)}
          >
            {!markets.some((m) => m.value === selectedCountry) && (
              <option value={selectedCountry}>{selectedCountry || '请选择国家'}</option>
            )}
            {markets.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label || m.value}
              </option>
            ))}
          </select>
        </label>
        <label>
          本次评价的具体产品
          <input
            aria-label="研究评级产品"
            maxLength={500}
            value={selectedProduct}
            disabled={loading || unresolved}
            onChange={(e) => setProduct(e.target.value)}
            placeholder="例如 roller blinds"
          />
        </label>
        <button
          className="btn primary"
          disabled={loading || !selectedCountry || !selectedProduct.trim()}
          onClick={() => void evaluate()}
        >
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
          {loading ? '正在研究并评级…' : unresolved ? '核对并继续本次评估' : '研究并评级'}
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className="assessment-error">
          {error}
        </p>
      )}
      <section aria-label="海关采购表现">
        <h3>后续海关分析</h3>
        <p>
          初评完成后独立分析相关产品的进口规模、频率、新近性及中国来源占比，不加到初评分数中。数据接入尚未完成。
        </p>
      </section>
      <div className="assessment-history-heading">
        <h3>评估历史</h3>
        <button
          className="btn secondary"
          disabled={reading}
          onClick={() => setRevision((v) => v + 1)}
        >
          刷新历史
        </button>
      </div>
      <p>显示最近100次评估，完整历史同时保存在T12。</p>
      {historyError && (
        <p role="alert" className="assessment-error">
          {historyError}
        </p>
      )}
      {reading ? (
        <p>正在读取评估记录…</p>
      ) : !history.length ? (
        <p>尚无自动评估历史。研究评级完成后会在这里和T12保留记录。</p>
      ) : (
        history.map((entry) => (
          <details className="assessment-history-entry" key={entry.id}>
            <summary>
              {time(entry.evaluatedAt)} · {entry.grade || entry.status || '未评级'} · 已支持
              {entry.score}分 · {entry.ruleVersion}{' '}
              <Badge>{entry.sync?.status === 'synced' ? 'T12已同步' : 'T12待核对'}</Badge>
            </summary>
            <p className="assessment-reason">{entry.evidenceReason || entry.reason}</p>
            {entry.sync?.error && <p className="assessment-error">{entry.sync.error}</p>}
            {entry.sync?.status !== 'synced' && (
              <button
                className="btn secondary"
                disabled={!!retrying || loading}
                onClick={() => void retry(entry)}
              >
                {retrying === entry.id ? '核对中…' : '核对T12同步'}
              </button>
            )}
          </details>
        ))
      )}
    </section>
  );
}
