import { mergeAttributes, Node } from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { EditorContent, useEditor, type Editor as TEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';
import { api } from './api';
import type { Content, PMNode, Step } from './DocRenderer';
import { useToast } from './ui';

/** Callout (注意/警告/補足) block — mirrors the server whitelist node "callout". */
const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { kind: { default: 'note', parseHTML: (el) => el.getAttribute('data-kind') ?? 'note', renderHTML: (a) => ({ 'data-kind': a.kind }) } };
  },
  parseHTML() { return [{ tag: 'div[data-callout]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: `callout ${HTMLAttributes['data-kind'] ?? 'note'}` }), 0];
  },
});

export function useDocEditor(initial: PMNode, onChange: (doc: PMNode) => void, editable = true) {
  return useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3, 4] }, link: { openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'], isAllowedUri: (url) => /^(https?:\/\/|mailto:|\/(?!\/))/i.test(url) } }),
      Highlight, TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: false } }),
      Image.configure({ inline: false, allowBase64: false }), Callout,
    ],
    content: initial,
    editable,
    // pasted HTML is parsed through the ProseMirror schema: scripts, styles, event handlers and unknown tags are dropped.
    editorProps: { attributes: { 'aria-label': '本文', 'aria-multiline': 'true', role: 'textbox' } },
    onUpdate: ({ editor }) => onChange(editor.getJSON() as PMNode),
  });
}

function Btn({ on, label, onClick, children }: { on?: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return <button type="button" className={on ? 'on' : ''} title={label} aria-label={label} aria-pressed={on} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{children}</button>;
}

export function Toolbar({ editor, documentId }: { editor: TEditor | null; documentId: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const { push } = useToast();
  if (!editor) return null;
  const c = () => editor.chain().focus();
  const upload = async (f: File) => {
    const fd = new FormData();
    fd.append('kind', 'image');
    fd.append('file', f);
    try {
      const r = await api.form<{ url: string }>(`/api/documents/${documentId}/attachments`, fd);
      c().setImage({ src: r.url, alt: f.name.replace(/\.[^.]+$/, '') }).run();
    } catch (e: any) { push(e.message, true); }
  };
  return (
    <div className="editor-toolbar" role="toolbar" aria-label="書式">
      <Btn label="見出し" on={editor.isActive('heading', { level: 2 })} onClick={() => c().toggleHeading({ level: 2 }).run()}>見出し</Btn>
      <Btn label="小見出し" on={editor.isActive('heading', { level: 3 })} onClick={() => c().toggleHeading({ level: 3 }).run()}>小見出し</Btn>
      <span className="sep" />
      <Btn label="太字" on={editor.isActive('bold')} onClick={() => c().toggleBold().run()}><b>B</b></Btn>
      <Btn label="下線" on={editor.isActive('underline')} onClick={() => c().toggleUnderline().run()}><u>U</u></Btn>
      <Btn label="マーカー" on={editor.isActive('highlight')} onClick={() => c().toggleHighlight().run()}><mark>M</mark></Btn>
      <Btn label="リンク" on={editor.isActive('link')} onClick={() => {
        const url = window.prompt('リンク先URL（https:// / mailto: / 社内パス）', editor.getAttributes('link').href ?? 'https://');
        if (url === null) return;
        if (!url) c().unsetLink().run(); else c().extendMarkRange('link').setLink({ href: url }).run();
      }}>リンク</Btn>
      <span className="sep" />
      <Btn label="箇条書き" on={editor.isActive('bulletList')} onClick={() => c().toggleBulletList().run()}>・</Btn>
      <Btn label="番号付き" on={editor.isActive('orderedList')} onClick={() => c().toggleOrderedList().run()}>1.</Btn>
      <Btn label="チェック項目" on={editor.isActive('taskList')} onClick={() => c().toggleTaskList().run()}>☑</Btn>
      <Btn label="表" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>表</Btn>
      {editor.isActive('table') && <>
        <Btn label="行を追加" onClick={() => c().addRowAfter().run()}>+行</Btn>
        <Btn label="列を追加" onClick={() => c().addColumnAfter().run()}>+列</Btn>
        <Btn label="表を削除" onClick={() => c().deleteTable().run()}>表削除</Btn>
      </>}
      <span className="sep" />
      <Btn label="注意" on={editor.isActive('callout', { kind: 'warning' })} onClick={() => c().wrapIn('callout', { kind: 'warning' }).run()}>⚠注意</Btn>
      <Btn label="補足" on={editor.isActive('callout', { kind: 'note' })} onClick={() => c().wrapIn('callout', { kind: 'note' }).run()}>ℹ補足</Btn>
      <Btn label="引用" on={editor.isActive('blockquote')} onClick={() => c().toggleBlockquote().run()}>引用</Btn>
      <Btn label="コード" on={editor.isActive('codeBlock')} onClick={() => c().toggleCodeBlock().run()}>{'</>'}</Btn>
      <Btn label="画像" onClick={() => fileRef.current?.click()}>画像</Btn>
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
      <span className="sep" />
      <Btn label="元に戻す" onClick={() => c().undo().run()}>↶</Btn>
      <Btn label="やり直す" onClick={() => c().redo().run()}>↷</Btn>
    </div>
  );
}

export function RichEditor({ value, onChange, documentId }: { value: PMNode; onChange: (d: PMNode) => void; documentId: string }) {
  const editor = useDocEditor(value, onChange);
  const loaded = useRef(false);
  useEffect(() => {
    if (editor && !loaded.current) { loaded.current = true; }
  }, [editor]);
  return (
    <div>
      <Toolbar editor={editor} documentId={documentId} />
      <div className="editor-box prose"><EditorContent editor={editor} /></div>
    </div>
  );
}

// ------------------------------------------------------------------ Step SOP editor
const newStep = (n: number): Step => ({ id: `s${Date.now().toString(36)}${n}`, title: '', instruction: '', warning: '', expectedResult: '', imageId: null, checklist: [], reference: '' });

export function StepsEditor({ steps, onChange, documentId }: { steps: Step[]; onChange: (s: Step[]) => void; documentId: string }) {
  const { push } = useToast();
  const set = (i: number, patch: Partial<Step>) => onChange(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: number) => { const a = [...steps]; const [x] = a.splice(i, 1); a.splice(i + d, 0, x); onChange(a); };
  const upload = async (i: number, f: File) => {
    const fd = new FormData();
    fd.append('kind', 'image');
    fd.append('file', f);
    try { const r = await api.form<{ id: string }>(`/api/documents/${documentId}/attachments`, fd); set(i, { imageId: r.id }); } catch (e: any) { push(e.message, true); }
  };
  return (
    <div className="stack">
      {steps.map((s, i) => (
        <div key={s.id} className="step-editor">
          <div className="row between">
            <strong>手順 {i + 1}</strong>
            <div className="row">
              <button type="button" className="btn sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`手順${i + 1}を上へ`}>↑</button>
              <button type="button" className="btn sm" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label={`手順${i + 1}を下へ`}>↓</button>
              <button type="button" className="btn sm danger" onClick={() => onChange(steps.filter((_, j) => j !== i))}>削除</button>
            </div>
          </div>
          <div className="grid cols-2" style={{ marginTop: 8 }}>
            <div className="field"><label htmlFor={`st-t-${s.id}`}>タイトル</label><input id={`st-t-${s.id}`} type="text" value={s.title} maxLength={200} onChange={(e) => set(i, { title: e.target.value })} placeholder="例：本人確認をする" /></div>
            <div className="field"><label htmlFor={`st-e-${s.id}`}>期待される結果</label><input id={`st-e-${s.id}`} type="text" value={s.expectedResult} maxLength={1000} onChange={(e) => set(i, { expectedResult: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor={`st-i-${s.id}`}>やること</label><textarea id={`st-i-${s.id}`} value={s.instruction} maxLength={5000} onChange={(e) => set(i, { instruction: e.target.value })} /></div>
          <div className="grid cols-2">
            <div className="field"><label htmlFor={`st-w-${s.id}`}>注意・警告</label><input id={`st-w-${s.id}`} type="text" value={s.warning} maxLength={1000} onChange={(e) => set(i, { warning: e.target.value })} /></div>
            <div className="field"><label htmlFor={`st-r-${s.id}`}>参照</label><input id={`st-r-${s.id}`} type="text" value={s.reference} maxLength={500} onChange={(e) => set(i, { reference: e.target.value })} /></div>
          </div>
          <div className="field"><label htmlFor={`st-c-${s.id}`}>確認項目（1行に1つ）</label><textarea id={`st-c-${s.id}`} style={{ minHeight: 60 }} value={s.checklist.join('\n')} onChange={(e) => set(i, { checklist: e.target.value.split('\n').slice(0, 30) })} /></div>
          <div className="row">
            {s.imageId ? <><img src={`/api/attachments/${s.imageId}/content`} alt="" style={{ height: 60, borderRadius: 6 }} /><button type="button" className="btn sm" onClick={() => set(i, { imageId: null })}>画像を外す</button></> :
              <label className="btn sm" style={{ margin: 0 }}>画像を追加<input type="file" hidden accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(i, f); }} /></label>}
          </div>
        </div>
      ))}
      <button type="button" className="btn" onClick={() => onChange([...steps, newStep(steps.length)])}>＋ 手順を追加</button>
    </div>
  );
}

export function ChecklistEditor({ items, onChange }: { items: Content['checklistItems']; onChange: (x: Content['checklistItems']) => void }) {
  return (
    <div className="stack">
      {items.map((it, i) => (
        <div key={it.id} className="row" style={{ flexWrap: 'nowrap' }}>
          <input type="text" aria-label={`チェック項目${i + 1}`} value={it.text} maxLength={300} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
          <label className="check" style={{ whiteSpace: 'nowrap' }}><input type="checkbox" checked={it.required} onChange={(e) => onChange(items.map((x, j) => (j === i ? { ...x, required: e.target.checked } : x)))} />必須</label>
          <button type="button" className="btn sm danger" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`チェック項目${i + 1}を削除`}>削除</button>
        </div>
      ))}
      <button type="button" className="btn" onClick={() => onChange([...items, { id: `c${Date.now().toString(36)}`, text: '', required: true }])}>＋ チェック項目を追加</button>
    </div>
  );
}
