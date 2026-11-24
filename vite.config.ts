import { defineConfig, loadEnv } from 'vite';
import { pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'local-draft-api',
      apply: 'serve',
      configureServer(server) {
        const env = loadEnv(server.config.mode, server.config.root, '');
        if (env.SHADEFLOW_LOCAL_DRAFT_API !== '1') return;
        // Serve only draft requests in the dev process. The existing API owns background jobs.
        server.middlewares.use((req, res, next) => {
          if (
            req.method !== 'POST' ||
            !/^\/api\/v1\/outreach\/(?:mailboxes\/[\w-]+\/preview|conversations\/[\w-]+\/generate-draft)$/.test(
              req.url || '',
            )
          )
            return next();
          void import(pathToFileURL(join(server.config.root, 'server/app.mjs')).href)
            .then(({ createApp }) => {
              const app = createApp({
                env: {
                  ...process.env,
                  ...env,
                  CONNECTIONS_PATH: env.CONNECTIONS_PATH || '.data/api-connections.json',
                  RELEASE_MAINTENANCE_PATH: '.data/release-maintenance.json',
                },
              });
              res.once('close', () => app.emit('close'));
              app.emit('request', req, res);
            })
            .catch(next);
        });
      },
    },
    {
      name: 'precompress-assets',
      augmentChunkHash(chunk) {
        // Browsers may already hold the old, incomplete Brotli entry under an immutable URL.
        if (chunk.isEntry) return 'final-brotli-v1';
      },
      async writeBundle({ dir }, bundle) {
        if (!dir) return;
        for (const name of Object.keys(bundle)) {
          if (!/^assets\/.*\.(?:js|css)$/.test(name)) continue;
          const path = join(dir, name);
          await writeFile(path + '.br', brotliCompressSync(await readFile(path)));
        }
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: Number(process.env.VITE_PORT || 5174),
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.VITE_API_PORT || 4311}` },
  },
});
