import { mentionsModel, parameterAnswer } from './model-parameters.mjs';
import {
  mentionsOtherSite,
  otherSitesInText,
  siteAllowsProduct,
} from '../src/domain/mail-site.mjs';

const attributes = [
  {
    query: /材质|成分|\b(?:material|composition|made (?:of|from))\b/iu,
    field: /材质|成分|material|composition/iu,
    en: 'Material',
  },
  {
    query: /尺寸|幅宽|宽度|\b(?:size|wide|width|dimensions?)\b/iu,
    field: /尺寸|幅宽|宽度|size|wide|width|dimension/iu,
    en: 'Dimensions',
  },
  {
    query: /规格|厚度|重量|遮光|specification|thickness|weight|blackout/iu,
    field: /规格|厚度|重量|specification|thickness|weight/iu,
    en: 'Specification',
  },
  { query: /颜色|colou?rs?/iu, field: /颜色|colou?r/iu, en: 'Colour' },
  {
    query: /用途|适用场景|suitable for|applications?|used for/iu,
    field: /用途|适用场景|application|usage/iu,
    en: 'Applications',
  },
  {
    query: /价格|报价|\b(?:price|prices|cost|quote|quotation)\b/iu,
    field: /^(?:参考)?价格$|^price$/iu,
    en: 'Reference price',
    commercial: true,
  },
  {
    query: /定金|订金|\bdeposit\b/iu,
    topic: '定金',
    field: /^内容$|^value$/iu,
    en: 'Deposit',
    commercial: true,
  },
  {
    query: /尾款|balance payment/iu,
    topic: '尾款',
    field: /^内容$|^value$/iu,
    en: 'Balance',
    commercial: true,
  },
];
const commercial =
  /付款|定金|折扣|报价|交期|价格|运费|合同|认证|投诉|\b(?:payment|deposit|discount|price|quote|shipping|lead time|guarantee|contract|certif\w*|complaint)\b/iu;
const needsReview = /待核对|核对事项|warning|unverified/iu;
export function requiresProductOrCommercialReview(text, mailbox) {
  return (
    mentionsOtherSite(text, mailbox) ||
    /\b(?:[a-z]+[-_]\d+|\d+[-_][a-z])[a-z0-9_-]*\b/iu.test(text) ||
    /\b(?:sku|model)\s*[:#-]?\s*[a-z\d_-]*\d|型号\s*[a-z\d_-]+/iu.test(text) ||
    commercial.test(text) ||
    attributes.some((a) => a.query.test(text))
  );
}
const normal = (s) => s.toLowerCase().replace(/\s+/gu, ' ').trim();
const escape = (s) => s.replace(/[.*+?^`{}()|[\]\\$]/gu, '\\$&');
function named(question, label) {
  const key = normal(label);
  if (!key || key.length < 2) return false;
  if (/^[a-z\d_-]+$/iu.test(key) && /\d/u.test(key)) return mentionsModel(question, key);
  return new RegExp(
    (/^[a-z0-9]/u.test(key) ? '(?<![a-z0-9])' : '') +
      escape(key) +
      (/[a-z0-9]$/u.test(key) ? '(?![a-z0-9])' : ''),
    'iu',
  ).test(question);
}
export function managerReply(zh, partial = false) {
  if (zh)
    return partial
      ? '其余问题我需要先和上级讨论，再给您答复。'
      : '感谢您的来信。这个问题我需要先和上级讨论，再给您答复。';
  return partial
    ? 'I’ll need to discuss the remaining details with my manager before I can confirm them.'
    : 'Thank you for your message. I’ll need to discuss your question with my manager before I can confirm an answer.';
}
const fallback = (zh, reason) => ({
  automatic: false,
  reason,
  sources: [],
  body: managerReply(zh),
});

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
const commonWords = new Set(
  'the to of is it on in at as be an and or for by we us do my me our you your their they them any if so he his she her what when where which who why how should could would does are can with from this that have will please tell about need thank thanks product model details 什么 怎么 如何 请问 可以 是否 产品 型号 我们 你们 需要 这个'.split(
    ' ',
  ),
);
function searchTerms(text, models) {
  const words = new Set();
  for (const { segment, isWordLike } of segmenter.segment(normal(text))) {
    if (
      !isWordLike ||
      segment.length < 2 ||
      commonWords.has(segment) ||
      models.some((m) => named(m, segment))
    )
      continue;
    const word = segment.replace(/(?<=[a-z]{3})s$/u, '');
    words.add(/^[a-z]+$/u.test(word) ? '(?<![a-z])' + escape(word) + 's?(?![a-z])' : escape(word));
    if (words.size === 80) break;
  }
  return words.size ? new RegExp([...words].join('|'), 'giu') : null;
}
function draftEvidence(hits, candidates) {
  const seen = new Set(),
    selected = [];
  let length = 0;
  let truncated = false;
  for (const { sources } of [...hits, ...candidates].sort((a, b) => b.score - a.score)) {
    for (const source of sources) {
      const key = JSON.stringify([
        source.productId,
        source.documentId,
        source.sheet,
        source.ref,
        source.value,
      ]);
      if (seen.has(key)) continue;
      if (selected.length >= 32) return { selected, truncated: true };
      if (length + source.value.length > 24000) {
        truncated = true;
        continue;
      }
      selected.push(source);
      seen.add(key);
      length += source.value.length;
    }
  }
  return { selected, truncated };
}

export function answerMailQuestion(
  knowledge,
  mailbox,
  input,
  now = Date.now(),
  { subject = '', forDraft = false, searchWords = [] } = {},
) {
  const question = String(input || '')
    .trim()
    .slice(0, 4000)
    .replace(/\s+/gu, ' ');
  const zh = /[\u3400-\u9fff]/u.test(question);
  const lookup = [subject.slice(0, 500), question].join(' ').trim();
  if (!question) return fallback(zh, '请输入客户问题');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
  const selected = knowledge.replyProducts(mailbox, day);
  const namedSites = otherSitesInText(lookup, mailbox);
  const products = namedSites.length
    ? selected.filter((p) => namedSites.some((website) => siteAllowsProduct(p, { website }, true)))
    : selected;
  if (namedSites.length && !products.length) return fallback(zh, '已选文件无法核实来信所指品牌');
  const structured = parameterAnswer(
    products,
    knowledge,
    question,
    lookup,
    zh,
    forDraft,
    searchWords,
  );
  if (structured && !structured.sources.length) return structured;
  const asks = attributes.filter((a) => a.query.test(question));
  const hits = [];
  const candidates = [];
  let hasWorkbook = false;
  const models = lookup.match(/\b[a-z]+(?:[-_]?[a-z]+)*[-_]?\d+[a-z0-9_-]*\b/giu) || [];
  const vocabulary = searchTerms([lookup, ...searchWords].join(' '), models);
  for (const product of products) {
    if (product.parameterSet) continue;
    const priorHits = hits.length;
    const documents = knowledge.documents
      .list(product.id)
      .filter((d) => d.parseMode !== 'model_parameters' && !d.referencePages);
    // Human-reviewed passages keep their source document and original locator.
    for (const fact of product.sourceFacts || []) {
      const doc = documents.find(
        (d) => d.id === fact.documentId && product.documentIds?.includes(d.id),
      );
      if (!doc) continue;
      const attributeMatch = asks.some((a) => a.field?.test(fact.text) || a.query.test(fact.text));
      const exact = models.filter((model) => named(fact.text, model));
      if (
        models.length &&
        !exact.length &&
        !models.some(
          (m) => named(product.name, m) && !/\b[a-z]+[-_]?\d+[a-z0-9_-]*\b/iu.test(fact.text),
        )
      )
        continue;
      const namedProduct = [product.name, ...(product.keywords || [])].some((k) =>
        named(lookup, k),
      );
      const overlap = vocabulary ? new Set(normal(fact.text).match(vocabulary)).size : 0;
      const source = {
        productId: product.id,
        version: product.version,
        documentId: doc.id,
        file: doc.name,
        ref: fact.location,
        value: fact.text,
      };
      if (!(attributeMatch && (exact.length || namedProduct || overlap >= 2)) && overlap < 2) {
        if (forDraft)
          candidates.push({
            score: -2 + (namedProduct || exact.length || overlap ? 1 : 0),
            sources: [source],
          });
        continue;
      }
      hits.push({
        label: exact.length ? exact.join(' / ') : product.name,
        score: exact.length ? Math.max(...exact.map((s) => s.length)) : Math.min(3, overlap),
        body: fact.text,
        automatic:
          models.length === 1 &&
          exact.length === 1 &&
          attributeMatch &&
          asks.length === 1 &&
          !commercial.test(question + ' ' + fact.text) &&
          (zh || !/[\u3400-\u9fff]/u.test(fact.text)),
        sources: [source],
      });
    }
    for (const doc of documents.filter(
      (d) => product.documentIds?.includes(d.id) && d.extraction?.sheets,
    )) {
      hasWorkbook = true;
      const topics = [...asks.filter((a) => a.topic).map((a) => a.topic), ...searchWords];
      const edits = (product.cellEdits || []).filter((edit) => edit.documentId === doc.id);
      const editedRows = edits.map((edit) => Number(edit.ref.match(/\d+$/u)[0]));
      const rows = knowledge.db
        .prepare(
          `SELECT sheet,row_number,data FROM product_workbook_rows WHERE document_id=?
        AND (instr(lower(?),lower(label))>0 OR EXISTS (SELECT 1 FROM json_each(?) WHERE instr(lower(label),lower(value))>0)
        OR row_number IN (SELECT value FROM json_each(?)))`,
        )
        .all(doc.id, lookup, JSON.stringify(topics), JSON.stringify(editedRows));
      for (const row of rows) {
        const cells = JSON.parse(row.data).map((cell) => {
          const edit = edits.find((e) => e.sheet === row.sheet && e.ref === cell.ref);
          return edit ? { ...cell, original: cell.value, value: edit.value } : cell;
        });
        const label = cells[0].value;
        const exact = named(lookup, label);
        const applicable = asks.filter((a) => exact || (a.topic && label.includes(a.topic)));
        const values = applicable.flatMap((a) => {
          const cell = cells.find((c) => a.field.test(c.field) && c.value);
          return cell ? [{ attr: a, cell }] : [];
        });
        if (exact) {
          for (const cell of cells.slice(1)) {
            if (
              !values.some((v) => v.cell === cell) &&
              !/来源|待核|核对|思路|备注|source|warning/iu.test(cell.field) &&
              named(question, cell.field)
            )
              values.push({
                attr: { en: cell.field, commercial: commercial.test(cell.field) },
                cell,
              });
          }
          if (!values.length) {
            const cell = cells.find((c) => /^(?:内容|原表条件|answer|value)$/iu.test(c.field));
            if (cell) values.push({ attr: { en: cell.field, commercial: true }, cell });
          }
        }
        const sourceFor = (c) => ({
          productId: product.id,
          version: product.version,
          documentId: doc.id,
          file: doc.name,
          sheet: row.sheet,
          ref: c.ref,
          field: c.field,
          value: c.value,
          original: c.original,
          item: label,
        });
        const topicRow =
          !models.length && searchWords.some((word) => normal(label).includes(normal(word)));
        if (forDraft && (exact || topicRow))
          candidates.push({
            score: -1,
            sources: cells
              .filter((c) => c.value && !/来源|待核|核对|思路|备注|source|warning/iu.test(c.field))
              .map(sourceFor),
          });
        if (!values.length) continue;
        const rowCommercial = values.some((v) => v.attr.commercial);
        const extra = rowCommercial
          ? cells.filter((c) => /^(?:单位|适用条件|unit|conditions?)$/iu.test(c.field))
          : [];
        const selected = [...values.map((v) => v.cell), ...extra];
        const sources = [cells[0], ...selected].map(sourceFor);
        const terms = extra.map((c) => c.value).join(' · ');
        const body =
          values.map(({ attr, cell }) => `${zh ? cell.field : attr.en}: ${cell.value}`).join('\n') +
          (terms ? '\n' + terms : '');
        hits.push({
          label,
          body,
          sources,
          score: exact ? normal(label).length : 1,
          automatic:
            !commercial.test(question) &&
            !rowCommercial &&
            values.length === asks.length &&
            !cells.some((c) => needsReview.test(c.field) && c.value) &&
            (zh || !/[\u3400-\u9fff]/u.test(body)),
        });
      }
    }
    if (
      hits.length === priorHits &&
      [product.name, product.englishName, ...(product.aliases || [])]
        .filter(Boolean)
        .some((name) => named(lookup, name))
    ) {
      const facts = (product.outreachFacts || []).filter(
        (f) => f.kind === 'product' && (!f.validUntil || Date.parse(f.validUntil) > now),
      );
      const text =
        facts.map((f) => [f.text, f.conditions].filter(Boolean).join(' ')).join('\n') ||
        product.specifications;
      if (text)
        hits.push({
          label: product.englishName || product.name,
          score: 0,
          automatic: false,
          body: text.slice(0, 6000),
          sources: [
            {
              productId: product.id,
              version: product.version,
              file: product.name,
              ref: '已审核产品参数',
              value: text.slice(0, 6000),
            },
          ],
        });
    }
  }
  if (structured) {
    const record = structured.sources[0];
    const conflicting = hits.some(
      (hit) =>
        mentionsModel(hit.label, record.item) &&
        !hit.sources.some((s) => s.field && normal(s.value) === normal(record.value)),
    );
    if (conflicting)
      return {
        ...fallback(zh, '已审核资料对该型号的参数有不同记录，请核对原件'),
        parameterQuery: true,
        ...(forDraft ? { draftSources: [] } : {}),
      };
    return structured;
  }
  const draft = {};
  if (forDraft) {
    const { selected, truncated } = draftEvidence(hits, candidates);
    draft.draftSources = selected;
    // Expanded searches must also invalidate a draft if an initially unseen source changes.
    if (
      truncated ||
      (hasWorkbook &&
        !hits.length &&
        !models.length &&
        (asks.length || /[?？]|请问|please (?:advise|confirm|provide)/iu.test(question)))
    )
      draft.searchVersions = products.map((p) => [p.id, p.version]);
  }
  if (!hits.length)
    return {
      ...fallback(
        zh,
        products.length ? '已选资料中没有与问题对应的已核实字段' : '此邮箱尚无可用的已审核资料',
      ),
      ...draft,
    };
  const score = Math.max(...hits.map((h) => h.score)),
    best = hits.filter((h) => h.score === score);
  const automatic =
    best.length === 1 &&
    best[0].automatic &&
    hits.every((h) => h.label === best[0].label) &&
    [...question.matchAll(/\b[a-z]+[-_]?\d+[a-z0-9_-]*\b/giu)].every((match) =>
      named(best[0].label, match[0]),
    ) &&
    (question.match(/[?？]/gu) || []).length <= 1;
  return {
    ...draft,
    automatic,
    reason: automatic ? '单一型号、已核实参数' : '请核对适用条件及客户问题后发送',
    body:
      (zh ? '您好，\n\n' : 'Hello,\n\n') +
      best
        .slice(0, 4)
        .map((hit) => hit.label + '\n' + hit.body)
        .join('\n\n'),
    sources: best.slice(0, 4).flatMap((hit) => hit.sources),
  };
}
