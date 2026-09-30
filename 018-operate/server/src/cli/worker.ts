// Standalone worker process (set RUN_WORKER=false on web instances when running this separately).
import { startWorker } from '../services/worker.js';

startWorker(console);
console.log('Operate worker started');
