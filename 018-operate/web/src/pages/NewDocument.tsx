import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { DOC_TYPES } from '../labels';
import { Icon, PageHead, Tabs, useAction } from '../ui';
import { AudiencePicker, ClassificationSelect, useDirectory, type Audience } from './common';

export default function NewDocument() {
  const { me } = useAuth();
  const nav = useNavigate();
  const { deps, users } = useDirectory();
  const [mode, setMode] = useState<'blank' | 'ai'>('blank');
  const [templates, setTemplates] = useState<any[]>([]);
  const [f, setF] = useState({ type: 'sop', title: '', docNumber: '', summary: '', departmentId: me?.departmentIds[0] ?? '', classification: 'internal', templateId: '', category: '', tags: '' });
  const [aud, setAud] = useState<Audience>({ all: false, items: me?.departmentIds[0] ? [{ kind: 'department', target: me.departmentIds[0] }] : [] });
  const [source, setSource] = useState('');
  const { busy, run } = useAction();
  useEffect(() => { api.get('/api/templates').then(setTemplates).catch(() => undefined); }, []);
  useEffect(() => {
    const t = templates.find((x) => x.doc_type === f.type && x.is_default);
    setF((p) => ({ ...p, templateId: t?.id ?? '' }));
  }, [f.type, templates]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  const create = () => run(async () => {
    const body = {
      type: f.type, title: f.title, docNumber: f.docNumber || null, summary: f.summary, departmentId: f.departmentId || null, classification: f.classification,
      templateId: f.templateId || null, category: f.category, tags: f.tags.split(/[,、\s]+/).filter(Boolean), audienceAll: aud.all, audiences: aud.items,
    };
    const r = await api.post('/api/documents', body);
    nav(`/documents/${r.id}/edit`);
  });
  const aiDraft = () => run(async () => {
    const r = await api.post('/api/ai/draft-sop', { title: f.title, source, type: ['sop', 'guide', 'faq', 'checklist'].includes(f.type) ? f.type : 'sop', departmentId: f.departmentId || null, classification: f.classification });
    if (aud.items.length || aud.all) await api.patch(`/api/documents/${r.id}`, { audienceAll: aud.all, audiences: aud.items });
    nav(`/documents/${r.id}/edit`);
  }, 'AIが下書きを作成しました。内容を確認・修正してください');

  return (
    <div className="content narrow" style={{ padding: 0 }}>
      <PageHead title="新しいマニュアルを作る" sub="作成した文書は「下書き」です。レビュー・承認を経て公開されるまで、他の人には表示されません。" />
      <Tabs tabs={[['blank', 'テンプレートから作る'], ...(me?.policy.ai.draft ? [['ai', 'AIで既存資料から下書き'] as ['ai', string]] : [])]} value={mode} onChange={setMode} />
      <div className="card">
        <div className="grid cols-2">
          <div className="field"><label htmlFor="type">種類</label><select id="type" value={f.type} onChange={set('type')}>{Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <div className="hint">{me?.policy.docTypes[f.type]?.requireApproval ? '公開には承認が必要です' : '承認なしで公開できる種類です（AI下書きを除く）'}</div></div>
          <div className="field"><label htmlFor="num">文書番号（任意）</label><input id="num" type="text" value={f.docNumber} onChange={set('docNumber')} placeholder="例：CS-003" maxLength={40} /></div>
        </div>
        <div className="field"><label htmlFor="title">タイトル</label><input id="title" type="text" value={f.title} onChange={set('title')} maxLength={200} placeholder="例：返品受付の手順" required /></div>
        <div className="field"><label htmlFor="summary">概要（検索結果に表示）</label><input id="summary" type="text" value={f.summary} onChange={set('summary')} maxLength={1000} /></div>
        <div className="grid cols-2">
          <div className="field"><label htmlFor="dept">担当部署</label><select id="dept" value={f.departmentId} onChange={set('departmentId')}><option value="">（なし）</option>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
          <div className="field"><label htmlFor="cls">機密区分</label><ClassificationSelect value={f.classification} onChange={(v) => setF({ ...f, classification: v })} /></div>
        </div>
        <div className="grid cols-2">
          <div className="field"><label htmlFor="cat">カテゴリ</label><input id="cat" type="text" value={f.category} onChange={set('category')} maxLength={100} /></div>
          <div className="field"><label htmlFor="tags">タグ（カンマ区切り）</label><input id="tags" type="text" value={f.tags} onChange={set('tags')} /></div>
        </div>
        <div className="field"><label>配布先（誰が読めるか）</label><AudiencePicker value={aud} onChange={setAud} deps={deps} users={users} /></div>
        {mode === 'blank' ? (
          <>
            <div className="field"><label htmlFor="tpl">テンプレート</label><select id="tpl" value={f.templateId} onChange={set('templateId')}><option value="">白紙</option>{templates.filter((t) => t.doc_type === f.type).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              <div className="hint">テンプレートの内容をコピーして作成します。あとでテンプレートを変更しても、この文書は変わりません。</div></div>
            <div className="row"><button className="btn primary lg" disabled={busy || !f.title.trim()} onClick={() => void create()}>下書きを作成して編集する</button><Link to="/import" className="btn ghost">Word/PDFから取り込む</Link></div>
          </>
        ) : (
          <>
            <div className="field"><label htmlFor="src">元になる資料（箇条書き・メモ・既存マニュアルの本文）</label>
              <textarea id="src" style={{ minHeight: 220 }} value={source} onChange={(e) => setSource(e.target.value)} maxLength={60000} placeholder={'例：\n目的：返品を正しく受け付ける\n1. 返品理由を聞く\n2. 商品の状態を確認する\n注意 開封済みの場合は…'} />
              <div className="hint">AIは資料に書かれていないことを補いません。不明な点は「確認事項（TODO）」として残ります。{me?.policy.ai.provider === 'local' ? '（この組織の設定では社外のAIサービスへは送信されません）' : '（組織設定により、許可された機密区分の資料のみAIサービスへ送信されます）'}</div></div>
            <button className="btn cta lg" disabled={busy || !f.title.trim() || source.trim().length < 10} onClick={() => void aiDraft()}><Icon name="sparkle" />{busy ? '作成中…' : 'AIで下書きを作る'}</button>
          </>
        )}
      </div>
    </div>
  );
}
