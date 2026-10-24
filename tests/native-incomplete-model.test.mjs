import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NativeAcquisition } from '../server/native-acquisition.mjs';

test('新候选模型输出达到上限时明确说明完整JSON未取得，不误报采集失败或写入', async () => {
  let modelCalls = 0;
  const service = new NativeAcquisition({
    env: {
      ACQUISITION_PROVIDER: 'native',
      TAVILY_API_KEY: 'fixture-search',
      DEEPSEEK_API_KEY: 'fixture-model',
      FEISHU_APP_ID: 'fixture-app',
      FEISHU_APP_SECRET: 'fixture-secret',
      FEISHU_APP_TOKEN: 'fixture-table',
      FEISHU_TABLE_ID: 'fixture-id',
    },
    readPage: async () => ({
      html: '<p>Acme Screens supplies zip screens to dealers nationwide. Contact sales@acmescreens.example.org</p>',
    }),
    feishu: {
      records: async () => [],
      fields: async () => assert.fail('No write preparation permitted'),
      write: async () => assert.fail('No remote write permitted'),
    },
    providers: {
      web: { extract: async () => assert.fail('No extract needed') },
      model: {
        research: async () => {
          modelCalls++;
          return {
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
            usage: { input_tokens: 12000, output_tokens: 48000 },
          };
        },
      },
    },
    fetchImpl: async () => assert.fail('No external requests permitted'),
  });
  try {
    const result = await service.research(
      { country: 'United States', product: 'zip screens', audience: 'BC' },
      {
        source_url: 'https://acmescreens.example.org/',
        operation_id: 'incomplete-model-output-regression',
      },
    );
    assert.equal(modelCalls, 1);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.新增, 0);
    assert.match(result.reason, /模型.*(?:上限|额度).*JSON/);
    assert.doesNotMatch(result.reason, /采集/);
    assert.equal(result.research_usage.output_tokens, 48000);
  } finally {
    service.close();
  }
});
