import { config } from '../config.js';
import { migrate } from '../db/migrate.js';

await migrate(config.adminDatabaseUrl, config.appRole);
console.log('migrations complete');
