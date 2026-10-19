import { randomBytes } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';

try {
  await access('.env');
  console.log('.env 已存在，未覆盖。');
} catch {
  const secret = randomBytes(32).toString('hex');
  await writeFile(
    '.env',
    [
      'N8N_BASE_URL=https://vynox.app.n8n.cloud',
      'N8N_WORKFLOW_ID=EycE9OmaPkRFUDSq',
      'N8N_WEBHOOK_URL=https://vynox.app.n8n.cloud/webhook/shadeflow-leads-api',
      `N8N_WEBHOOK_SECRET=${secret}`,
      'N8N_WEBHOOK_ENABLED=false',
      'N8N_API_KEY=',
      'PORT=4311',
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  console.log(
    '已生成本地 .env 与随机 Webhook 密钥，未在终端显示。请由用户将该密钥填入 n8n Header Auth 的 Value 字段。',
  );
}
