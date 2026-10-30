import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sales = path.join(root, 'agents', 'export-sales');
const readJson = (relative) => JSON.parse(readFileSync(path.join(sales, relative), 'utf8'));

test('会话 1.3 示例显式区分单封审核和接管范围', () => {
  const inputSchema = readJson('turn-input.schema.json');
  const outputSchema = readJson('turn-output.schema.json');
  assert.equal(inputSchema.properties.contract_version.const, '1.3');
  assert.equal(outputSchema.properties.contract_version.const, '1.3');
  for (const name of ['quote', 'mixed', 'drawing', 'catalog-fallback']) {
    const input = readJson(`examples/${name}-input.json`);
    const output = readJson(`examples/${name}-output.json`);
    assert.equal(input.contract_version, '1.3');
    assert.equal(output.contract_version, '1.3');
    assert.ok(['ai', 'pending_human', 'human'].includes(input.conversation.ownership));
    assert.equal(typeof input.conversation.handoff_ack_sent, 'boolean');
    for (const item of input.demand_context) {
      assert.equal(typeof item.repeated_negotiation, 'boolean');
      assert.ok(Number.isInteger(item.nonprogress_exchanges));
      assert.equal(typeof item.large_order_match.matched, 'boolean');
      assert.ok(item.knowledge_resolution.retrieval_state);
    }
    for (const item of output.items) {
      assert.ok(['none', 'per_message'].includes(item.approval_gate));
      if (item.action !== 'request_handoff') assert.equal(item.handoff_scope, null);
      if (item.approval_gate === 'per_message') {
        assert.equal(item.action, 'reply');
        assert.equal(item.approval_reason, 'commercial_commitment');
      }
    }
  }
  const quote = readJson('examples/quote-output.json');
  assert.equal(quote.items[0].action, 'clarify');
  assert.equal(quote.items[0].handoff_reason, null);
});
