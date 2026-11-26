import { createContext, useContext, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronRight,
  FileSpreadsheet,
  Image as Picture,
  ImagePlus,
  Search,
  X,
} from 'lucide-react';
import data from './catalog.json';
import { sourceUrl, sendJson, materialsRequest, type Correction } from '../../services/materials';
import './catalog.css';
import { PriceAmount } from './PriceAmount';

const CanEdit = createContext(false);
const originals = data.products;
type Product = (typeof originals)[number];
type Category = (typeof data.categories)[number];
const assets = import.meta.glob('./images/*', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
const imageUrl = (name: string) => assets['./images/' + name] || name;
const categoryByName = new Map(data.categories.map((c) => [c.name, c]));
const labels: Record<string, string> = {
  'Semi-blackout': '半遮光',
  'Semi-Blackout': '半遮光',
  Blackout: '全遮光',
  '100%Polyster': '100% Polyester',
};
const display = (value: string) => labels[value] || value;
const suffix = (p: Product) => (p.unit ? 'USD / ' + p.unit : 'USD · 单位待确认');
const match = (p: Product, category: string, query: string) =>
  (!category || p.sheet === category) &&
  [p.model, p.sheet, ...p.fields.flat()]
    .join(' ')
    .toLowerCase()
    .includes(query.trim().toLowerCase());

function Specs({ p }: { p: Product }) {
  return (
    <dl className="pc-facts">
      {p.fields.length ? (
        p.fields.map(([name, value], i) => (
          <div key={i} className={value.length > 38 ? 'pc-wide' : ''}>
            <dt>{name}</dt>
            <dd>{display(value)}</dd>
          </div>
        ))
      ) : (
        <div>
          <dt>规格</dt>
          <dd>未提供</dd>
        </div>
      )}
    </dl>
  );
}

function Photo({
  file,
  label,
  open,
}: {
  file: string;
  label: string;
  open: (file: string, label: string) => void;
}) {
  return (
    <button
      type="button"
      className="pc-photo"
      aria-label={'查看 ' + label + ' 大图'}
      onClick={() => open(file, label)}
    >
      <img src={imageUrl(file)} loading="lazy" alt={label} />
    </button>
  );
}
function ProductPhotos({
  p,
  open,
  upload,
}: {
  p: Product;
  open: (file: string, label: string) => void;
  upload: (index: number, file: File) => void;
}) {
  const writable = useContext(CanEdit);
  const shared = categoryByName.get(p.sheet)!.shared.filter((s) => s.models.includes(p.id));
  return (
    <div className="pc-photos">
      {(p.photos.length ? p.photos : ['']).map((file, i) => (
        <div key={i}>
          {file ? (
            <Photo
              file={file}
              label={p.model + (p.photos.length > 1 ? ' ' + (i + 1) : '')}
              open={open}
            />
          ) : (
            !shared.length && (
              <div className="pc-no-photo">
                <Picture size={18} />
                <small>暂无配图</small>
              </div>
            )
          )}
          {writable && (
            <label className="pc-upload">
              <ImagePlus size={13} />
              {file ? '换图' : '添加配图'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label={(file ? '替换 ' : '添加 ') + p.model + ' 配图'}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload(i, f);
                  e.target.value = '';
                }}
              />
            </label>
          )}
        </div>
      ))}
      {shared.map((s, i) => (
        <div key={s.file + i} className="pc-shared">
          <Photo file={s.file} label={p.sheet + '共用参考图'} open={open} />
          <small>跨款参考图</small>
        </div>
      ))}
    </div>
  );
}
function Terms({ category }: { category: Category }) {
  return (
    <div className="pc-terms">
      <strong>报价条件</strong>
      <span>
        {category.terms
          .trim()
          .replace(/(?:^|[；;。\s]+)\d+[、)）]\s*/g, (_match, offset) => (offset ? '　·　' : ''))
          .replace(/[；;]+$/, '')}
      </span>
    </div>
  );
}

type PhotoRow = { sheet: string; item: string; slot: string; id: string; active: number };
export function PriceCatalog({
  product,
  doc,
  writable,
  edits,
  saveCell,
}: {
  product: string;
  doc: string;
  writable: boolean;
  edits: Correction[];
  saveCell: (sheet: string, ref: string, value: string, original: string) => Promise<boolean>;
}) {
  const path = '/' + product + '/document/' + doc + '/photos';
  const [assets, setAssets] = useState<PhotoRow[] | null>(null),
    [working, setWorking] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    const c = new AbortController();
    materialsRequest<PhotoRow[]>(path + '/catalog', { signal: c.signal })
      .then((rows) => {
        if (!c.signal.aborted) setAssets(rows);
      })
      .catch((e) => {
        if (!c.signal.aborted) setMsg(String(e));
      });
    return () => c.abort();
  }, [path]);
  const byModel = new Map<string, PhotoRow[]>();
  for (const a of assets || []) {
    const key = JSON.stringify([a.sheet, a.item]);
    if (!byModel.has(key)) byModel.set(key, []);
    byModel.get(key)!.push(a);
  }
  function photosFor(p: Product) {
    return byModel.get(JSON.stringify([p.binding.sheet, p.binding.item])) || [];
  }
  const keyedEdits = new Map(
    edits.filter((e) => e.documentId === doc).map((e) => [e.sheet + '!' + e.ref, e.value]),
  );
  const products = originals.map((p) => {
    const raw = keyedEdits.get(p.binding.sheet + '!' + p.binding.ref);
    const amounts = raw?.match(/(?:\d+(?:\.\d*)?|\.\d+)(?= USD)/g);
    const records = photosFor(p);
    const slots = new Map(p.photos.map((file, index) => [index ? '附图 ' + index : '主图', file]));
    for (const record of records) {
      if (record.active) slots.set(record.slot, sourceUrl(product, doc) + '/photos/' + record.id);
      else if (!records.some((a) => a.slot === record.slot && a.active)) slots.delete(record.slot);
    }
    return {
      ...p,
      photos: [...slots.values()],
      prices:
        raw === undefined
          ? p.prices
          : amounts
            ? amounts.map((v, i) => [p.prices[i]?.[0] || '单价', v])
            : [['已校对报价', raw]],
    };
  });
  const imageCount =
    products.reduce((n, p) => n + p.photos.length, 0) +
    data.categories.reduce((n, c) => n + c.shared.length, 0);
  const [filter, setFilter] = useState(''),
    [query, setQuery] = useState(''),
    [msg, setMsg] = useState('');
  useEffect(() => {
    if (!msg) return;
    const timer = window.setTimeout(() => setMsg(''), 3200);
    return () => window.clearTimeout(timer);
  }, [msg]);
  const [zoom, setZoom] = useState({ file: '', label: '' });
  const dialog = useRef<HTMLDialogElement>(null);
  const results = products.filter((p) => match(p, filter, query));
  function open(file: string, label: string) {
    setZoom({ file, label });
    dialog.current?.showModal();
  }
  function changeFilter(cat: string, q: string) {
    setFilter(cat);
    setQuery(q);
  }
  async function setPrice(p: Product, index: number, value: string) {
    if (!writable || lock.current) return;
    const bind = p.binding,
      prior = keyedEdits.get(bind.sheet + '!' + bind.ref) ?? bind.original;
    let n = 0;
    const replaced = prior.replace(/(?:\d+(?:\.\d*)?|\.\d+)(?= USD)/g, (old) =>
      n++ === index ? value : old,
    );
    if (prior && (!n || n !== p.prices.length)) {
      setMsg('该报价为自定义文本，请在资料校对中核对');
      return;
    }
    lock.current = true;
    setWorking(true);
    try {
      await saveCell(
        bind.sheet,
        bind.ref,
        prior ? replaced : '单价 ' + value + ' USD/' + (p.unit || '单位待确认'),
        bind.original,
      );
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  async function upload(p: Product, index: number, file: File) {
    if (!writable || lock.current || !assets) return;
    if (file.size > 6 * 1024 * 1024) {
      setMsg('请选择 6 MB 以内的图片');
      return;
    }
    const active = photosFor(p).filter((a) => a.active);
    const fallbackIndex = originals
      .find((original) => original.id === p.id)!
      .photos.indexOf(p.photos[index]);
    const photo = active.find((a) => p.photos[index]?.endsWith('/' + a.id));
    lock.current = true;
    setWorking(true);
    try {
      const encoded = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(Error('读取图片失败'));
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.readAsDataURL(file);
      });
      await sendJson(path, 'POST', {
        sheet: p.binding.sheet,
        item: p.binding.item,
        slot: photo?.slot || (fallbackIndex > 0 ? '附图 ' + fallbackIndex : '主图'),
        expectedId: photo?.id || null,
        contentBase64: encoded,
      });
      setAssets(await materialsRequest<PhotoRow[]>(path + '/catalog'));
      setMsg('配图已保存');
    } catch (e) {
      setMsg(String(e));
    } finally {
      lock.current = false;
      setWorking(false);
    }
  }
  return (
    <section className="pc" aria-label="价格表图文清单">
      <header className="pc-heading">
        <div className="pc-path">
          <BookOpen size={14} />
          素材库
          <ChevronRight size={13} />
          文件解析
        </div>
        <div className="pc-title">
          <h1>遮阳产品价格总表</h1>
          <span>
            <FileSpreadsheet size={14} /> XLS
          </span>
        </div>
        <div className="pc-metrics">
          <span>
            <b>{data.categories.length}</b> 个品类
          </span>
          <i />
          <span>
            <b>{products.length}</b> 条产品与配件
          </span>
          <i />
          <span>
            <b>{imageCount}</b> 处配图
          </span>
        </div>
      </header>
      <div className="pc-toolbar">
        <label className="pc-search">
          <Search size={16} />
          <input
            placeholder="搜索型号、面料或规格"
            aria-label="搜索型号或规格"
            value={query}
            onChange={(e) => changeFilter(filter, e.target.value)}
          />
        </label>
        <select
          aria-label="筛选品类"
          value={filter}
          onChange={(e) => changeFilter(e.target.value, query)}
        >
          <option value="">全部品类</option>
          {data.categories.map((c) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
        <span className="pc-session">
          {working ? '正在保存…' : writable ? '修改自动保存' : '只读'}
        </span>
      </div>
      {(filter || query) && (
        <div className="pc-result">
          {results.length} 条匹配记录<button onClick={() => changeFilter('', '')}>清除筛选</button>
        </div>
      )}
      {!results.length ? (
        <p className="pc-empty">没有匹配的产品或配件。</p>
      ) : (
        <CanEdit.Provider value={writable && !working && assets !== null}>
          <section aria-label="完整图文清单">
            {data.categories.map((category) => {
              const rows = results.filter((r) => r.sheet === category.name);
              if (!rows.length) return null;
              return (
                <section key={category.name} className="pc-group">
                  <header className="pc-group-head">
                    <h2>{category.name}</h2>
                    <span>{rows.length} 条</span>
                  </header>
                  <Terms category={category} />
                  <div className="pc-column-head">
                    <span>产品 / 配图</span>
                    <span>规格与说明</span>
                    <span>
                      配置报价 <small>点击金额改价</small>
                    </span>
                  </div>
                  {rows.map((p) => (
                    <article className="pc-record" key={p.id} aria-label={p.sheet + ' ' + p.model}>
                      <div className="pc-grid">
                        <div className="pc-identity">
                          <ProductPhotos
                            p={p}
                            open={open}
                            upload={(i, file) => upload(p, i, file)}
                          />
                          <div>
                            <h3>{p.model}</h3>
                          </div>
                        </div>
                        <Specs p={p} />
                        <div className="pc-quote">
                          <small>{suffix(p)}</small>
                          {(p.prices.length ? p.prices : [['单价', '']]).map(([name, value], i) => (
                            <label key={i}>
                              <span>{name}</span>
                              <PriceAmount
                                writable={writable && !working && assets !== null}
                                value={value}
                                label={p.model + ' ' + name + ' 价格'}
                                commit={(v) => setPrice(p, i, v)}
                                notify={setMsg}
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    </article>
                  ))}
                </section>
              );
            })}
          </section>
        </CanEdit.Provider>
      )}
      <div role="status" className="pc-status">
        {msg}
      </div>
      <dialog className="pc-dialog" ref={dialog} aria-label="产品大图">
        <header>
          <strong>{zoom.label}</strong>
          <button aria-label="关闭大图" onClick={() => dialog.current?.close()}>
            <X size={18} />
          </button>
        </header>
        {zoom.file && <img src={imageUrl(zoom.file)} alt={zoom.label + ' 大图'} />}
      </dialog>
    </section>
  );
}
