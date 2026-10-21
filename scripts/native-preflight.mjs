import { acquisitionConfig } from '../server/acquisition-config.mjs';
import { FeishuClient } from '../server/feishu-direct.mjs';
import { connectionEnvironment } from '../server/api-connections.mjs';
const env = connectionEnvironment();
const config = acquisitionConfig(env);
if (!config.nativeReady) {
  console.log(JSON.stringify({ ready: false, missing: config.missing }));
  process.exitCode = 1;
} else {
  try {
    const client = new FeishuClient({ env });
    const fields = await client.fields();
    const leads = await client.readLeads();
    const response = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    const model = env.DEEPSEEK_MODEL || 'deepseek-flash';
    const available = response.ok && body.data?.some((m) => m.id === model);
    console.log(
      JSON.stringify({
        ready: available,
        provider: config.provider,
        feishuRead: true,
        records: leads.total,
        fields: fields.length,
        deepseekModel: model,
        modelAvailable: available,
        tavilyConfigured: true,
        writesPerformed: 0,
      }),
    );
    if (!available) process.exitCode = 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        ready: false,
        error: error.status ? error.message : '连接预检失败，未写入任何客户',
      }),
    );
    process.exitCode = 1;
  }
}
