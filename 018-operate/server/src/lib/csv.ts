/** Neutralize spreadsheet formula injection: cells starting with = + - @ TAB CR are prefixed with an apostrophe. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/** UTF-8 with BOM so Excel (Japanese locale) opens it correctly. */
export function toCsv(headers: string[], rows: unknown[][]): Buffer {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

/** Safe ZIP entry / file name component: no separators, no dot-dot, bounded length. */
export function safeName(s: string, max = 60): string {
  const n = s.normalize('NFKC').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/_+/g, '_').replace(/^[_.]+|[_.]+$/g, '').slice(0, max);
  return n || 'item';
}
