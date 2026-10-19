import { createApp } from './app.mjs';
const port = Number(process.env.PORT || 4311);
const app = createApp();
app.listen(port, '127.0.0.1', () =>
  console.log(`ShadeFlow API / 本地应用: http://127.0.0.1:${port}`),
);
app.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
