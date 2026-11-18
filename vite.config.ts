import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';

export default defineConfig({
  plugins: [
    react(),
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
