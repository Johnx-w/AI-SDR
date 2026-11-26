// Run from the repository after npm run build. No .env, credentials, network model or SMTP.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { OutreachService } from '../server/outreach-service.mjs';
import { createOutreachGenerator } from '../server/outreach-content.mjs';
import { generateFollowUp } from '../server/outreach-follow-ups.mjs';
import { saveSequencePolicy } from '../server/outreach-sequence-policy.mjs';

let port = Number(process.argv[2] || 14374);
const dir = mkdtempSync(join(tmpdir(), 'ai-sdr-template-demo-'));
const demoDist = join(dir, 'dist');
cpSync(new URL('../dist/', import.meta.url), demoDist, { recursive: true });
symlinkSync(new URL('../node_modules/', import.meta.url), join(dir, 'node_modules'), 'junction');
const modelEnv = {
  RESEARCH_MODEL_PROVIDER: 'openai_compatible',
  RESEARCH_MODEL_BASE_URL: 'https://offline.invalid/v1',
  RESEARCH_MODEL_API_KEY: 'fixture',
  RESEARCH_MODEL_MODEL: 'fixture',
};
const intro = 'Would a brief product overview be useful to your team?';
const offer = 'May I send our one-page roller blinds product card?';
const follow = 'Does your team source roller blinds from external suppliers?';
async function model(url, request) {
  assert.equal(String(url), 'https://offline.invalid/v1/chat/completions');
  const { messages } = JSON.parse(request.body);
  const data = JSON.parse(messages[1].content);
  if (data.mode) {
    const text =
      {
        email: '{{ai_opener}}\n\nAt {{brand}}, we supply {{product}}.\n\n{{ai_question}}',
        opener: '{{ai_opener}}',
        ps: 'P.S. {{ai_question}}',
        rewrite: data.selection.includes('{{') ? data.selection : 'Would a brief overview help?',
      }[data.mode] || '';
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              subject:
                data.first && ['email', 'subject'].includes(data.mode)
                  ? '{{product}} for {{company}}'
                  : '',
              text,
            }),
          },
        },
      ],
    });
  }
  const requirement = (data.closing_instruction ?? data.writingInstruction ?? '').trim();
  const explicitQuestion = requirement.split('\n').find((line) => /^[A-Za-z][^?\n]*\?$/.test(line));
  let question;
  if (!requirement) question = intro;
  else if (explicitQuestion) question = explicitQuestion;
  else if (requirement.includes('只问一个采购方式'))
    question =
      data.customer?.business === 'manufacturer'
        ? 'Do you ever source finished units for individual projects?'
        : follow;
  else if (requirement.includes('适用性问题'))
    question = 'Would a finished roller blind fit the installations you handle?';
  else if (requirement.includes('规格资料'))
    question = 'Would a product specification sheet be useful for your team?';
  else if (requirement.includes('外部采购')) question = follow;
  else if (requirement.includes('谁负责'))
    question = 'Who manages sourcing for roller blinds on your team?';
  else
    throw Object.assign(new Error('离线演示请填写一条英文问句。正式写作模型支持自然语言要求。'), {
      status: 422,
    });
  const observation =
    data.body_instruction?.split('\n').find((line) => /^[A-Z][^?\n]*\.$/.test(line)) ||
    (data.customer?.business === 'manufacturer'
      ? 'Your workshop assembles roller blinds as part of the window furnishings you make for customers.'
      : 'I noticed you offer roller blinds as part of the window furnishings available to your customers.');
  const draft = data.customer
    ? {
        subject: 'Roller blinds supply',
        body_text: [
          observation,
          'At ' +
            data.sender.brand +
            ', we supply roller blinds. I wanted to introduce our range in case your team reviews additional suppliers for this part of your business.',
          question,
        ].join('\n\n'),
        source_ids: [data.customer.evidence[0].id],
      }
    : { body_text: 'I wanted to follow up on my note about roller blinds. ' + question };
  for (const rule of data.personalization_rules || []) {
    draft[rule.key] =
      data.customer?.business === 'manufacturer'
        ? 'Your workshop assembles roller blinds.'
        : 'Your range includes roller blinds.';
  }
  return Response.json({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(draft) } }],
  });
}
const product = {
  id: 'roller',
  name: '卷帘',
  englishName: 'roller blinds',
  direction: 'finished',
  status: 'approved',
  version: 1,
  brands: ['Example Supply'],
  markets: [],
};
const box = {
  id: 'demo-box',
  brandName: 'Example Supply',
  website: 'https://supply.example',
  email: 'sales@supply.example',
  displayName: 'Alex',
  signature: 'Alex\nExample Supply',
  productIds: [product.id],
  priority: 1,
  configured: true,
  smtpStatus: 'connected',
  dailyLimit: 200,
  intervalSeconds: 30,
};
const leads = [];
function dealer(id) {
  const domain = id + '.example';
  const lead = {
    id,
    name: 'Dealer ' + id,
    website: 'https://' + domain,
    market: 'Australia',
    grade: 'B',
    status: '待开发',
    type: '经销商',
    email: 'info@' + domain,
    facts: [
      {
        field: 'entity_type',
        value: 'business',
        quote: 'We distribute window furnishings.',
        source_url: 'https://' + domain + '/about',
      },
      {
        field: 'products',
        value: 'roller blinds',
        quote: 'We distribute finished roller blinds.',
        source_url: 'https://' + domain + '/range',
      },
    ],
    contactEvidence: [
      {
        kind: 'email',
        value: 'info@' + domain,
        quote: 'Business enquiries: info@' + domain,
        source_url: 'https://' + domain + '/contact',
      },
    ],
  };
  leads.push(lead);
  return lead;
}
const transport = [];
let time = Date.parse('2026-11-24T04:00:00Z');
const service = new OutreachService({
  path: join(dir, 'outreach.sqlite'),
  now: () => time,
  tickMs: 3600000,
  mailboxes: {
    list: () => [box],
    get: (id) => (id === box.id ? box : null),
    readMailbox: async () => ({
      folders: [],
      hasMore: false,
      folderCoverage: { inbox: true, sent: true },
    }),
    send: async (id, mail, options) => {
      assert.equal(id, box.id);
      assert.ok(leads.some((l) => l.email === mail.to));
      await options?.beforeSend?.();
      transport.push(mail);
      return { accepted: [mail.to], rejected: [], messageId: mail.messageId };
    },
  },
  loadLeads: async () => leads,
  customers: () => leads,
  products: () => [product],
  getEnv: () => modelEnv,
  fetchImpl: model,
  generator: {
    ...createOutreachGenerator({ env: modelEnv, fetchImpl: model }),
    generateFollowUp: (input) => generateFollowUp({ ...input, fetchImpl: model }),
  },
});
const plans = [];
async function prepare(name, members, followUpEnabled) {
  const plan = service.saveCampaign({
    name,
    customerIds: members.map((l) => l.id),
    mailboxIds: [box.id],
    targetCount: members.length,
    continuous: false,
    includeExisting: true,
    intervalSeconds: 30,
    followUpEnabled,
    filters: { markets: ['Australia'], products: [product.id] },
    sendWindow: { start: '09:00', end: '17:00', timezone: 'Asia/Shanghai' },
  });
  service.prepare(plan.id);
  await service.preparing.get(plan.id);
  const rows = service.deliveries(plan.id);
  assert.equal(
    rows.filter((d) => d.status === 'draft').length,
    members.length,
    rows.map((d) => d.reason).join(', ') || service.campaign(plan.id).lastError,
  );
  plans.push(plan);
  return plan;
}
async function submit(plan) {
  service.activate(plan.id, plan.revision);
  for (let i = 0; i < plan.targetCount; i++) {
    await service.tick();
    time += 31000;
  }
  assert.equal(service.deliveries(plan.id, ['accepted']).length, plan.targetCount);
}
function revision(firstInstruction, steps) {
  const policy = service.followUps.policy();
  return saveSequencePolicy(service, { ...policy, firstInstruction, steps });
}
const dayThree = [{ day: 3, instruction: follow }];
function groups(batch) {
  // Seeded balanced assignment by company, with disjoint company pools for 07 and 08.
  const score = (l) =>
    createHash('sha256')
      .update('demo-20261124/' + l.id)
      .digest('hex');
  const pool = Array.from({ length: 4 }, (_, i) => dealer('co-' + batch + '-' + (i + 1))).sort(
    (a, b) => score(a).localeCompare(score(b)),
  );
  return [pool.slice(0, 2), pool.slice(2)];
}
const initialPolicy = service.followUps.policy();
const [a7, b7] = groups('07'),
  [a8, b8] = groups('08');
revision('', dayThree);
const control = await prepare('07 A · 原结尾', a7, false);
await submit(control);
revision(offer, dayThree);
const treatment = await prepare('07 B · 一页卷帘产品卡', b7, false);
await submit(treatment);
const onlyFirst = await prepare('08 A · 仅首封', a8, false);
await submit(onlyFirst);
const dayPlan = await prepare('08 B · 首封 + 第 3 天', b8, true);
await submit(dayPlan);
const rows = (id) => service.deliveries(id);
const first = rows(dayPlan.id)[0];
service.conversations.importDeliveries();
service.conversations.putMessage(box, {
  identity: 'example-buyer-reply',
  messageId: '<example-reply@buyer.example>',
  inReplyTo: first.messageId,
  references: [first.messageId],
  direction: 'inbound',
  from: first.to,
  to: box.email,
  subject: 'Re: ' + first.subject,
  bodyText: 'Yes, please send the roller blinds product card.',
  classification: 'normal',
  source: 'imap',
  deliveryStatus: 'received',
  occurredAt: new Date(time).toISOString(),
});
const advance = async (days) => {
  time += days * 86400000;
  await service.tick();
};
await advance(3);
const actions = (id) => service.followUps.all().filter((row) => row.campaignId === id);
assert.deepEqual(
  actions(dayPlan.id)
    .map((t) => t.status)
    .sort(),
  ['accepted', 'cancelled'],
);
assert.ok(
  actions(dayPlan.id)
    .find((t) => t.status === 'accepted')
    .bodyText.includes(follow),
);
assert.equal(actions(onlyFirst.id).length, 0);
assert.equal(transport.length, 9);
assert.equal(new Set(transport.filter((m) => !m.inReplyTo).map((m) => m.to)).size, 8);
const body = (d) => d.bodyText.split('\n\n').slice(1).join('\n\n');
assert.equal(body(rows(control.id)[0]).replace(intro, offer), body(rows(treatment.id)[0]));
assert.equal(
  rows(dayPlan.id)[0].firstTemplateRevision,
  rows(onlyFirst.id)[0].firstTemplateRevision,
);
const eligible = await service.candidates(service.campaign(control.id));
assert.equal(eligible.eligible.length, 0);
console.log(
  '07 A/B 2/2 first touches; 08 A/B 2/2 first touches, 0/1 follow-up, 1 reply stopped; duplicate eligible=0.',
);

// Leave the editor on the workspace schedule after seeding the completed comparisons.
revision(initialPolicy.firstInstruction, initialPolicy.steps);

if (process.env.SEQUENCE_SCROLL_PROTOTYPE) {
  saveSequencePolicy(service, {
    ...service.followUps.policy(),
    firstTemplate: {
      subject: '{{product}} supply for {{company}}',
      body: [
        '{{ai_opener}}',
        'At {{brand}}, we supply {{product}}. I wanted to introduce our business in connection with the products your team already works with.',
        'I appreciate that every business has its own way of selecting products and working with suppliers. A useful first conversation would start with how this category fits into your current range.',
        'For a team that assembles its own products, the conversation may be about the parts it uses. For a team that supplies finished blinds, the starting point may be a different part of the range.',
        'That distinction would help us keep a later introduction relevant to your business. It would also give your team a clear starting point for deciding whether to continue the conversation.',
        'We can keep that first exchange brief and focus on one product category at a time. Your reply can simply describe how your team usually handles roller blinds.',
        'If another colleague handles this area, you are welcome to pass this note along. I would be glad to continue with the person who is familiar with this part of your business.',
        'Would a short introduction to our roller blinds be useful to your team?',
      ].join('\n\n'),
    },
  });
}

const appEnv = {
  PORT: String(port),
  CONNECTIONS_PATH: join(dir, 'connections.json'),
  BRANDING_CACHE_PATH: join(dir, 'branding'),
};
const app = createApp({
  dist: demoDist,
  env: appEnv,
  fetchImpl: async () => {
    throw new Error('offline demo');
  },
  localMailInspection: { sync: async () => [] },
  outreachServiceFactory: () => service,
});
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const html = (title, content) =>
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
  title +
  '</title><style>body{max-width:58rem;margin:2rem auto;padding:0 1rem;color:#252738;font:16px/1.6 system-ui,sans-serif}a{color:#484ba6}section,details{border-top:1px solid #dedee5;padding:.6rem 0}p{margin:.45rem 0}pre{white-space:pre-wrap;font:inherit}button{background:#5357ad;color:white;border:0;border-radius:6px;padding:.6rem 1rem;font:inherit;cursor:pointer}</style><h1>' +
  title +
  '</h1>' +
  content +
  '</html>';
const templates =
  '/inbox?tab=sequences' + (process.env.SEQUENCE_SCROLL_PROTOTYPE ? '&variant=scroll' : '');
function summary(plan) {
  const followups = actions(plan.id);
  return (
    '<section><h3>' +
    esc(plan.name) +
    '</h3><a href="' +
    '/inbox?tab=campaigns&campaignTab=followups&campaignId=' +
    plan.id +
    '">查看沟通中心执行记录</a>' +
    rows(plan.id)
      .map((d) => {
        const tasks = followups.filter((t) => t.firstId === d.id);
        return (
          '<details><summary>' +
          esc(d.companyName) +
          ' · 首封 v' +
          d.firstTemplateRevision +
          ' · ' +
          esc(d.status) +
          '</summary><pre>' +
          esc(d.subject + '\n\n' + d.bodyText) +
          '</pre>' +
          tasks
            .map(
              (t) =>
                '<h4>第 ' +
                t.day +
                ' 天 · ' +
                esc(t.status) +
                '</h4><pre>' +
                esc(t.bodyText || t.reason || t.dueAt) +
                '</pre>',
            )
            .join('') +
          '</details>'
        );
      })
      .join('') +
    '</section>'
  );
}
let serial = 0,
  busy = false;
function report() {
  return html(
    '开发信对照演示',
    '<p>本机合成企业 · 模拟时钟 · 离线写作与发信通道</p><p><a href="' +
      templates +
      '">打开沟通中心 → 跟进序列</a>　<a href="/demo/card">查看演示产品卡</a></p><p>保存模板后可在这里用一家新企业重演。离线模型支持以英文陈述句试写首段、以英文问句试写结尾和跟进，例如 <em>May I send the roller blinds product card?</em>。正式模型可读取自然语言写作要求。</p><form method="post" action="/demo/run"><button>用已保存模板生成并模拟发送</button></form><p>重演先生成首封，再按已保存的步骤推进模拟日期。展开企业可看生成正文及实际跟进结果。</p>' +
      plans.toReversed().map(summary).join(''),
  );
}
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (req.headers.host !== '127.0.0.1:' + port) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (path === '/demo/followups' && req.method === 'GET') {
      res
        .writeHead(302, {
          Location: '/inbox?tab=campaigns&campaignTab=followups&campaignId=' + dayPlan.id,
        })
        .end();
      return;
    }
    if (path === '/demo' && req.method === 'GET') {
      res.writeHead(302, { Location: templates }).end();
      return;
    }
    if (path === '/demo/run' && req.method === 'POST') {
      if (req.headers.origin !== 'http://127.0.0.1:' + port || busy) {
        res.writeHead(409).end();
        return;
      }
      busy = true;
      try {
        // Start each independent rehearsal at noon Beijing time on a fresh simulated day.
        time = (Math.floor(time / 86400000) + 1) * 86400000 + 4 * 3600000;
        const idx = ++serial;
        const plan = await prepare('模板试演 ' + idx, [dealer('practice-' + idx)], true);
        await submit(plan);
        const tasks = actions(plan.id).sort((a, b) => a.day - b.day);
        for (const task of tasks) {
          time = Math.max(time, Date.parse(task.dueAt));
          await service.tick();
        }
      } finally {
        busy = false;
      }
      res.writeHead(303, { Location: '/demo/records' }).end();
      return;
    }
    if (req.method === 'GET' && ['/demo/records', '/demo/card'].includes(path)) {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        .end(
          path === '/demo/records'
            ? report()
            : html(
                'Roller blinds · Product card',
                '<h2>' +
                  esc(box.brandName) +
                  '</h2><p>Product: ' +
                  esc(product.englishName) +
                  '</p><p>Supply form: finished window furnishings</p><p>Demo product record: ' +
                  esc(product.id) +
                  ' · approved v' +
                  product.version +
                  '</p><a href="/demo/records">返回试验记录</a>',
              ),
        );
      return;
    }
    if (
      !['GET', 'HEAD'].includes(req.method) &&
      !(
        /^\/api\/v1\/outreach\/campaigns\/[\w-]+\/follow-ups$/.test(path) && req.method === 'POST'
      ) &&
      ![
        '/api/v1/outreach/sequence-policy',
        '/api/v1/outreach/sequence-policy/preview',
        '/api/v1/outreach/sequence-policy/assist',
      ].includes(path)
    ) {
      res.writeHead(403).end('Local template demo');
      return;
    }
    app.emit('request', req, res);
  } catch (error) {
    res.writeHead(422, { 'content-type': 'text/plain; charset=utf-8' }).end(error.message);
  }
});
server.listen(port, '127.0.0.1', () => {
  port = server.address().port;
  appEnv.PORT = String(port);
  console.log('http://127.0.0.1:' + port + templates, dir);
});
