import { defineConfig, loadEnv } from 'vite';
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
        // Keep the regular API in charge of mail transport, polling and background jobs.
        server.middlewares.use((req, res, next) => {
          const path = (req.url || '').split('?')[0];
          // The development proxy can point at a backend started before photo management.
          // Check its saved draft before forwarding submission to the original mail transport.
          const replyPath = /^(\/api\/v1\/outreach\/conversations\/[\w-]+)\/reply$/.exec(path);
          if (req.method === 'POST' && replyPath) {
            const address = server.httpServer?.address();
            if (!address || typeof address === 'string')
              return next(new Error('无法核对本地草稿图片'));
            const headers = new Headers();
            if (req.headers.cookie) headers.set('cookie', req.headers.cookie);
            if (req.headers.authorization) headers.set('authorization', req.headers.authorization);
            void fetch('http://127.0.0.1:' + address.port + replyPath[1] + '/photo-check', {
              headers,
              redirect: 'error',
              signal: AbortSignal.timeout(10000),
            })
              .then(async (check) => {
                if (check.ok) {
                  await check.body?.cancel();
                  next();
                  return;
                }
                res.statusCode = check.status;
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(await check.text());
              })
              .catch(next);
            return;
          }
          const local =
            (req.method === 'POST' &&
              /^\/api\/v1\/outreach\/(?:mailboxes\/[\w-]+\/preview|conversations\/[\w-]+\/generate-draft)$/.test(
                path,
              )) ||
            (req.method === 'GET' &&
              /^\/api\/v1\/outreach\/conversations\/[\w-]+\/photo-check$/.test(path)) ||
            (['GET', 'POST'].includes(req.method || '') &&
              /^\/api\/v1\/materials\/pk_[\da-f]+\/document\/pd_[\da-f]+\/photos(?:\/[\w-]+)?$/.test(
                path,
              ));
          if (!local) return next();
          void server
            .ssrLoadModule('/server/app.mjs')
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
