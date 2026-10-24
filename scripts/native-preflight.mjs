import { acquisitionConfig, researchProviderConfig } from '../server/acquisition-config.mjs';
import { customsConfig } from '../server/customs-discovery.mjs';
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
    const research = researchProviderConfig(env);
    const response = await fetch(research.model.baseUrl + '/models', {
      headers: { Authorization: 'Bearer ' + research.model.apiKey },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json();
    const model = research.model.model;
    const available = response.ok && body.data?.some((m) => m.id === model);
    console.log(
      JSON.stringify({
        ready: available,
        provider: config.provider,
        feishuRead: true,
        records: leads.total,
        fields: fields.length,
        researchModel: model,
        modelProvider: research.model.provider,
        modelAvailable: available,
        webSearchProvider: research.web.provider,
        webSearchConfigured: true,
        customs: customsConfig(env),
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
