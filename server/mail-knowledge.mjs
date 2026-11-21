import { siteAllowsProduct, mentionsOtherSite } from '../src/domain/mail-site.mjs';

const attributes = [
  {
    query: /材质|成分|\b(?:material|composition|made (?:of|from))\b/iu,
    field: /材质|成分|material|composition/iu,
    en: 'Material',
  },
  {
    query: /尺寸|幅宽|宽度|\b(?:size|width|dimensions?)\b/iu,
    field: /尺寸|幅宽|宽度|size|width|dimension/iu,
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
const normal = (s) => s.toLowerCase().replace(/\s+/gu, ' ').trim();
const escape = (s) => s.replace(/[.*+?^`{}()|[\]\\$]/gu, '\\$&');
function named(question, label) {
  const key = normal(label);
  if (!key || key.length < 2) return false;
  return new RegExp(
    (/^[a-z0-9]/u.test(key) ? '(?<![a-z0-9])' : '') +
      escape(key) +
      (/[a-z0-9]$/u.test(key) ? '(?![a-z0-9])' : ''),
    'iu',
  ).test(question);
}
const fallback = (zh, reason) => ({
  automatic: false,
  reason,
  sources: [],
  body: zh
    ? '您好，感谢来信。请问您需要确认哪个型号及哪项规格？'
    : 'Thank you for your message. Could you confirm the model and the detail you need?',
});

export function answerMailQuestion(knowledge, mailbox, input, now = Date.now()) {
  const question = String(input || '')
    .trim()
    .slice(0, 4000)
    .replace(/\s+/gu, ' ');
  const zh = /[\u3400-\u9fff]/u.test(question);
  if (!question || mentionsOtherSite(question, mailbox))
    return fallback(zh, '问题超出当前官网资料范围');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
  const products = (mailbox.knowledgeProductIds || [])
    .map((id) => knowledge.get(id))
    .filter(
      (product) =>
        product?.status === 'approved' &&
        (!product.effectiveDate || product.effectiveDate <= day) &&
        siteAllowsProduct(product, mailbox, true),
    );
  const asks = attributes.filter((a) => a.query.test(question));
  const hits = [];
  for (const product of products) {
    const documents = knowledge.documents.list(product.id);
    for (const doc of documents.filter(
      (d) => product.documentIds?.includes(d.id) && d.extraction?.sheets,
    )) {
      const topics = asks.filter((a) => a.topic).map((a) => a.topic);
      const edits = (product.cellEdits || []).filter((edit) => edit.documentId === doc.id);
      const editedRows = edits.map((edit) => Number(edit.ref.match(/\d+$/u)[0]));
      const rows = knowledge.db
        .prepare(
          `SELECT sheet,row_number,data FROM product_workbook_rows WHERE document_id=?
        AND (instr(lower(?),lower(label))>0 OR EXISTS (SELECT 1 FROM json_each(?) WHERE instr(label,value)>0)
        OR row_number IN (SELECT value FROM json_each(?)))`,
        )
        .all(doc.id, question, JSON.stringify(topics), JSON.stringify(editedRows));
      for (const row of rows) {
        const cells = JSON.parse(row.data).map((cell) => {
          const edit = edits.find((e) => e.sheet === row.sheet && e.ref === cell.ref);
          return edit ? { ...cell, original: cell.value, value: edit.value } : cell;
        });
        const label = cells[0].value;
        const exact = named(question, label);
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
        if (!values.length) continue;
        const rowCommercial = values.some((v) => v.attr.commercial);
        const extra = rowCommercial
          ? cells.filter((c) => /^(?:单位|适用条件|unit|conditions?)$/iu.test(c.field))
          : [];
        const selected = [...values.map((v) => v.cell), ...extra];
        const sources = [cells[0], ...selected].map((c) => ({
          productId: product.id,
          version: product.version,
          documentId: doc.id,
          file: doc.name,
          sheet: row.sheet,
          ref: c.ref,
          field: c.field,
          value: c.value,
          original: c.original,
        }));
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
      !hits.length &&
      [product.name, product.englishName, ...(product.aliases || [])]
        .filter(Boolean)
        .some((name) => named(question, name))
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
  if (!hits.length)
    return fallback(
      zh,
      products.length ? '已选资料中没有与问题对应的已核实字段' : '此邮箱尚无可用的已审核资料',
    );
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
