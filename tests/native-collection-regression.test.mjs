import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAcquisition } from '../server/native-acquisition.mjs';
import { AcquisitionStore } from '../server/acquisition-store.mjs';

const site = 'https://blinds.example.org/';
const text = 'Example Blinds supplies zip screens and roller blinds to trade customers.';
const input = { country: 'United States', product: 'zip screens', audience: 'BC' };
const selectShell = `Custom Blinds, Shades & Curtains for Every Window | SelectBlinds
Skip to content
Over 18 million windows covered!
Get free samples!
Your order has been edited successfully
Loading
Return to ticket
Loading
Cancel
Add discount
Add discount
Edit
Remove original order discount
The replacement order will be charged at full price. Leave unchecked to carry over the original discount.
Loading
Complete order editing
Success
Your request completed successfully
Loading
Close
Loading
Start editing
Loading
Cancel`;

function fixture({ html = selectShell, readPage, extract, modelData } = {}) {
  const calls = { reads: [], extracts: [], models: [], writes: 0 };
  const store = new AcquisitionStore(':memory:', 'collection-regression');
  const service = new NativeAcquisition({
    env: {
      TAVILY_API_KEY: 'fixture-search',
      DEEPSEEK_API_KEY: 'fixture-model',
      FEISHU_APP_ID: 'fixture-app',
      FEISHU_APP_SECRET: 'fixture-secret',
      FEISHU_APP_TOKEN: 'fixture-table',
      FEISHU_TABLE_ID: 'fixture-id',
    },
    store,
    readPage: async (url) => {
      calls.reads.push(url.href);
      return readPage ? readPage(url) : { html };
    },
    providers: {
      web: {
        extract: async (body) => {
          calls.extracts.push(body);
          return extract ? extract(body) : assert.fail('Unexpected extract');
        },
      },
      model: {
        research: async (request) => {
          calls.models.push(request);
          return modelData
            ? {
                status: 'completed',
                output: [{ content: [{ type: 'output_text', text: JSON.stringify(modelData) }] }],
              }
            : { status: 'incomplete', output: [] };
        },
      },
    },
    feishu: {
      records: async () => [],
      write: async () => {
        calls.writes++;
        assert.fail('No write permitted');
      },
    },
    fetchImpl: async () => assert.fail('No external request permitted'),
  });
  return { service, calls, store };
}

for (const [name, html] of [
  ['历史 SelectBlinds 订单加载空壳', selectShell],
  ['历史 Inpro HTML 注释残片', '-->\n -->'],
  ['只有脚本启用提示', '<div>You need to enable JavaScript to run this app.</div>'],
  [
    'noscript 提示',
    '<title>Example Blinds</title><noscript>You need to enable JavaScript to run this app.</noscript>',
  ],
  ['访问挑战提示', '<title>Example Blinds</title><p>Access denied</p>'],
  [
    '品牌标题加脚本启用提示',
    '<title>Example Blinds</title><p>You need to enable JavaScript to run this app.</p>',
  ],
  [
    '挑战占位',
    '<title>Just a moment...</title><p>Checking your browser before accessing the site.</p>',
  ],
]) {
  test(`HTTP 200 ${name}触发 basic 补采并替换同网址正文`, async () => {
    const f = fixture({
      html,
      extract: async (body) => ({
        results: [{ url: body.urls[0], raw_content: text }],
        usage: { credits: 0.5 },
      }),
    });
    try {
      const result = await f.service.collect(site);
      assert.deepEqual(
        f.calls.extracts.map((body) => body.extract_depth),
        ['basic'],
      );
      assert.deepEqual(result.research_pages, [{ source_url: site, text }]);
      assert.deepEqual(result.web_usage, { web_extract_calls: 1, web_extract_credits: 0.5 });
    } finally {
      f.service.close();
    }
  });
}

for (const failure of ['throw', 'empty', 'failed', 'shell']) {
  test(`basic ${failure} 后只升级一次 advanced，成功后不再重试`, async () => {
    const f = fixture({
      extract: async ({ extract_depth }) => {
        if (extract_depth === 'advanced')
          return { results: [{ url: site, raw_content: text }], usage: { credits: 1 } };
        if (failure === 'throw') throw new Error('fixture extract failure');
        return {
          results: failure === 'shell' ? [{ url: site, raw_content: selectShell }] : [],
          ...(failure === 'failed' ? { failed_results: [{ url: site, error: 'Blocked' }] } : {}),
          usage: { credits: 0.5 },
        };
      },
    });
    try {
      const result = await f.service.collect(site);
      assert.deepEqual(
        f.calls.extracts.map((body) => body.extract_depth),
        ['basic', 'advanced'],
      );
      assert.deepEqual(result.research_pages, [{ source_url: site, text }]);
      assert.equal(result.web_usage.web_extract_calls, 2);
      assert.equal(result.web_usage.web_extract_credits, failure === 'throw' ? undefined : 1.5);
    } finally {
      f.service.close();
    }
  });
}

test('真实短页面、完整但无关正文及少量 Loading 控件不触发补采', async () => {
  for (const html of [
    '<p>Contact us.</p>',
    '<p>Loading</p><p>We sell camping tents and outdoor cooking equipment.</p>',
    '<p>Loading</p><p>' + text + '</p>',
    '<p>Our company supplies loading equipment for warehouses.</p>',
    '<p>Enable JavaScript to continue. We sell camping tents and outdoor cooking equipment.</p>',
    '<noscript>Please enable JavaScript.</noscript><p>We sell camping tents.</p>',
    '<noscript>Please enable JavaScript.</noscript><h1>Example Blinds</h1><p>We supply roller blinds and zip screens across North America</p>',
    '<h1>Example Blinds</h1><ul><li>Roller Blinds</li><li>Zip Screens</li></ul><noscript>Please enable JavaScript.</noscript>',
    '<div>Loading</div><div>Loading</div><div>Cancel</div><div>Close</div><div>Edit</div><p>We supply roller blinds and zip screens across North America</p>',
    selectShell + '\n' + text,
  ]) {
    const f = fixture({ html });
    try {
      const result = await f.service.collect(site);
      assert.equal(result.research_pages.length, 1);
      assert.deepEqual(f.calls.extracts, []);
    } finally {
      f.service.close();
    }
  }
});

test('提供方 raw_content 无正文时使用同网址有效 content，不再升级提取', async () => {
  for (const raw_content of ['', 'Loading...']) {
    const f = fixture({
      html: 'Loading...',
      extract: async () => ({ results: [{ url: site, raw_content, content: text }] }),
    });
    try {
      const result = await f.service.collect(site);
      assert.deepEqual(result.research_pages, [{ source_url: site, text }]);
      assert.equal(f.calls.extracts.length, 1);
    } finally {
      f.service.close();
    }
  }
});

test('混合成功失败只对仍未取得正文的网址升级，不重复抓取成功页面', async () => {
  const f = fixture({
    readPage: async (url) => ({
      html:
        url.pathname === '/'
          ? '<p>' + text + '</p><a href="/about">About</a><a href="/contact">Contact</a>'
          : '<p>Loading...</p>',
    }),
    extract: async ({ extract_depth }) => ({
      results: [
        {
          url: site + (extract_depth === 'basic' ? 'about' : 'contact'),
          raw_content: extract_depth === 'basic' ? 'We are Example Blinds.' : 'Contact our team.',
        },
      ],
      usage: { credits: 0.5 },
    }),
  });
  try {
    const result = await f.service.collect(site);
    assert.deepEqual(f.calls.extracts, [
      { urls: [site + 'contact', site + 'about'], extract_depth: 'basic', format: 'markdown' },
      { urls: [site + 'contact'], extract_depth: 'advanced', format: 'markdown' },
    ]);
    assert.equal(result.research_pages.length, 3);
    assert.ok(result.research_pages.every((page) => !page.text.includes('Loading')));
    assert.equal(new Set(f.calls.reads).size, f.calls.reads.length);
  } finally {
    f.service.close();
  }
});

test('全部补采失败不调用模型或写客户，保留两次实际用量且不误判产品不相关', async () => {
  const f = fixture({
    extract: async () => ({ results: [], usage: { credits: 0.5 } }),
  });
  try {
    const result = await f.service.research(input, {
      source_url: site,
      operation_id: 'collection-all-failed',
    });
    assert.equal(f.calls.models.length, 0);
    assert.equal(f.calls.writes, 0);
    assert.equal(result.新增, 0);
    assert.notEqual(result.research.product_match, 'not_matched');
    assert.deepEqual(f.store.get('collection-all-failed').web_usage, {
      web_extract_calls: 2,
      web_extract_credits: 1,
    });
  } finally {
    f.service.close();
  }
});

test('部分采集失败时保留短页证据，并将产品依据不足标为待核实', async () => {
  const f = fixture({
    readPage: async (url) => ({
      html: url.pathname === '/' ? '<p>Contact us.</p><a href="/about">About</a>' : 'Loading...',
    }),
    extract: async () => ({ results: [] }),
  });
  try {
    const result = await f.service.research(input, {
      source_url: site,
      operation_id: 'collection-partial-failure',
    });
    assert.equal(result.outcome, 'review');
    assert.equal(result.research.product_match, 'unknown');
    assert.equal(f.calls.models.length, 0);
    assert.equal(f.calls.writes, 0);
    assert.ok(
      f.store.get('collection-partial-failure').research_pages[0].text.includes('Contact us.'),
    );
  } finally {
    f.service.close();
  }
});

test('补采正文进入同一份预算约束的模型输入和引文校验页，完整 HTML 联系方式保留', async () => {
  const valid = text + 'x'.repeat(30000);
  const f = fixture({
    html: '<p>Loading...</p><a href="mailto:public@blinds.example.org"></a>',
    extract: async () => ({ results: [{ url: site, raw_content: valid }] }),
  });
  try {
    await f.service.research(input, { source_url: site, operation_id: 'collection-bounded-input' });
    assert.equal(f.calls.models.length, 1);
    const operation = f.store.get('collection-bounded-input');
    const sent = JSON.parse(f.calls.models[0].messages[1].content).pages;
    assert.deepEqual(sent, operation.research_pages);
    assert.ok(sent[0].text.startsWith(text));
    assert.ok(sent[0].text.length <= 16000);
    assert.equal(operation.research_usage.truncated_pages, 1);
    assert.ok(
      operation.evidence.contacts.some((contact) => contact.value === 'public@blinds.example.org'),
    );
  } finally {
    f.service.close();
  }
});

test('部分正文仅在导航提及目标产品，模型核实其他产品也保持采集待核实', async () => {
  const quote = 'Example Blinds is a business selling camping tents and outdoor cooking equipment.';
  const fact = (value) => ({ value, quote, source_url: site });
  const f = fixture({
    readPage: async (url) => ({
      html:
        url.pathname === '/'
          ? `<p>${quote}</p><nav><a href="/products">zip screens</a><a href="/about">About</a></nav>`
          : '<p>Loading...</p>',
    }),
    extract: async () => ({ results: [] }),
    modelData: {
      company_name: fact('Example Blinds'),
      entity_type: fact('business'),
      products: [fact('camping tents')],
    },
  });
  try {
    const result = await f.service.research(input, {
      source_url: site,
      operation_id: 'collection-partial-model',
    });
    assert.equal(f.calls.models.length, 1);
    assert.equal(result.outcome, 'review');
    assert.equal(result.research.product_match, 'unknown');
    assert.deepEqual(result.research.products, ['camping tents']);
    assert.equal(f.calls.writes, 0);
  } finally {
    f.service.close();
  }
});

test('补采拒绝跨域、未规划及非 HTTPS 返回，仍限制五个页面和正文预算', async () => {
  const links = ['contact', 'about', 'services', 'privacy', 'terms', 'legal']
    .map((path) => `[${path}](/${path})`)
    .join('\n');
  const f = fixture({
    html: 'Loading...',
    extract: async ({ urls }) => ({
      results: [
        ...urls.map((url) => ({ url, raw_content: text + 'x'.repeat(20000) + '\n' + links })),
        { url: 'https://other.example.org/', raw_content: 'FOREIGN EVIDENCE' },
        { url: site + 'unplanned', raw_content: 'UNPLANNED EVIDENCE' },
        { url: 'http://blinds.example.org/', raw_content: 'INSECURE EVIDENCE' },
        { url: 'https://127.0.0.1/', raw_content: 'PRIVATE EVIDENCE' },
        { url: 'https://public:secret@blinds.example.org/', raw_content: 'CREDENTIAL EVIDENCE' },
      ],
    }),
  });
  try {
    const result = await f.service.collect(site);
    assert.equal(f.calls.reads.length, 5);
    assert.equal(new Set(f.calls.reads).size, 5);
    assert.equal(result.research_pages.length, 5);
    assert.ok(result.research_pages.every((page) => f.calls.reads.includes(page.source_url)));
    assert.ok(result.research_pages.every((page) => page.text.length <= 16000));
    assert.ok(result.research_pages.reduce((sum, page) => sum + page.text.length, 0) <= 80000);
    assert.ok(!/FOREIGN|UNPLANNED|INSECURE|PRIVATE|CREDENTIAL/.test(result.page_text));
    assert.ok(
      f.calls.extracts.every((body) => body.urls.every((url) => f.calls.reads.includes(url))),
    );
  } finally {
    f.service.close();
  }
});
