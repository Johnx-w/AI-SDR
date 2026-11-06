import fs from 'node:fs/promises';
const count = Number(process.argv[2] || 1);
const base = 'http://127.0.0.1:4311/api/v1/acquisition';
const before = await fetch('http://127.0.0.1:4311/api/v1/leads/real').then(async (response) => {
  if (!response.ok) throw new Error('客户档案读取失败');
  return response.json();
});
await fs.writeFile(`artifacts/batch-live-${count}-before.json`, JSON.stringify(before));
const requestId = `batch-live-${count}-${Date.now()}`;
const response = await fetch(base + '/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId },
  body: JSON.stringify({
    country: 'United States',
    region: 'Florida',
    product: 'outdoor zip screens',
    acquisition_channel: 'tavily_web',
    search_query: 'outdoor zip screens Florida United States',
    target_count: count,
  }),
});
let job = await response.json();
if (!response.ok) throw new Error(JSON.stringify(job));
console.log(
  JSON.stringify({ id: job.id, status: job.status, target: job.target, before: before.total }),
);
await fs.writeFile(`artifacts/batch-live-${count}-job-id.txt`, job.id);
while (['running', 'stopping'].includes(job.status)) {
  await new Promise((r) => setTimeout(r, 5000));
  job = await (await fetch(base + '/jobs/' + job.id)).json();
  console.log(
    JSON.stringify({
      status: job.status,
      inserted: job.inserted,
      researched: job.researched,
      searches: job.searches,
      reason: job.reason,
      current: job.current?.domain,
    }),
  );
}
const after = await fetch('http://127.0.0.1:4311/api/v1/leads/real').then(async (response) => {
  if (!response.ok) throw new Error('客户档案读取失败');
  return response.json();
});
const previous = new Set(before.leads.map((l) => l.id));
const added = after.leads.filter((l) => !previous.has(l.id));
const verified = job.rows
  .filter((r) => r.result === 'inserted')
  .every((r) => added.some((l) => l.id === r.record_id));
const result = {
  job,
  before: before.total,
  after: after.total,
  added: added.map((l) => ({ id: l.id, name: l.name, website: l.website, fields: l.fields })),
  verified: verified && added.length === job.inserted,
};
await fs.writeFile(`artifacts/batch-live-${count}-verified.json`, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    status: job.status,
    inserted: job.inserted,
    delta: added.length,
    verified: result.verified,
    reason: job.reason,
  }),
);
if (job.status !== 'completed' || !result.verified) process.exitCode = 1;
