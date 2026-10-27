// Presentation overlays leave the upstream customer facts and their replica intact.
export function decorateLeadDevelopment(snapshot, contexts) {
  const controls = new Map(
    contexts
      .filter((row) => row.development?.version)
      .map((row) => [row.customerId, row.development]),
  );
  const decorate = (lead) => {
    const control = controls.get(lead.id);
    if (!control) return lead;
    return {
      ...lead,
      status: control.paused ? '暂缓开发' : lead.status,
      ...(lead.version ? { version: `${lead.version}:development:${control.version}` } : {}),
    };
  };
  if (snapshot.leads) return { ...snapshot, leads: snapshot.leads.map(decorate) };
  if (snapshot.lead) {
    const control = controls.get(snapshot.lead.id);
    return {
      ...snapshot,
      lead: decorate(snapshot.lead),
      ...(control && snapshot.version
        ? { version: `${snapshot.version}:development:${control.version}` }
        : {}),
    };
  }
  return snapshot;
}
