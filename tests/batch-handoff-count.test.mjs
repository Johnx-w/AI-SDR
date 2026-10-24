import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BatchJobs } from '../server/batch-jobs.mjs';
import { calculateHandoffReadiness } from '../server/handoff-readiness.mjs';

const target = {
  country: 'United States',
  region: 'Florida',
  product: 'roller blinds',
  audience: 'B',
  acquisition_channel: 'tavily_web',
  target_count: 1,
};
const ready = {
  policy: 'sales-handoff-v1',
  ready: true,
  reasons: [],
  identity_verified: true,
  opportunity_qualified: true,
  contact_verified: true,
  contacts: [
    {
      kind: 'email',
      value: 'sales@buyer.com',
      source_url: 'https://buyer.com/contact',
      quote: 'sales@buyer.com',
    },
  ],
};
const output = (assessment, handoff = ready, result = 'inserted') => ({
  新增: result === 'inserted' ? 1 : 0,
  更新: result === 'updated' ? 1 : 0,
  assessment,
  handoff,
  明细: [{ source_url: 'https://buyer.com/', result, record_id: 'rec-buyer' }],
});
function setup(result, extra = {}) {
  const leads = [];
  const manager = new BatchJobs({
    schedule: false,
    provider: 'native',
    discover: async () => ({ candidates: [{ source_url: 'https://buyer.com/' }] }),
    research: async () => {
      leads.push({ id: 'rec-buyer', website: 'https://buyer.com/', name: 'Buyer' });
      return result;
    },
    readLeads: async () => leads,
    status: async () => ({ settled: false }),
    ...extra,
  });
  return { manager, leads };
}
for (const [name, assessment, handoff] of [
  [
    '待补全且没有评级',
    { grade: null, score: 75, status: '待补全' },
    { ...ready, ready: false, opportunity_qualified: false },
  ],
  [
    'C级企业',
    { grade: 'C', score: 55, status: '暂缓开发' },
    { ...ready, ready: false, opportunity_qualified: false },
  ],
  [
    '没有有来源的公司联系入口',
    { grade: 'A', score: 80, status: '优先开发' },
    { ...ready, ready: false, contact_verified: false, contacts: [] },
  ],
])
  test(`新增入库${name}仍计入宽泛收录目标`, async () => {
    const { manager } = setup(output(assessment, handoff));
    try {
      const job = manager.create(
        target,
        'handoff-red-' + assessment.score + '-' + handoff.contact_verified,
      );
      job.limits.research = 1;
      manager.save(job);
      await manager.work(job.id);
      const saved = manager.get(job.id);
      assert.equal(saved.status, 'completed');
      assert.equal(saved.reason, 'target_reached');
      assert.equal(saved.inserted, 1, '真实新增入库仍保留');
      assert.equal(saved.inserted, 1);
    } finally {
      manager.close();
    }
  });

test('A类初评级与去重新增收录目标分开统计', async () => {
  const { manager } = setup(output({ grade: 'A', score: 80, status: '优先开发', complete: false }));
  try {
    const job = manager.create(target, 'handoff-ready-v-unknown');
    await manager.work(job.id);
    const saved = manager.get(job.id);
    assert.equal(saved.status, 'completed');
    assert.equal(saved.inserted, 1);
    assert.equal(saved.inserted, 1);
  } finally {
    manager.close();
  }
});

test('研究预算足够小批筛选但仍有绝对上限与输入校验', () => {
  const { manager } = setup({});
  try {
    assert.throws(
      () => manager.create({ ...target, research_budget: 0 }, 'bad-budget-zero'),
      /研究/,
    );
    assert.throws(
      () => manager.create({ ...target, research_budget: 1601 }, 'bad-budget-high'),
      /研究/,
    );
    const job = manager.create(target, 'handoff-budget-default');
    assert.equal(job.limits.research, 12);
  } finally {
    manager.close();
  }
});

test('跨任务重启后同一企业更新不重复计入新增目标', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'handoff-claim-'));
  const path = join(folder, 'jobs.sqlite');
  const records = [];
  let result = output({ grade: null, status: '待补全' }, { ...ready, ready: false });
  const open = () =>
    new BatchJobs({
      path,
      scope: 'table-one',
      provider: 'native',
      schedule: false,
      discover: async () => ({ candidates: [{ source_url: 'https://buyer.com/' }] }),
      research: async () => {
        if (!records.length)
          records.push({ id: 'rec-buyer', website: 'https://buyer.com/', name: 'Buyer' });
        return result;
      },
      readLeads: async () => records,
      status: async () => ({ settled: false }),
    });
  let manager = open();
  try {
    const first = manager.create({ ...target, research_budget: 1 }, 'pending-company-first');
    await manager.work(first.id);
    assert.equal(manager.get(first.id).inserted, 1);
    assert.equal(manager.get(first.id).inserted, 1);
    manager.close();
    manager = open();
    result = output({ grade: 'A', status: '优先开发' }, ready, 'updated');
    const second = manager.create({ ...target, research_budget: 1 }, 'pending-company-refresh');
    await manager.work(second.id);
    const claimed = manager.get(second.id);
    assert.equal(claimed.inserted, 0);
    assert.equal(claimed.inserted, 0);
    assert.equal(claimed.rows[0].inserted_new, false);
    assert.equal(claimed.rows[0].qualification_reason, 'already_in_lead_library');
    const third = manager.create({ ...target, research_budget: 1 }, 'pending-company-again');
    await manager.work(third.id);
    assert.equal(manager.get(third.id).inserted, 0);
    assert.equal(manager.get(third.id).rows[0].qualification_reason, 'already_in_lead_library');
  } finally {
    manager.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('刷新存量企业不占新增收录目标', async () => {
  const { manager, leads } = setup(output({ grade: 'A', status: '优先开发' }, ready, 'updated'), {
    research: async () => output({ grade: 'A', status: '优先开发' }, ready, 'updated'),
  });
  leads.push({ id: 'rec-buyer', website: 'https://buyer.com/', name: 'Existing Buyer' });
  try {
    const job = manager.create({ ...target, research_budget: 1 }, 'legacy-company-refresh');
    await manager.work(job.id);
    const saved = manager.get(job.id);
    assert.equal(saved.inserted, 0);
    assert.equal(saved.rows[0].qualification_reason, 'already_in_lead_library');
  } finally {
    manager.close();
  }
});

test('宽泛收录任务不创建销售交接资格认领', async () => {
  const { manager } = setup(output({ grade: 'C', status: '暂缓开发' }, { ...ready, ready: false }));
  try {
    const job = manager.create({ ...target, research_budget: 1 }, 'broad-capture-no-claim');
    await manager.work(job.id);
    const saved = manager.get(job.id);
    assert.equal(saved.inserted, 1);
    assert.equal(saved.inserted, 1);
    assert.equal(saved.rows[0].handoff.ready, false);
    assert.equal(saved.rows[0].qualification_reason, 'new_business_record');
    assert.throws(
      () => manager.retractQualification(job.id, saved.rows[0].operation_id, '不适用'),
      /认领/,
    );
  } finally {
    manager.close();
  }
});

test('双来源先各发现一次，海关与官网候选交替研究而不饿死官网', async () => {
  const events = [];
  const records = [];
  const manager = new BatchJobs({
    provider: 'native',
    schedule: false,
    discover: async (_input, search) => {
      events.push('discover:' + search.source_kind);
      return {
        candidates: [1, 2].map((n) => ({ source_url: `https://${search.source_kind}${n}.com/` })),
      };
    },
    research: async (_input, item) => {
      events.push('research:' + item.source_kind);
      records.push({ id: item.domain, website: item.source_url });
      return {
        新增: 1,
        handoff: { ...ready, ready: false },
        明细: [{ source_url: item.source_url, result: 'inserted', record_id: item.domain }],
      };
    },
    readLeads: async () => records,
  });
  try {
    const job = manager.create(
      {
        ...target,
        region: '',
        acquisition_channel: 'dual',
        product_scope: 'all',
        product: 'window coverings',
        query_mode: 'auto',
        research_budget: 4,
        target_count: 5,
      },
      'dual-fair-handoff',
    );
    await manager.work(job.id);
    assert.deepEqual(events.slice(0, 6), [
      'discover:customs',
      'discover:web',
      'research:customs',
      'research:web',
      'research:customs',
      'research:web',
    ]);
    assert.equal(manager.get(job.id).researched, 4);
  } finally {
    manager.close();
  }
});

const research = {
  ok: true,
  source_url: 'https://buyer.com/',
  company_name: 'Buyer LLC',
  entity_type: 'business',
  eligibility: { status: 'eligible' },
  required_match: 'unrestricted',
  checked_urls: ['https://buyer.com/'],
  company_identity: {
    name: 'Buyer LLC',
    status: 'website_name_only',
    evidence: [{ source_url: 'https://buyer.com/', quote: 'Buyer LLC supplies roller blinds.' }],
  },
};
const assessment = {
  grade: 'A',
  status: '优先开发',
  complete: false,
  dimensions: { P: { score: 40 }, R: { score: 25 }, D: { score: 10 }, V: { score: null } },
};
test('交接门槛从同官网原文提取联系证据，V未知可交接', () => {
  const handoff = calculateHandoffReadiness({
    research,
    assessment,
    researchPages: [
      {
        source_url: 'https://buyer.com/',
        text: 'Buyer LLC supplies roller blinds. Email: sales@buyer.com',
      },
    ],
  });
  assert.equal(handoff.ready, true);
  assert.equal(handoff.contacts[0].source_url, 'https://buyer.com/');
});
test('公司使用Gmail时不因后面的页脚建站署名误杀业务入口', () => {
  const text =
    'Buyer LLC supplies roller blinds. Contact our sales team: buyer.sales@gmail.com. Website designed by Design Agency.';
  const handoff = calculateHandoffReadiness({
    research,
    assessment,
    researchPages: [{ source_url: 'https://buyer.com/', text }],
  });
  assert.equal(handoff.ready, true);
  assert.equal(
    handoff.contacts.some((contact) => contact.value === 'buyer.sales@gmail.com'),
    true,
  );
});

test('交接门槛不信无来源联系人或缺失D的高总分', () => {
  assert.equal(
    calculateHandoffReadiness({
      research,
      assessment,
      contacts: [{ kind: 'email', value: 'sales@buyer.com' }],
    }).ready,
    false,
  );
  assert.equal(
    calculateHandoffReadiness({
      research,
      assessment: { ...assessment, dimensions: { ...assessment.dimensions, D: { score: null } } },
      researchPages: [{ source_url: 'https://buyer.com/', text: 'Email: sales@buyer.com' }],
    }).ready,
    false,
  );
});
