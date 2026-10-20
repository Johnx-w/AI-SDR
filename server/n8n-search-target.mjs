// Expressions deployed to the existing n8n nodes. Credentials stay in n8n.
export const searchTargetConfig = `={{ JSON.stringify({
  country: $json.body?.country ?? "United States",
  audience: ["B","C","BC"].includes($json.body?.audience) ? $json.body.audience : "BC",
  region: $json.body?.region ?? "",
  product: $json.body?.product ?? "outdoor zip screens",
  acquisition_channel: "tavily_web",
  customer_types: [],
  search_query: $json.body?.search_query ?? [
    $json.body?.product ?? "outdoor zip screens",
    $json.body?.region ?? "",
    $json.body?.country ?? "United States"
  ].filter(Boolean).join(" "),
  request_id: $json.body?.request_id ?? "manual"
}) }}`;

// Update only the selected task scope; customer location facts stay unchanged.
export function removeCityTarget(original) {
  const mapping = 'city:cfg.target_city || cfg.city || null,';
  if (!original.includes(mapping)) throw new Error('未找到预期的城市目标映射，请先核对入库节点');
  return original.replace(mapping, '');
}

export const difyResearchBody = `={{ JSON.stringify({
  inputs: {
    target_json: JSON.stringify({
      country: $("配置搜索目标").first().json.country,
      region: $("配置搜索目标").first().json.region || null,
      product: $("配置搜索目标").first().json.product,
      audience: $("配置搜索目标").first().json.audience || "BC",
      audience_policy: "BC 表示不限客群；B 与 C 按企业服务客群筛选，兼营者均符合。不得把企业误认为个人。",
      customer_types: [],
      customer_type_filter: false,
      customer_type_policy: "客户类型仅用于识别和归档，不作为匹配条件；未知客户类型不能单独导致不匹配或待核实。"
    }),
    source_url: $json.source_url,
    page_text: $json.page_text
  },
  response_mode: "blocking",
  user: "n8n-acquisition"
}) }}`;
