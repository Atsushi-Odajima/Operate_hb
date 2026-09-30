import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { startWorker } from './services/worker.js';

if (process.env.MIGRATE_ON_START === 'true') await migrate(config.adminDatabaseUrl, config.appRole);
const app = await buildApp();
await app.listen({ port: config.port, host: config.host });
if (config.runWorkerInProcess) startWorker(app.log);
