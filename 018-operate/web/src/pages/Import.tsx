import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { DOC_TYPES } from '../labels';
import { Badge, Icon, PageHead, useAction } from '../ui';
import { useDirectory } from './common';

export default function Import() {
  const { deps } = useDirectory();
  const [batch, setBatch] = useState<any>(null);
  const [sel, setSel] = useState<Record<string, any>>({});
  const [created, setCreated] = useState<any[] | null>(null);
  const { busy, run } = useAction();
  const upload = (files: FileList) => run(async () => {
    const fd = new FormData();
    for (const f of Array.from(files).slice(0, 20)) fd.append('files', f);
    const r = await api.form('/api/import/preview', fd);
    setBatch(r); setCreated(null);
    setSel(Object.fromEntries(r.items.map((it: any) => [it.key, { include: it.valid, title: it.title ?? '', type: 'sop', departmentId: deps[0]?.id ?? '' }])));
  });
  return (
    <>
      <PageHead title="既存資料の取り込み" sub="Word（.docx）・PDF・Markdown・テキストから内容を読み取り、下書きを作ります。取り込んだだけでは公開されません。" />
      <div className="card">
        <ol className="small"><li>ファイルを選ぶ（最大20件）</li><li>読み取り結果（プレビュー）を確認する</li><li>取り込む文書を選んで「下書きを作成」</li><li>各下書きを編集し、レビュー・承認を経て公開</li></ol>
        <label className="btn primary" style={{ marginTop: 6 }}><Icon name="upload" />ファイルを選ぶ<input type="file" hidden multiple accept=".docx,.pdf,.md,.txt,.markdown" onChange={(e) => e.target.files && void upload(e.target.files)} /></label>
        <p className="subtle" style={{ marginTop: 8 }}>変換の精度は保証されません（表・段組み・画像は再現されないことがあります）。スキャンしたPDF（画像のみ）の文字読み取り（OCR）には対応していません。元のファイルは文書に添付として保存されます。</p>
      </div>
      {batch && !created && (
        <div className="card">
          <h2>読み取り結果</h2>
          {batch.items.map((it: any) => (
            <div key={it.key} className="card" style={{ opacity: it.valid ? 1 : 0.7 }}>
              <div className="row between"><strong>{it.filename}</strong>{it.valid ? <Badge tone="ok">取り込み可</Badge> : <Badge tone="danger">取り込み不可</Badge>}</div>
              {it.warnings.map((w: string) => <div key={w} className="alert warn" style={{ marginTop: 6 }}>{w}</div>)}
              {it.valid && <>
                <p className="subtle">{it.chars}文字 ・ 見出し{it.headings}個</p>
                <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: 10, borderRadius: 8, maxHeight: 160, overflow: 'auto', fontSize: '.82rem' }}>{it.preview}</pre>
                <div className="grid cols-4">
                  <label className="check"><input type="checkbox" checked={sel[it.key]?.include} onChange={(e) => setSel({ ...sel, [it.key]: { ...sel[it.key], include: e.target.checked } })} />取り込む</label>
                  <input type="text" aria-label="タイトル" value={sel[it.key]?.title} onChange={(e) => setSel({ ...sel, [it.key]: { ...sel[it.key], title: e.target.value } })} />
                  <select aria-label="種類" value={sel[it.key]?.type} onChange={(e) => setSel({ ...sel, [it.key]: { ...sel[it.key], type: e.target.value } })}>{Object.entries(DOC_TYPES).filter(([k]) => k !== 'template').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                  <select aria-label="部署" value={sel[it.key]?.departmentId} onChange={(e) => setSel({ ...sel, [it.key]: { ...sel[it.key], departmentId: e.target.value } })}>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
                </div>
              </>}
            </div>
          ))}
          <button className="btn primary" disabled={busy || !Object.values(sel).some((x: any) => x.include)} onClick={() => void run(async () => {
            const r = await api.post(`/api/import/${batch.id}/commit`, { items: batch.items.filter((it: any) => it.valid).map((it: any) => ({ key: it.key, ...sel[it.key], departmentId: sel[it.key].departmentId || null })) });
            setCreated(r.created);
          }, '下書きを作成しました')}>選んだファイルから下書きを作成</button>
        </div>
      )}
      {created && <div className="card"><h2>作成した下書き</h2><ul className="list">{created.map((c) => <li key={c.documentId}><Link to={`/documents/${c.documentId}/edit`}>{c.title}</Link></li>)}</ul></div>}
    </>
  );
}
