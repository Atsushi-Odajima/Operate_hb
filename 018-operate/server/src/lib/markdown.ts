import type { PMNode } from './content.js';
import { safeHref } from './content.js';

/** Minimal Markdown / plain-text -> whitelisted ProseMirror JSON. Used by Import (conversion accuracy is best-effort). */
function inline(s: string): PMNode[] {
  const out: PMNode[] = [];
  const re = /(\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    if (m[2]) out.push({ type: 'text', text: m[2], marks: [{ type: 'bold' }] });
    else if (m[3]) {
      const href = safeHref(m[4]);
      out.push(href ? { type: 'text', text: m[3], marks: [{ type: 'link', attrs: { href } }] } : { type: 'text', text: m[3] });
    } else if (m[5]) out.push({ type: 'text', text: m[5], marks: [{ type: 'code' }] });
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out.filter((n) => n.text);
}
const p = (s: string): PMNode => ({ type: 'paragraph', content: inline(s) });

export function markdownToDoc(md: string): PMNode {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const content: PMNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }
    let m: RegExpMatchArray | null;
    if ((m = t.match(/^(#{1,4})\s+(.+)$/))) { content.push({ type: 'heading', attrs: { level: Math.min(4, m[1].length + (m[1].length === 1 ? 1 : 0)) }, content: inline(m[2]) }); i++; continue; }
    if (t.startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++;
      content.push({ type: 'codeBlock', attrs: { language: null }, content: buf.join('\n') ? [{ type: 'text', text: buf.join('\n') }] : [] });
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) { content.push({ type: 'horizontalRule' }); i++; continue; }
    if (t.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      content.push({ type: 'table', content: rows.map((r, ri) => ({ type: 'tableRow', content: r.map((c) => ({ type: ri === 0 ? 'tableHeader' : 'tableCell', attrs: { colspan: 1, rowspan: 1, colwidth: null }, content: [p(c)] })) })) });
      continue;
    }
    if (/^([-*・●]|\d+[.)．]|[①-⑳])\s*/.test(t)) {
      const ordered = /^(\d+[.)．]|[①-⑳])/.test(t);
      const items: PMNode[] = [];
      while (i < lines.length && /^\s*([-*・●]|\d+[.)．]|[①-⑳])\s*/.test(lines[i]) && lines[i].trim()) {
        items.push({ type: 'listItem', content: [p(lines[i].trim().replace(/^([-*・●]|\d+[.)．]|[①-⑳])\s*/, ''))] });
        i++;
      }
      content.push({ type: ordered ? 'orderedList' : 'bulletList', ...(ordered ? { attrs: { start: 1 } } : {}), content: items });
      continue;
    }
    if (t.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) buf.push(lines[i++].trim().replace(/^>\s?/, ''));
      content.push({ type: 'blockquote', content: buf.map(p) });
      continue;
    }
    if (/^(注意|警告|【注意】|※)/.test(t)) { content.push({ type: 'callout', attrs: { kind: 'warning' }, content: [p(t)] }); i++; continue; }
    // plain-text heading heuristic: short line followed by blank, like "1. 目的" handled above; "■ 目的" / "【目的】"
    if ((m = t.match(/^(?:■|◆|【)(.{1,40}?)(?:】)?$/))) { content.push({ type: 'heading', attrs: { level: 2 }, content: inline(m[1]) }); i++; continue; }
    content.push(p(t));
    i++;
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}
