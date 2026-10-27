import { createApp } from '../../server/app.mjs';

export async function withApp(options, callback) {
  const app = createApp(options);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  try {
    await callback(`http://127.0.0.1:${app.address().port}`);
  } finally {
    await new Promise((resolve) => app.close(resolve));
  }
}
