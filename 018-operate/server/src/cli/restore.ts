// Usage: npm run restore -- <backup.json.gz> [--replace] [--dry-run]
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { config } from '../config.js';
import { restoreBackup, validateBackup, type Backup } from '../services/backup.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: restore <backup.json.gz> [--replace] [--dry-run]'); process.exit(2); }
const buf = readFileSync(file);
const b: Backup = JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf).toString('utf8'));
const v = validateBackup(b);
console.log(JSON.stringify({ validation: v.ok ? 'ok' : 'failed', errors: v.errors, counts: v.counts }, null, 2));
if (!v.ok) process.exit(1);
if (args.includes('--dry-run')) process.exit(0);
const r = await restoreBackup(config.adminDatabaseUrl, b, args.includes('--replace') ? 'replace' : 'new');
console.log(JSON.stringify({ restored: r.ok, checks: r.checks }, null, 2));
