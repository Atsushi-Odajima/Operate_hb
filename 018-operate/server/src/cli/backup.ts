// Usage: npm run backup -- <org-slug> [out-file]
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { config } from '../config.js';
import { createBackup } from '../services/backup.js';

const [slug, out] = process.argv.slice(2);
if (!slug) { console.error('usage: backup <org-slug> [out.json.gz]'); process.exit(2); }
const b = await createBackup(config.adminDatabaseUrl, slug);
const file = out ?? `operate-backup-${slug}-${b.generatedAt.replace(/[:.]/g, '-')}.json.gz`;
writeFileSync(file, gzipSync(Buffer.from(JSON.stringify(b))));
console.log(JSON.stringify({ file, generatedAt: b.generatedAt, counts: b.counts }, null, 2));
