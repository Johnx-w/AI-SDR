const key = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s().（）_-]/gu, '');
const roles = {
  model:
    /^(型号或品名|型号|产品型号|货号|品名|产品名称|商品名称|产品编码|item|productname|sku|model(?:no|number|code)?|productioncode|productcode|itemname)$/u,
  price:
    /^(参考价格|对客参考价|报价|单价|价格|price|unitprice|referenceprice)(?:usd|cny|rmb|eur|gbp|[$¥€£])?$/u,
  topic: /^(主题|关键词|问题|项目|topic|keyword|question)$/u,
  answer: /^(内容|填写内容|答复|标准答复|答案|answer|response|content)$/u,
  source: /^(来源|出处|来源文件|source|reference)$/u,
  unit: /^(单位|计价单位|unit|uom)$/u,
  currency: /^(币种|currency)$/u,
  photo: /^(图片|产品图片|配图|photos?|pictures?|images?)$/u,
};
export function sheetLayout(values) {
  const headers = values.map((v) => String(v ?? '').trim());
  const fields = {};
  for (const [role, re] of Object.entries(roles)) {
    const matches = headers.filter((h) => re.test(key(h)));
    if (matches.length === 1) fields[role] = matches[0];
  }
  if (!fields.model) {
    const codes = headers.filter((h) =>
      /^(sku|model(?:no|number|code)?|产品型号|型号|货号|产品编码|productcode|productioncode)$/u.test(
        key(h),
      ),
    );
    if (codes.length === 1) fields.model = codes[0];
  }
  const mixed = headers.some(
    (h) => h !== fields.price && /price|cost|税价|成本|进价|阶梯价|采购价/u.test(key(h)),
  );
  const kind =
    fields.model && fields.price && !mixed
      ? 'quote'
      : fields.topic && fields.answer
        ? 'knowledge'
        : 'table';
  return { kind, headers, fields };
}
export function workbookHeader(data) {
  const first = data.findIndex((r) => r.some((v) => v != null && v !== ''));
  if (first < 0) return -1;
  if (data[first].filter((v) => v != null && v !== '').length > 1) return first;
  const second = data.findIndex((r, i) => i > first && r.some((v) => v != null && v !== ''));
  return second >= 0 && sheetLayout(data[second]).kind !== 'table' ? second : first;
}
export const layoutKey = (headers) => JSON.stringify(headers.map(String).filter(Boolean).sort());
