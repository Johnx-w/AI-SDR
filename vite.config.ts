import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { brotliCompressSync } from 'node:zlib';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'precompress-assets',
      generateBundle(_, bundle) {
        for (const file of Object.values(bundle)) {
          if (!/^assets\/.*\.(?:js|css)$/.test(file.fileName)) continue;
          this.emitFile({
            type: 'asset',
            fileName: file.fileName + '.br',
            source: brotliCompressSync(file.type === 'chunk' ? file.code : file.source),
          });
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
