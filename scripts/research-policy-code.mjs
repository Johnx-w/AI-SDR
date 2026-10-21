import { readFile } from 'node:fs/promises';

// Standalone dependencies for legacy n8n Code nodes, generated from the same policy
// as the native engine. No module imports are available inside a Code node.
export const researchPolicyCode = (
  await Promise.all(
    ['relevance', 'customer-eligibility'].map(async (name) =>
      (await readFile(new URL(`../server/${name}.mjs`, import.meta.url), 'utf8'))
        .replace(/^import .*;\r?$/gm, '')
        .replace(/^export /gm, ''),
    ),
  )
).join('\n');
