import { createApp } from './app.mjs';
const port = Number(process.env.PORT || 4311);
const app = createApp({
  env: {
    ...process.env,
    BATCH_DB_PATH: process.env.BATCH_DB_PATH || '.data/acquisition.sqlite',
    LEAD_LIBRARY_DB_PATH: process.env.LEAD_LIBRARY_DB_PATH || '.data/lead-library.sqlite',
    CONNECTIONS_PATH: process.env.CONNECTIONS_PATH || '.data/api-connections.json',
    SCHEDULE_DB_PATH: process.env.SCHEDULE_DB_PATH || '.data/acquisition-schedules.sqlite',
  },
});
app.listen(port, '127.0.0.1', () => console.log(`ShadeFlow API: http://127.0.0.1:${port}`));
app.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
