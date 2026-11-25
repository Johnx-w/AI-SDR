import { createHash } from 'node:crypto';
import { LeadLibrary } from '../../server/lead-library.mjs';
import { mapFeishuRecord } from '../../server/feishu.mjs';

export function seedCustomers(env, records) {
  const scope = createHash('sha256')
    .update(
      JSON.stringify([
        'native',
        env.FEISHU_APP_ID || '',
        env.FEISHU_APP_TOKEN || '',
        env.FEISHU_TABLE_ID || '',
        '',
      ]),
    )
    .digest('hex');
  const path = env.LEAD_LIBRARY_DB_PATH || env.BATCH_DB_PATH;
  if (!path || path === ':memory:') throw Error('SQLite fixture needs a file');
  const library = new LeadLibrary({ path, scope });
  try {
    for (const record of records) library.upsert(mapFeishuRecord(record));
  } finally {
    library.close();
  }
}
