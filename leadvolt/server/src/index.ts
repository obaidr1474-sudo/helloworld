import { buildApp } from './app.js';
import { config } from './lib/config.js';
import { attachRealtime } from './realtime.js';
import { startWorkers } from './workers.js';
import { pool } from './lib/db.js';

const app = await buildApp();
attachRealtime(app);
const stopWorkers = config.workers.enabled ? startWorkers(config.workers.slaIntervalMs, app.log) : () => {};

const shutdown = async () => {
  stopWorkers();
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: config.host });
