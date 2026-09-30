import { createHash, createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  // Always spend comparable time, even for unknown users.
  const [alg, n, saltB64, keyB64] = (stored ?? 'scrypt$32768$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').split('$');
  if (alg !== 'scrypt') return false;
  const key = await scrypt(pw, Buffer.from(saltB64, 'base64'), 32, { ...SCRYPT, N: Number(n) });
  const expected = Buffer.from(keyB64, 'base64');
  return stored !== null && expected.length === key.length && timingSafeEqual(expected, key);
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const token = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hmac = (s: string) => createHmac('sha256', config.secret).update(s).digest('base64url');

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Deterministic JSON (sorted keys) used for content hashing. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}
