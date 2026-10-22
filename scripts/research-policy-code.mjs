import { readFile } from 'node:fs/promises';
import acquisition from '../src/data/acquisition.json' with { type: 'json' };
import { productTerms } from '../src/domain/acquisition-products.mjs';

// Standalone dependencies for legacy n8n Code nodes, generated from the same policy
// as the native engine. No module imports are available inside a Code node.
export const researchPolicyCode =
  'const acquisition=' +
  JSON.stringify({ customerTypes: acquisition.customerTypes }) +
  ';\n' +
  productTerms.toString() +
  '\n' +
  (
    await Promise.all(
      ['relevance', 'customer-eligibility', 'assessment-evidence', 'company-identity'].map(
        async (name) =>
          (await readFile(new URL(`../server/${name}.mjs`, import.meta.url), 'utf8'))
            .replace(/^import .*;\r?$/gm, '')
            .replace(/^export /gm, ''),
      ),
    )
  ).join('\n');
