import { useState } from 'react';
import { Check, ChevronDown, Plus, Search, X } from 'lucide-react';
import { acquisitionApi } from '../services/acquisition';
import { directionLabels, validateProduct } from '../domain/acquisition-products.mjs';
import type { ProductSelection } from '../domain/types';

const emptyProduct: ProductSelection = {
  value: '',
  label: '',
  direction: 'finished',
  group: '自定义产品',
  aliases: [],
};
export function ProductPicker({
  catalog,
  selected,
  onChange,
  onSaved,
  disabled = false,
}: {
  catalog: ProductSelection[];
  selected: ProductSelection[];
  onChange: (products: ProductSelection[]) => void;
  onSaved: (product: ProductSelection) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [direction, setDirection] = useState('all');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<ProductSelection>(emptyProduct);
  const [aliases, setAliases] = useState('');
  const [common, setCommon] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const all = [
    ...new Map([...catalog, ...selected].map((p) => [p.value.toLowerCase(), p])).values(),
  ];
  const visible = all.filter(
    (p) =>
      (direction === 'all' || p.direction === direction) &&
      `${p.label} ${p.value} ${p.aliases.join(' ')} ${p.group}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const update = (next: ProductSelection[]) => {
    if (next.length > 12 || next.map((p) => p.value).join(', ').length > 500) {
      setError('每轮最多选择12个产品，英文名称合计不超过500字。请分成多个计划。');
      return;
    }
    setError('');
    onChange(next);
  };
  const toggle = (product: ProductSelection) => {
    const exists = selected.some((p) => p.value.toLowerCase() === product.value.toLowerCase());
    update(
      exists
        ? selected.filter((p) => p.value.toLowerCase() !== product.value.toLowerCase())
        : [...selected, product],
    );
  };
  async function add() {
    setError('');
    setSaving(true);
    try {
      const product = validateProduct({
        ...draft,
        aliases: aliases
          .split(/[\n,，]/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      if (
        selected.length >= 12 ||
        [...selected.map((p) => p.value), product.value].join(', ').length > 500
      )
        throw new Error('已达到本轮产品上限，请先移除部分产品');
      const actual = common ? await acquisitionApi.saveProduct(product) : product;
      if (common) onSaved(actual);
      update([
        ...selected.filter((p) => p.value.toLowerCase() !== actual.value.toLowerCase()),
        actual,
      ]);
      setAdding(false);
      setDraft(emptyProduct);
      setAliases('');
      setCommon(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="acq-product-picker">
      <div className="acq-selected-products" aria-label="已选产品">
        {selected.length ? (
          selected.map((p) => (
            <span className="acq-product-tag" key={p.value}>
              <span>
                <small>{directionLabels[p.direction]}</small>
                {p.label}
              </span>
              <button
                type="button"
                disabled={disabled || saving}
                onClick={() => toggle(p)}
                aria-label={'移除产品 ' + p.label}
              >
                <X size={14} />
              </button>
            </span>
          ))
        ) : (
          <p className="muted">尚未选择产品</p>
        )}
      </div>
      <details className="acq-product-menu">
        <summary>
          <Search size={15} />
          选择产品 <span>{selected.length}/12</span>
          <ChevronDown size={14} />
        </summary>
        <div className="acq-product-browser">
          <label className="acq-search-field">
            <Search size={16} />
            <input
              aria-label="搜索产品"
              placeholder="搜索中文名、英文名或别名"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.preventDefault();
              }}
            />
          </label>
          <div className="acq-direction-tabs" aria-label="产品供货方向">
            {[['all', '全部'], ...Object.entries(directionLabels)].map(([value, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={direction === value}
                className={direction === value ? 'selected' : ''}
                onClick={() => setDirection(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="acq-product-options">
            {[...new Set(visible.map((p) => p.group))].map((group) => (
              <section key={group}>
                <h4>{group}</h4>
                {visible
                  .filter((p) => p.group === group)
                  .map((p) => {
                    const checked = selected.some(
                      (s) => s.value.toLowerCase() === p.value.toLowerCase(),
                    );
                    return (
                      <button
                        type="button"
                        className={checked ? 'selected' : ''}
                        aria-pressed={checked}
                        disabled={disabled || saving}
                        key={p.value}
                        onClick={() => toggle(p)}
                      >
                        <span className="acq-checkbox">{checked && <Check size={13} />}</span>
                        <span>
                          {p.label}
                          <small>{p.value}</small>
                        </span>
                      </button>
                    );
                  })}
              </section>
            ))}
            {!visible.length && <p className="muted">没有匹配的产品，可以添加新产品。</p>}
          </div>
        </div>
      </details>
      <button
        type="button"
        className="acq-text-button"
        disabled={disabled || saving}
        aria-expanded={adding}
        onClick={() => {
          setAdding(!adding);
          setError('');
        }}
      >
        <Plus size={15} />
        添加产品
      </button>
      {adding && (
        <div className="acq-new-product">
          <div className="acq-form-grid">
            <label>
              产品名称
              <input
                value={draft.label}
                maxLength={80}
                disabled={saving}
                placeholder="例如：窗饰展示箱"
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
              />
            </label>
            <label>
              产品英文名
              <input
                value={draft.value}
                maxLength={100}
                disabled={saving}
                placeholder="例如：blinds display cases"
                onChange={(e) => setDraft({ ...draft, value: e.target.value })}
              />
            </label>
            <label>
              供货方向
              <select
                value={draft.direction}
                disabled={saving}
                onChange={(e) =>
                  setDraft({ ...draft, direction: e.target.value as ProductSelection['direction'] })
                }
              >
                {Object.entries(directionLabels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              所属分组
              <input
                value={draft.group}
                maxLength={60}
                disabled={saving}
                onChange={(e) => setDraft({ ...draft, group: e.target.value })}
              />
            </label>
            <label className="acq-span-2">
              英文别名（选填）
              <input
                value={aliases}
                maxLength={500}
                disabled={saving}
                placeholder="不同叫法用逗号分隔，最多5个"
                onChange={(e) => setAliases(e.target.value)}
              />
            </label>
          </div>
          <label className="acq-check-label">
            <input
              type="checkbox"
              checked={common}
              disabled={saving}
              onChange={(e) => setCommon(e.target.checked)}
            />
            保存为常用产品，供后续任务选择
          </label>
          <button
            type="button"
            className="btn secondary"
            disabled={disabled || saving}
            onClick={() => void add()}
          >
            {saving ? '正在保存…' : common ? '保存并选用' : '用于本次任务'}
          </button>
        </div>
      )}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
