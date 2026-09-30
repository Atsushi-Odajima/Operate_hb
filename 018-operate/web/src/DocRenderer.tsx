import type { ReactNode } from 'react';

export interface PMNode { type: string; attrs?: Record<string, any>; content?: PMNode[]; marks?: { type: string; attrs?: Record<string, any> }[]; text?: string }
export interface Step { id: string; title: string; instruction: string; warning: string; expectedResult: string; imageId: string | null; checklist: string[]; reference: string }
export interface Content { body: PMNode; steps: Step[]; checklistItems: { id: string; text: string; required: boolean }[] }

const safe = (h?: string) => (h && /^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(h) ? h : undefined);

function marks(text: string, ms: PMNode['marks'] = [], key: number): ReactNode {
  let el: ReactNode = text;
  for (const m of ms) {
    if (m.type === 'bold') el = <strong>{el}</strong>;
    else if (m.type === 'italic') el = <em>{el}</em>;
    else if (m.type === 'strike') el = <s>{el}</s>;
    else if (m.type === 'underline') el = <u>{el}</u>;
    else if (m.type === 'code') el = <code>{el}</code>;
    else if (m.type === 'highlight') el = <mark>{el}</mark>;
    else if (m.type === 'link') { const href = safe(m.attrs?.href); el = href ? <a href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">{el}</a> : el; }
  }
  return <span key={key}>{el}</span>;
}

const CALLOUT: Record<string, string> = { note: '補足', warning: '注意', danger: '危険' };
let hCounter = 0;

function node(n: PMNode, key: number): ReactNode {
  const kids = (n.content ?? []).map((c, i) => node(c, i));
  switch (n.type) {
    case 'text': return marks(n.text ?? '', n.marks, key);
    case 'paragraph': return <p key={key}>{kids}</p>;
    case 'heading': { const L = Math.min(4, Math.max(2, (n.attrs?.level ?? 2) + (n.attrs?.level === 1 ? 1 : 0))); const H = `h${L}` as 'h2'; hCounter++; return <H key={key} id={`h${hCounter}`}>{kids}</H>; }
    case 'bulletList': return <ul key={key}>{kids}</ul>;
    case 'orderedList': return <ol key={key} start={n.attrs?.start ?? 1}>{kids}</ol>;
    case 'listItem': return <li key={key}>{kids}</li>;
    case 'taskList': return <ul key={key} className="task">{kids}</ul>;
    case 'taskItem': return <li key={key}><span aria-hidden>{n.attrs?.checked ? '☑' : '☐'}</span><div>{kids}</div></li>;
    case 'blockquote': return <blockquote key={key}>{kids}</blockquote>;
    case 'codeBlock': return <pre key={key}><code>{(n.content ?? []).map((c) => c.text).join('')}</code></pre>;
    case 'horizontalRule': return <hr key={key} />;
    case 'hardBreak': return <br key={key} />;
    case 'image': return <img key={key} src={n.attrs?.src} alt={n.attrs?.alt ?? ''} loading="lazy" />;
    case 'table': return <table key={key}><tbody>{kids}</tbody></table>;
    case 'tableRow': return <tr key={key}>{kids}</tr>;
    case 'tableHeader': return <th key={key} colSpan={n.attrs?.colspan} rowSpan={n.attrs?.rowspan}>{kids}</th>;
    case 'tableCell': return <td key={key} colSpan={n.attrs?.colspan} rowSpan={n.attrs?.rowspan}>{kids}</td>;
    case 'callout': { const k = n.attrs?.kind ?? 'note'; return <div key={key} className={`callout ${k}`} role={k === 'note' ? 'note' : 'alert'}><span className="ttl">{k === 'note' ? 'ℹ' : '⚠'} {CALLOUT[k]}</span><div>{kids}</div></div>; }
    default: return <span key={key}>{kids}</span>;
  }
}

export function DocBody({ doc }: { doc: PMNode }) {
  hCounter = 0;
  return <div className="prose">{(doc.content ?? []).map((n, i) => node(n, i))}</div>;
}

export function StepsView({ steps }: { steps: Step[] }) {
  if (!steps.length) return null;
  return (
    <section aria-label="手順">
      <h2 style={{ fontSize: '1.2rem' }}>手順</h2>
      <ol className="steps">
        {steps.map((s) => (
          <li key={s.id} id={`step-${s.id}`}>
            <div className="st-title">{s.title}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{s.instruction}</div>
            {s.imageId && <img src={`/api/attachments/${s.imageId}/content`} alt={s.title} style={{ maxWidth: '100%', borderRadius: 8, marginTop: 8 }} loading="lazy" />}
            {s.warning && <div className="callout warning"><span className="ttl">⚠ 注意</span><div>{s.warning}</div></div>}
            {s.expectedResult && <div className="small"><strong>期待される結果：</strong>{s.expectedResult}</div>}
            {!!s.checklist.length && <ul className="small" style={{ margin: '6px 0 0', paddingLeft: '1.2em' }}>{s.checklist.map((c, i) => <li key={i}>□ {c}</li>)}</ul>}
            {s.reference && <div className="subtle">参照：{s.reference}</div>}
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ChecklistView({ items }: { items: Content['checklistItems'] }) {
  if (!items.length) return null;
  return (
    <section aria-label="チェック項目">
      <h2 style={{ fontSize: '1.2rem' }}>チェック項目</h2>
      <ul className="list">{items.map((c) => <li key={c.id}>☐ {c.text} {!c.required && <span className="subtle">（任意）</span>}</li>)}</ul>
    </section>
  );
}

export function DocContent({ content }: { content: Content }) {
  return <><DocBody doc={content.body} /><StepsView steps={content.steps ?? []} /><ChecklistView items={content.checklistItems ?? []} /></>;
}
