import { OutreachService } from '../../server/outreach-service.mjs';
import { LeadLibrary } from '../../server/lead-library.mjs';
import { createOutreachGenerator } from '../../server/outreach-content.mjs';
const modelEnv = {
  RESEARCH_MODEL_PROVIDER: 'openai_compatible',
  RESEARCH_MODEL_BASE_URL: 'https://offline.invalid/v1',
  RESEARCH_MODEL_API_KEY: 'fixture',
  RESEARCH_MODEL_MODEL: 'fixture',
};
export function categoryPreviewFixture(count = 1200, respond) {
  const library = new LeadLibrary({ scope: 'preview-qa' });
  const brands = [
    ['honeybadgerblinds.com', 'Honey Badger Blinds', 'roller blinds'],
    ['shuangshengshutter.com', 'Shuangsheng Shutter', 'PVC shutters'],
    ['shutterblindssolutions.com', 'Shutter & Blinds Solutions', 'roller blinds'],
  ];
  const products = brands.map(([domain, brand, name], i) => ({
    id: 'product-' + i,
    name,
    englishName: name,
    direction: 'finished',
    status: 'approved',
    version: 1,
    brands: [brand],
    sourceUrl: 'https://' + domain,
    markets: [],
  }));
  const boxes = brands.map(([domain, brand], i) => ({
    id: 'box-' + i,
    email: 'sales@' + domain,
    website: 'https://' + domain,
    brandName: brand,
    displayName: 'Sales ' + i,
    signature: brand + '\nhttps://' + domain,
    productIds: [products[i].id],
    configured: true,
    smtpStatus: 'connected',
    dailyLimit: 200,
    paused: false,
  }));
  const leads = [];
  const make = (id, role, product, extra = {}) => {
    const domain = id + '.example.org';
    return {
      id,
      name: 'QA ' + id.replace('manufacturer', 'maker').replace('distributor', 'dealer'),
      website: 'https://' + domain,
      market: 'Australia',
      grade: 'B',
      status: '待开发',
      type: role,
      email: 'info@' + domain,
      fields: {},
      facts: [
        {
          field: 'entity_type',
          value: 'business',
          quote: 'We are a window furnishing business.',
          source_url: 'https://' + domain + '/about',
        },
        {
          field: 'customer_type',
          value: role,
          quote: 'Our business role is ' + role + '.',
          source_url: 'https://' + domain + '/about',
        },
        {
          field: 'products',
          value: product,
          quote: 'Our range includes ' + product + '.',
          source_url: 'https://' + domain + '/products',
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
      ...extra,
    };
  };
  // The first 1,200 in-category dossiers have no matching product. The answer is beyond every first page.
  for (let i = 0; i < count; i++)
    leads.push(
      make('a' + String(i).padStart(5, '0'), 'manufacturer', 'garden furniture', {
        fields: { large: 'x'.repeat(4096) },
      }),
    );
  for (const [i, p] of products.entries())
    for (const role of ['manufacturer', 'distributor'])
      for (let n = 0; n < 2; n++)
        leads.push(make('z' + i + '-' + role + '-' + n, role, p.englishName));
  const multi = make('z-multi', 'distributor', 'roller blinds');
  multi.facts.push({
    field: 'customer_types',
    value: 'manufacturer',
    quote: 'We manufacture roller blinds.',
    source_url: multi.website + '/about',
  });
  leads.push(multi);
  const foreign = make('a-foreign', 'manufacturer', 'roller blinds');
  foreign.facts[1].source_url = 'https://unrelated.example.org';
  leads.push(foreign);
  const missing = make('a-missing', 'distributor', 'roller blinds');
  missing.facts = missing.facts.filter((f) => f.field !== 'customer_type');
  leads.push(missing);
  const insert = library.db.prepare(
    'INSERT INTO lead_library_customers(scope,record_id,position,summary,detail,version) VALUES(?,?,?,?,?,?)',
  );
  library.db.exec('BEGIN');
  for (const [i, l] of leads.entries())
    insert.run(
      'preview-qa',
      l.id,
      i,
      JSON.stringify({ developmentEligible: true }),
      JSON.stringify(l),
      'v1',
    );
  library.db.exec('COMMIT');
  const requests = [];
  let sends = 0;
  const fetchImpl = async (url, request) => {
    const requestBody = JSON.parse(request.body);
    const payload = JSON.parse(requestBody.messages[1].content);
    requests.push(payload);
    const product = payload.sender?.product || payload.product;
    const response = payload.customer
      ? {
          subject: product + ' supply',
          body_text: [
            `I noticed your range includes ${product} among the window furnishings available to your customers. This seemed relevant to the products our team supplies for businesses reviewing their range.`,
            `At ${payload.sender.brand}, we supply ${product}. I wanted to introduce this part of our range for your team to consider.`,
            `Would a brief product overview be useful to your team?`,
          ].join('\n\n'),
          source_ids: [payload.customer.evidence[0].id],
        }
      : { body_text: `Following up on ${product}. Would a brief product overview help your team?` };
    const returned = respond ? respond(payload, response) : response;
    const properties = requestBody.response_format.json_schema.schema.properties;
    const fields = Object.fromEntries(Object.entries(returned).filter(([key]) => key in properties));
    return Response.json({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(fields) } }],
    });
  };
  const service = new OutreachService({
    mailboxes: {
      list: () => structuredClone(boxes),
      get: (id) => structuredClone(boxes.find((b) => b.id === id)),
      send: () => {
        sends++;
        throw Error('Preview attempted SMTP');
      },
    },
    products: () => structuredClone(products),
    previewLeads: (...args) => library.previewLeads(...args),
    loadLeads: () => {
      throw Error('Preview loaded all contacts');
    },
    getEnv: () => modelEnv,
    fetchImpl,
    generator: createOutreachGenerator({ env: modelEnv, fetchImpl }),
    getScope: () => 'preview-qa',
  });
  return {
    library,
    service,
    products,
    boxes,
    leads,
    requests,
    get sends() {
      return sends;
    },
    close: async () => {
      await service.close();
      library.close();
    },
  };
}
