// A completed collection and structured conclusion are required to change memory.
export function exclusionDecision(operation, output) {
  const research = operation.research || output?.research;
  if (
    operation.state !== 'completed' ||
    !research ||
    !Array.isArray(operation.checked_urls) ||
    !operation.checked_urls.length ||
    !Array.isArray(operation.incomplete_urls) ||
    operation.incomplete_urls.length ||
    !(operation.collection_complete || operation.research_pages?.length) ||
    research.incomplete_reason ||
    operation.research_response?.status === 'incomplete' ||
    operation.research_response?.body?.status === 'incomplete'
  )
    return 'ignore';
  const prescreen =
    research.relevance?.relevant === false &&
    research.product_match === 'not_matched' &&
    research.review_required === false;
  if (
    prescreen &&
    ['rejected', 'failed'].includes(output?.outcome) &&
    typeof output.reason === 'string' &&
    output.reason.trim()
  )
    return 'exclude';
  if (research.relevance?.relevant === false && output?.outcome === 'review') return 'clear';
  const modelConclusion =
    research.stage === 'done' &&
    (operation.research_complete ||
      operation.research_response ||
      operation.research_usage?.cache_hits === 1);
  if (!modelConclusion) return 'ignore';
  const mismatch =
    research.entity_type === 'individual' ||
    ['product_match', 'country_match', 'customer_type_match', 'profile_match'].some(
      (field) => research[field] === 'not_matched',
    ) ||
    research.eligibility?.status === 'rejected';
  if (
    output?.outcome === 'rejected' &&
    mismatch &&
    typeof output.reason === 'string' &&
    output.reason.trim()
  )
    return 'exclude';
  if (['completed', 'review', 'no_new_candidates'].includes(output?.outcome)) return 'clear';
  return 'ignore';
}
