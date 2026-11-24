import { createHash } from 'node:crypto';

export const parameterMode = 'model_parameters';
const fail = (message) => Object.assign(new Error(message), { status: 400 });
const clean = (s) => String(s ?? '').trim();
const norm = (s) => clean(s).toLowerCase();
const escape = (s) => s.replace(/[.*+?^$\x7b\x7d()|[\]\\]/gu, '\\$&');
export function mentionsModel(text, model) {
  const token = '[a-z0-9_\\-‐‑–]';
  return (
    !!model &&
    new RegExp('(?<!' + token + ')' + escape(model) + '(?!' + token + ')', 'iu').test(text)
  );
}
const meta =
  /来源|出处|备注|待核|核对|source|warning|notes?|别名|aliases?|配置|适用条件|conditions?|configuration|variant|^单位$|^unit$/iu;
const modelHeader =
  /^(?:产品型号|型号|货号|model(?:\s*(?:no\.?|number|code))?|sku|item\s*(?:no\.?|code))$/iu;
const dimensions = /宽|厚|长|直径|高度|重量|width|thickness|length|diameter|height|weight/iu;
const unit = /(?:毫米|厘米|英寸|千克|克|米|公斤|磅|mm|cm|kg|inches|inch|lbs?|ft|in|m|g)(?![a-z])/iu;
export const hasModelHeader = (name) => modelHeader.test(clean(name));
export function tableParameters(cells, location) {
  const first = cells[0],
    out = [];
  const read = (pattern) => cells.find((c) => pattern.test(c.field.trim()))?.value || '';
  const conditions = cells
    .filter((c) =>
      /^(?:配置|适用条件|条件|variant|configuration|conditions?)$/iu.test(c.field.trim()),
    )
    .map((c) => c.value)
    .join(' · ');
  for (const cell of cells.slice(1)) {
    if (meta.test(cell.field) || commerce.test(cell.field)) continue;
    const origin =
      cells.find((c) =>
        [cell.field + '来源', cell.field + '出处', cell.field + ' source'].some(
          (f) => norm(f) === norm(c.field),
        ),
      )?.value || read(/^(?:来源|出处|source)$/iu);
    out.push({
      item: first.value,
      field: cell.field,
      value: cell.value,
      conditions,
      ...location,
      ref: cell.ref,
      origin,
      aliases: read(/^(?:别名|aliases?)$/iu)
        .split(/[,，、;\n；]/u)
        .map(clean)
        .filter(Boolean),
      quote: first.value + ' · ' + cell.field + ' · ' + cell.value,
      issue: read(/待核|warning/iu) ? '原表标为待核对' : '',
    });
  }

  return out;
}
export function workbookParameters(rows) {
  return rows.flatMap(([sheet, , , json]) => {
    const cells = JSON.parse(json);
    if (!hasModelHeader(cells[0]?.field) || !/^A\d+$/u.test(cells[0].ref))
      throw fail('型号参数表每个工作表首列须为“型号”，每行填写型号。');
    return tableParameters(cells, { sheet });
  });
}
export function prepareParameters(items) {
  const grouped = new Map();
  for (const p of items) {
    if (!clean(p.item) || !clean(p.field) || !clean(p.value))
      throw fail('每个参数须包含型号、参数名和原值');
    if (dimensions.test(p.field) && /\d/u.test(p.value) && !unit.test(p.value))
      p.issue = '请在原值中补齐计量单位';
    const key = JSON.stringify([norm(p.item), norm(p.field), norm(p.conditions)]);
    const group = grouped.get(key) || [];
    group.push(p);
    grouped.set(key, group);
  }
  for (const group of grouped.values()) {
    if (group.length > 1) {
      const conflict = new Set(group.map((p) => norm(p.value))).size > 1;
      for (const p of group) p.issue ||= conflict ? '同型号、参数和配置的数值冲突' : '重复参数';
    }
  }
  const unique = new Map();
  for (const p of items) {
    const key = createHash('sha256').update(JSON.stringify(p)).digest('hex');
    unique.set(key, { ...p, key });
  }
  return [...unique.values()];
}
export function linkParameter(p, documents) {
  if (!p.origin) return p;
  const matches = documents.filter(
    (d) =>
      d.referencePages &&
      d.contentType === 'application/pdf' &&
      (p.origin === d.name ||
        p.origin.startsWith(d.name + '，') ||
        p.origin.startsWith(d.name + ',') ||
        p.origin.startsWith(d.name + ' ') ||
        p.origin.startsWith(d.name + ' ·')),
  );
  const page = /(?:第\s*(\d+)\s*页|\bp(?:age)?\.?\s*(\d+)\b)/iu.exec(p.origin);
  if (matches.length !== 1 || !page) return p;
  const number = Number(page[1] || page[2]);
  if (number < 1 || number > matches[0].referencePages) return p;
  return { ...p, upstream: { documentId: matches[0].id, file: matches[0].name, page: number } };
}

export function parameterClaimsMatch(body, sources) {
  const parameters = sources.filter((s) => s.parameter);
  if (!parameters.length) return true;
  const compact = (s) => s.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
  const measures = (s) =>
    (
      s
        .normalize('NFKC')
        .match(
          /(?<![a-z0-9])\d+(?:[.,]\d+)?\s*(?:(?:mm|cm|kg|lbs?|ft|inches|inch|in|m|g)\b|毫米|厘米|千克|公斤|英寸|米|克|%)/giu,
        ) || []
    ).map(compact);
  return parameters.every((p) => {
    const required = measures(p.value),
      actual = measures(body);
    const bodyModels =
      body.match(/\b(?:[a-z]+[-_]?\d+[a-z0-9_-]*|\d+[-_][a-z][a-z0-9_-]*)\b/giu) || [];
    if (
      bodyModels.some((m) => ![p.item, ...(p.aliases || [])].some((name) => norm(name) === norm(m)))
    )
      return false;
    const conditions = configurationWords.filter((re) => re.test(p.conditions || ''));
    if (!conditions.every((re) => re.test(body))) return false;
    return (
      mentionsModel(body, p.item) &&
      required.every((m) => actual.includes(m)) &&
      actual.every((m) => required.includes(m)) &&
      (!required.length || compact(body).includes(compact(p.value).replace(/[（(].*$/u, '')))
    );
  });
}
const configurationWords = [
  /标准款?|\bstandard\b/iu,
  /加厚款?|加强款?|reinforced|heavy[- ]duty/iu,
  /顶装|top[- ]mount|ceiling[- ]mount/iu,
  /侧装|side[- ]mount/iu,
];
const families = [
  [/宽|width|wide/iu, /宽|width|wide/iu],
  [/厚|thick/iu, /厚|thick/iu],
  [/材质|成分|material|made (?:of|from)|composition/iu, /材质|成分|material|composition/iu],
  [/颜色|colou?r/iu, /颜色|colou?r/iu],
  [/长度|多长|\blong\b|length/iu, /长|length/iu],
  [/直径|diameter/iu, /直径|diameter/iu],
  [/高度|多高|height|tall/iu, /高|height/iu],
  [/重量|多重|weight|weigh/iu, /重|weight/iu],
];
const qualifiers = [
  /叶片|slat|louv[er]+/iu,
  /成品|finished|overall/iu,
  /最大|maximum|\bmax\b/iu,
  /最小|minimum|\bmin\b/iu,
];
function pickFields(rows, question) {
  const namedFields = rows.filter((p) => norm(question).includes(norm(p.field)));
  const requested = families.filter(([ask]) => ask.test(question));
  const matching = rows.filter(
    (p) => requested.some(([, field]) => field.test(p.field)) || namedFields.includes(p),
  );
  const specific = qualifiers.filter((pattern) => pattern.test(question));
  return {
    requested,
    rows: specific.length
      ? matching.filter((p) => specific.every((q) => q.test(p.field)))
      : matching,
  };
}
const commerce =
  /报价|价格|定金|付款|库存|认证|交期|运费|price|quote|deposit|payment|stock|certif|lead time|shipping|warranty/iu;
export function parameterAnswer(
  products,
  knowledge,
  question,
  lookup,
  zh,
  forDraft,
  searchWords = [],
) {
  const sources = [];
  let requestedCount = 0,
    mentioned = false,
    configurationAmbiguous = false;
  for (const product of products) {
    if (!product.parameterSet) continue;
    const identifiers = lookup.replace(
      /\b\d+(?:[.,]\d+)?\s*(?:mm\b|cm\b|kg\b|inches\b|毫米|厘米|千克)/giu,
      ' ',
    );
    const matches = knowledge.documents.matchParameters(product.parameterSet, identifiers);
    if (!matches.length) continue;
    mentioned = true;
    const requestedConfigurations = configurationWords.filter((re) => re.test(lookup));
    const explicit = matches.filter(
      (p) => p.conditions && norm(lookup).includes(norm(p.conditions)),
    );
    const scoped = explicit.length
      ? explicit
      : requestedConfigurations.length
        ? matches.filter((p) => requestedConfigurations.every((re) => re.test(p.conditions || '')))
        : matches;
    const picked = pickFields(scoped, [lookup, ...searchWords].join(' '));
    requestedCount = Math.max(requestedCount, picked.requested.length);
    if (
      !explicit.length &&
      !requestedConfigurations.length &&
      new Set(matches.map((p) => norm(p.conditions))).size > 1
    )
      configurationAmbiguous = true;
    for (const p of picked.rows) {
      sources.push({
        ...p,
        productId: product.id,
        version: product.version,
        set: product.parameterSet,
        parameter: true,
      });
    }
  }
  if (!mentioned) return null;
  const keys = new Set(
    sources.map((s) =>
      JSON.stringify([norm(s.item), norm(s.field), norm(s.value), norm(s.conditions)]),
    ),
  );
  const ids = new Set(sources.map((s) => norm(s.item)));
  const otherModels =
    lookup.match(/\b(?:[a-z]+[-_]?\d+|\d+[-_][a-z0-9]+|\d+)[a-z0-9_-]*\b/giu) || [];
  const ambiguity =
    configurationAmbiguous ||
    keys.size !== 1 ||
    ids.size !== 1 ||
    requestedCount > 1 ||
    otherModels.some(
      (m) => !sources.some((s) => [s.item, ...(s.aliases || [])].some((a) => norm(a) === norm(m))),
    );
  const automatic =
    !!sources.length &&
    !ambiguity &&
    !commerce.test(lookup + ' ' + sources.map((s) => s.field).join(' ')) &&
    (question.match(/[?？]/gu) || []).length <= 1;
  const clarification = !!sources.length && ambiguity;
  const reason = !sources.length
    ? '该型号缺少已确认的对应参数'
    : clarification
      ? '需确认具体型号、规格字段或适用配置'
      : automatic
        ? '型号、参数和来源已核实'
        : '请核对商务条件后发送';
  const options = [...new Set(sources.map((s) => s.field))];
  const variants = [...new Set(sources.map((s) => s.conditions).filter(Boolean))];
  const choices = options.length > 1 ? options : variants.length > 1 ? variants : [];
  const en = {
    叶片宽度: 'slat width',
    成品最大宽度: 'maximum finished width',
    顶装: 'top mount',
    侧装: 'side mount',
    标准款: 'standard',
    加厚款: 'heavy duty',
  };
  const names = choices
    .map((v) => (zh ? v : en[v] || v))
    .filter((v) => zh || !/[\u3400-\u9fff]/u.test(v));
  const wording =
    names.length > 1
      ? zh
        ? '请确认您问的是' + names.join('还是') + '？'
        : 'Could you confirm whether you mean ' + names.join(' or ') + '?'
      : zh
        ? '请确认要查询的具体型号、规格或配置。'
        : 'Could you confirm the exact model, measurement or configuration you need?';
  const conflictingValues =
    ids.size === 1 &&
    options.length === 1 &&
    variants.length <= 1 &&
    new Set(sources.map((s) => norm(s.value))).size > 1;
  const body = clarification
    ? conflictingValues
      ? zh
        ? '这项规格需要进一步核实，我核对原件后回复您。'
        : 'I will check the specification against our records before confirming it.'
      : wording
    : sources.length
      ? [sources[0].item, sources[0].field, sources[0].value, sources[0].conditions]
          .filter(Boolean)
          .join(' · ')
      : zh
        ? '这项规格需要进一步核实。'
        : 'I will check this specification before confirming it.';
  return {
    automatic,
    reason,
    body,
    parameterQuery: true,
    ...(forDraft && !sources.length
      ? { searchVersions: products.map((p) => [p.id, p.version]) }
      : {}),
    ...(clarification ? { clarification: true } : {}),
    sources: ambiguity ? [] : sources.slice(0, 1),
    ...(forDraft ? { draftSources: ambiguity ? [] : sources.slice(0, 1) } : {}),
  };
}
