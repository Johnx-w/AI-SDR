import { websiteScope, planWebsitePages } from './website-metadata.mjs';
export function recoveryPlanCode(planNode, htmlNode, pageNode) {
  return (
    websiteScope.toString() +
    '\n' +
    planWebsitePages.toString() +
    `\nconst plans=$('${planNode}').all();const responses=$('${htmlNode}').all();const p=$('${pageNode}').first().json;const domain=websiteScope(p.source_url)?.domain;const known=new Set(plans.map(x=>x.json.url));const additional=responses.flatMap(x=>x.json.statusCode===200?planWebsitePages(p.source_url,x.json.body||x.json.html||''):[]).filter(u=>!known.has(u));const failed=plans.filter((x,i)=>responses[i]?.json.statusCode!==200).map(x=>x.json.url);const urls=[...new Set([...additional,...failed])].filter(u=>websiteScope(u)?.domain===domain).slice(0,5);return [{json:{fallback_urls:urls,needs_recovery:urls.length>0}}];`
  );
}
export const recoveryCondition = {
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
    conditions: [
      {
        id: 'needs-recovery',
        leftValue: '={{ $json.needs_recovery }}',
        rightValue: true,
        operator: { type: 'boolean', operation: 'true', singleValue: true },
      },
    ],
    combinator: 'and',
  },
  options: {},
};
export function recoveryExtractParameters(original) {
  return {
    ...original,
    jsonBody:
      '={{ JSON.stringify({urls:$json.fallback_urls,extract_depth:"advanced",format:"markdown",timeout:30}) }}',
    options: { response: { response: { neverError: true } }, timeout: 65000 },
  };
}
