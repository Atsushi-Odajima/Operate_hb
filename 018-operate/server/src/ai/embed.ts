import { createHash } from 'node:crypto';

/**
 * Local embedding: signed feature hashing of character bigrams/trigrams (works for Japanese without a tokenizer)
 * and ASCII words, L2-normalised to 256 dims. Runs in-process — document text is NEVER sent to an external
 * embedding API. It is lexical rather than deeply semantic; retrieval combines it with trigram keyword scores.
 */
export const EMBED_DIM = 256;
export const EMBED_MODEL = 'local-hash-v1';

function h32(s: string): number {
  const b = createHash('md5').update(s).digest();
  return b.readUInt32LE(0);
}

export function normalizeText(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function features(text: string): Map<string, number> {
  const t = normalizeText(text);
  const f = new Map<string, number>();
  const add = (k: string, w: number) => f.set(k, (f.get(k) ?? 0) + w);
  for (const w of t.match(/[a-z0-9]{2,}/g) ?? []) add(`w:${w}`, 1.5);
  const cjk = t.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu, '|');
  for (const seg of cjk.split('|')) {
    const chars = [...seg];
    for (let i = 0; i < chars.length - 1; i++) {
      add(`b:${chars[i]}${chars[i + 1]}`, 1);
      if (i < chars.length - 2) add(`t:${chars[i]}${chars[i + 1]}${chars[i + 2]}`, 0.7);
    }
    if (chars.length === 1) add(`u:${chars[0]}`, 0.5);
  }
  return f;
}

export function embed(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  for (const [k, w] of features(text)) {
    const h = h32(k);
    const idx = h % EMBED_DIM;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    v[idx] += sign * (1 + Math.log(w));
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => Number((x / norm).toFixed(6)));
}

export const toVector = (v: number[]) => `[${v.join(',')}]`;
