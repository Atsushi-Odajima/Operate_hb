import { badRequest } from './errors.js';
import { canonicalJson, sha256 } from './crypto.js';

/**
 * Document content model.
 * body: ProseMirror/TipTap JSON restricted to a whitelist of nodes/marks/attrs (validated & normalized here,
 * so nothing outside the whitelist is ever stored, regardless of what the editor or a pasted HTML produced).
 * steps: Step-type SOP (1 step per screen in mobile "run" mode).
 * checklistItems: items for Checklist documents (Checklist Run template).
 */
export interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}
export interface Step {
  id: string;
  title: string;
  instruction: string;
  warning: string;
  expectedResult: string;
  imageId: string | null;
  checklist: string[];
  reference: string;
}
export interface ChecklistItem {
  id: string;
  text: string;
  required: boolean;
}
export interface Content {
  body: PMNode;
  steps: Step[];
  checklistItems: ChecklistItem[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMG_SRC = /^\/api\/attachments\/[0-9a-f-]{36}\/content$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;

const BLOCKS = new Set([
  'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'table', 'tableRow',
  'tableHeader', 'tableCell', 'image', 'codeBlock', 'blockquote', 'callout', 'horizontalRule', 'hardBreak', 'text',
]);
const MARKS = new Set(['bold', 'italic', 'strike', 'code', 'underline', 'link', 'highlight']);

export function safeHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length > 2000) return null;
  const h = href.trim();
  if (/^(https?:\/\/|mailto:)/i.test(h)) return h;
  if (/^\/(?!\/)/.test(h) || /^#[\w-]*$/.test(h)) return h; // same-origin relative
  return null;
}

function clampInt(v: unknown, min: number, max: number, def: number) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

function normAttrs(type: string, a: Record<string, unknown> = {}): Record<string, unknown> | undefined {
  switch (type) {
    case 'heading':
      return { level: clampInt(a.level, 1, 4, 2) };
    case 'orderedList':
      return { start: clampInt(a.start, 1, 10000, 1) };
    case 'taskItem':
      return { checked: a.checked === true };
    case 'tableCell':
    case 'tableHeader': {
      const cw = Array.isArray(a.colwidth) ? a.colwidth.filter((n) => Number.isInteger(n) && n > 0 && n < 2000).slice(0, 20) : null;
      return { colspan: clampInt(a.colspan, 1, 20, 1), rowspan: clampInt(a.rowspan, 1, 50, 1), colwidth: cw && cw.length ? cw : null };
    }
    case 'image': {
      if (typeof a.src !== 'string' || !IMG_SRC.test(a.src)) throw badRequest('画像は Operate にアップロードしたものだけ使用できます');
      return { src: a.src, alt: String(a.alt ?? '').slice(0, 300), title: a.title ? String(a.title).slice(0, 300) : null };
    }
    case 'codeBlock': {
      const lang = typeof a.language === 'string' && /^[a-z0-9+#-]{1,20}$/i.test(a.language) ? a.language : null;
      return { language: lang };
    }
    case 'callout':
      return { kind: ['note', 'warning', 'danger'].includes(String(a.kind)) ? a.kind : 'note' };
    default:
      return undefined;
  }
}

interface Budget {
  nodes: number;
  chars: number;
}

function normNode(n: unknown, depth: number, budget: Budget): PMNode {
  if (!n || typeof n !== 'object' || Array.isArray(n)) throw badRequest('本文の形式が不正です');
  const node = n as PMNode;
  if (depth > 24) throw badRequest('本文の入れ子が深すぎます');
  if (++budget.nodes > 50000) throw badRequest('本文が大きすぎます');
  if (!BLOCKS.has(node.type)) throw badRequest(`使用できない要素です: ${String(node.type).slice(0, 40)}`);
  if (node.type === 'text') {
    if (typeof node.text !== 'string' || node.text.length === 0) throw badRequest('本文の形式が不正です');
    budget.chars += node.text.length;
    if (budget.chars > 400000) throw badRequest('本文が長すぎます（40万文字まで）');
    const out: PMNode = { type: 'text', text: node.text };
    if (Array.isArray(node.marks) && node.marks.length) {
      const marks = [];
      for (const m of node.marks.slice(0, 10)) {
        if (!m || !MARKS.has(m.type)) continue; // unknown marks are dropped, not stored
        if (m.type === 'link') {
          const href = safeHref(m.attrs?.href);
          if (!href) continue; // javascript:, data:, etc. are dropped
          marks.push({ type: 'link', attrs: { href } });
        } else marks.push({ type: m.type });
      }
      if (marks.length) out.marks = marks;
    }
    return out;
  }
  const out: PMNode = { type: node.type };
  const attrs = normAttrs(node.type, (node.attrs as Record<string, unknown>) ?? {});
  if (attrs) out.attrs = attrs;
  if (Array.isArray(node.content) && node.content.length) out.content = node.content.map((c) => normNode(c, depth + 1, budget));
  return out;
}

const str = (v: unknown, max: number, field: string) => {
  const s = v === undefined || v === null ? '' : String(v);
  if (s.length > max) throw badRequest(`${field} は ${max} 文字以内にしてください`);
  return s;
};

export function normalizeContent(input: unknown): Content {
  const c = (input ?? {}) as Partial<Content>;
  const budget: Budget = { nodes: 0, chars: 0 };
  let body: PMNode = { type: 'doc', content: [{ type: 'paragraph' }] };
  if (c.body) {
    const b = c.body as PMNode;
    if (b.type !== 'doc') throw badRequest('本文の形式が不正です');
    body = { type: 'doc', content: (Array.isArray(b.content) ? b.content : []).map((x) => normNode(x, 1, budget)) };
  }
  const steps: Step[] = (Array.isArray(c.steps) ? c.steps : []).slice(0, 200).map((s, i) => {
    const st = s as Partial<Step>;
    const imageId = st.imageId && UUID.test(String(st.imageId)) ? String(st.imageId) : null;
    return {
      id: ID.test(String(st.id)) ? String(st.id) : `s${i + 1}`,
      title: str(st.title, 200, '手順タイトル'),
      instruction: str(st.instruction, 5000, '手順の説明'),
      warning: str(st.warning, 1000, '注意'),
      expectedResult: str(st.expectedResult, 1000, '期待される結果'),
      imageId,
      checklist: (Array.isArray(st.checklist) ? st.checklist : []).slice(0, 30).map((x) => str(x, 300, '確認項目')).filter(Boolean),
      reference: str(st.reference, 500, '参照'),
    };
  });
  const checklistItems: ChecklistItem[] = (Array.isArray(c.checklistItems) ? c.checklistItems : []).slice(0, 300).map((it, i) => {
    const x = it as Partial<ChecklistItem>;
    return { id: ID.test(String(x.id)) ? String(x.id) : `c${i + 1}`, text: str(x.text, 300, 'チェック項目'), required: x.required !== false };
  });
  const ids = new Set<string>();
  for (const s of [...steps, ...checklistItems]) {
    if (ids.has(s.id)) throw badRequest('手順/チェック項目の ID が重複しています');
    ids.add(s.id);
  }
  return { body, steps, checklistItems };
}

export function nodeText(n: PMNode): string {
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'hardBreak') return '\n';
  const inner = (n.content ?? []).map(nodeText).join(n.type === 'tableRow' ? ' | ' : '');
  const block = ['paragraph', 'heading', 'listItem', 'taskItem', 'codeBlock', 'tableRow', 'callout', 'blockquote'].includes(n.type);
  return block ? inner + '\n' : inner;
}

export interface Section {
  key: string;
  title: string;
  text: string;
}

/** Split content into citation-addressable sections (by top-level heading, steps, checklist). */
export function sections(c: Content): Section[] {
  const out: Section[] = [];
  let cur: Section = { key: 'intro', title: '本文', text: '' };
  let h = 0;
  for (const n of c.body.content ?? []) {
    if (n.type === 'heading') {
      if (cur.text.trim()) out.push(cur);
      h++;
      const t = nodeText(n).trim();
      cur = { key: `h${h}`, title: t || `見出し${h}`, text: '' };
    } else cur.text += nodeText(n);
  }
  if (cur.text.trim()) out.push(cur);
  c.steps.forEach((s, i) => {
    const parts = [s.instruction, s.warning && `注意: ${s.warning}`, s.expectedResult && `期待結果: ${s.expectedResult}`, ...s.checklist.map((x) => `□ ${x}`), s.reference && `参照: ${s.reference}`];
    out.push({ key: `step-${s.id}`, title: `手順${i + 1}: ${s.title}`, text: parts.filter(Boolean).join('\n') });
  });
  if (c.checklistItems.length) out.push({ key: 'checklist', title: 'チェック項目', text: c.checklistItems.map((x) => `□ ${x.text}`).join('\n') });
  return out.map((s) => ({ ...s, text: s.text.replace(/\n{3,}/g, '\n\n').trim() }));
}

export function plainText(c: Content): string {
  return sections(c)
    .map((s) => `${s.title}\n${s.text}`)
    .join('\n\n');
}

export function contentHash(v: { title: string; content: Content; changeSummary: string; changeType: string }): string {
  return sha256(canonicalJson({ title: v.title, content: v.content, changeSummary: v.changeSummary, changeType: v.changeType }));
}

export function imageIds(c: Content): string[] {
  const ids = new Set<string>();
  const walk = (n: PMNode) => {
    if (n.type === 'image' && typeof n.attrs?.src === 'string') ids.add(n.attrs.src.split('/')[3]);
    n.content?.forEach(walk);
  };
  walk(c.body);
  c.steps.forEach((s) => s.imageId && ids.add(s.imageId));
  return [...ids];
}

/** Build a simple content doc from paragraphs/headings — used by templates, import and AI draft. */
export function docFromBlocks(blocks: Array<{ h?: string; p?: string; li?: string[]; ol?: string[]; warn?: string; note?: string }>): PMNode {
  const t = (s: string): PMNode[] => (s ? [{ type: 'text', text: s }] : []);
  const para = (s: string): PMNode => ({ type: 'paragraph', content: t(s) });
  const content: PMNode[] = [];
  for (const b of blocks) {
    if (b.h) content.push({ type: 'heading', attrs: { level: 2 }, content: t(b.h) });
    if (b.p) for (const line of b.p.split('\n')) content.push(para(line));
    if (b.li) content.push({ type: 'bulletList', content: b.li.map((x) => ({ type: 'listItem', content: [para(x)] })) });
    if (b.ol) content.push({ type: 'orderedList', attrs: { start: 1 }, content: b.ol.map((x) => ({ type: 'listItem', content: [para(x)] })) });
    if (b.warn) content.push({ type: 'callout', attrs: { kind: 'warning' }, content: [para(b.warn)] });
    if (b.note) content.push({ type: 'callout', attrs: { kind: 'note' }, content: [para(b.note)] });
  }
  return { type: 'doc', content };
}
