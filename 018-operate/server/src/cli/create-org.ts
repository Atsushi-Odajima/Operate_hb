// Usage: npm run create-org -- <slug> <組織名> <owner-email> <owner-name>
// Prints a one-time temporary password for the Owner.
import { token } from '../lib/crypto.js';
import { provisionOrg } from '../services/provision.js';
import { pool } from '../db/pool.js';

const [slug, name, email, ownerName] = process.argv.slice(2);
if (!slug || !name || !email || !ownerName) { console.error('usage: create-org <slug> <name> <owner-email> <owner-name>'); process.exit(2); }
const password = token(12);
const r = await provisionOrg({ slug, name, ownerEmail: email, ownerName, ownerPassword: password });
console.log(JSON.stringify({ ...r, slug, ownerEmail: email, temporaryPassword: password, note: '初回ログイン後にパスワードを変更してください' }, null, 2));
await pool.end();
