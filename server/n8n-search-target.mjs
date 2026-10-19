// Expression deployed to the existing Dify HTTP node. Credentials stay in n8n.
export const difyResearchBody = `={{ JSON.stringify({
  inputs: {
    target_json: JSON.stringify({
      country: $("配置搜索目标").first().json.country,
      region: $("配置搜索目标").first().json.region || null,
      city: $("配置搜索目标").first().json.city || null,
      product: $("配置搜索目标").first().json.product,
      customer_types: $("配置搜索目标").first().json.customer_types
    }),
    source_url: $json.source_url,
    page_text: $json.page_text
  },
  response_mode: "blocking",
  user: "n8n-acquisition"
}) }}`;
