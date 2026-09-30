// In-memory sliding-window rate limiter (per process). For multi-instance deployments see docs/SECURITY.md.
const hits = new Map<string, number[]>();

export function allow(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    hits.set(key, arr);
    return false;
  }
  arr.push(now);
  hits.set(key, arr);
  if (hits.size > 50000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return true;
}

export function resetRateLimits() {
  hits.clear();
}
