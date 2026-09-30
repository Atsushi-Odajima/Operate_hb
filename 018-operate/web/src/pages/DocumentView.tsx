import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, downloadExport } from '../api';
import { useAuth } from '../auth';
import { DocContent } from '../DocRenderer';
import { DOC_TYPES, FEEDBACK, fmtDate, REL, ROLES } from '../labels';
import { saveOffline } from '../offline';
import { AiBadge, AttestBadge, ChangeBadge, ClassBadge, DocStatus, Icon, Loaded, Modal, useAction, useLoad, useToast, VerStatus } from '../ui';
import { AudiencePicker, ClassificationSelect, useDirectory, type Audience } from './common';

export default function DocumentView() {
  const { id } = useParams();
  const { me, can } = useAuth();
  const nav = useNavigate();
  const st = useLoad(() => api.get(`/api/documents/${id}`), [id]);
  const { busy, run } = useAction();
  const { push } = useToast();
  const [modal, setModal] = useState<null | 'revise' | 'feedback' | 'settings' | 'retire' | 'relation' | 'attest' | 'impact'>(null);
  const [fbKind, setFbKind] = useState('outdated');
  const endRef = useRef<HTMLDivElement>(null);
  const att = st.data?.myAttestation;

  // Attestation: mark "viewed" on open and "reached_end" when the end of the document becomes visible.
  useEffect(() => {
    if (!att || att.status !== 'pending') return;
    void api.post(`/api/attestations/${att.id}/progress`, { what: 'viewed' }).catch(() => undefined);
    if (att.reached_end_at || !endRef.current) return;
    const ob = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) {
        ob.disconnect();
        void api.post(`/api/attestations/${att.id}/progress`, { what: 'reached_end' }).then((r) => st.setData((d: any) => ({ ...d, myAttestation: { ...d.myAttestation, ...r } }))).catch(() => undefined);
      }
    }, { threshold: 1 });
    ob.observe(endRef.current);
    return () => ob.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att?.id, att?.status]);

  return (
    <Loaded state={st}>{(d: any) => {
      const doc = d.document, cur = d.current, w = d.working;
      const overdue = doc.reviewOverdue;
      return (
        <article>
          <div className="row between" style={{ alignItems: 'flex-start', marginBottom: 8 }}>
            <div style={{ minWidth: 0 }}>
              <div className="row small" style={{ marginBottom: 4 }}>
                {doc.docNumber && <span className="chip">{doc.docNumber}</span>}<span className="chip">{DOC_TYPES[doc.type]}</span><ClassBadge c={doc.classification} /><DocStatus s={doc.status} />
                {cur?.aiGenerated && <AiBadge />}
              </div>
              <h1 style={{ marginBottom: 4 }}>{cur?.title ?? doc.title}</h1>
              <div className="doc-meta">
                {cur && <span><strong>v{cur.version}</strong> ・ 施行日 {fmtDate(cur.effectiveDate)} ・ 公開 {fmtDate(cur.publishedAt)}</span>}
                <span>担当 {doc.owner?.name ?? '未設定'}{doc.department && `（${doc.department.name}）`}</span>
                {doc.nextReviewDate && <span>次回レビュー {fmtDate(doc.nextReviewDate)}</span>}
              </div>
            </div>
            <div className="row no-print">
              {cur && (cur.content.steps?.length > 0 || cur.content.checklistItems?.length > 0) && !me?.isExternal && <Link className="btn primary" to={`/documents/${doc.id}/run`}><Icon name="play" size={16} />{cur.content.checklistItems?.length ? 'チェックリストを実行' : 'ステップ表示で実行'}</Link>}
              {d.can.edit && (w ? <Link className="btn" to={`/documents/${doc.id}/edit`}><Icon name="edit" size={16} />編集中の v{w.version} を開く</Link> : cur && <button className="btn" onClick={() => setModal('revise')}><Icon name="edit" size={16} />改訂する</button>)}
              {d.can.history && <Link className="btn" to={`/documents/${doc.id}/history`}><Icon name="history" size={16} />版の履歴</Link>}
            </div>
          </div>

          {overdue && (me?.policy.overduePolicy === 'banner' || d.can.edit) && <div className="alert warn" style={{ marginBottom: 10 }}><Icon name="alert" /> この文書は定期レビューの期限（{fmtDate(doc.nextReviewDate)}）を過ぎています。内容が最新か担当者が確認中です。{d.can.reviewConfirm && <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => void run(async () => { await api.post(`/api/documents/${doc.id}/review-confirm`, { note: '' }); st.reload(); }, '次回レビュー日を更新しました')}>変更なしで再確認</button>}</div>}
          {doc.status === 'retired' && <div className="alert danger" style={{ marginBottom: 10 }}>この文書は廃止されています。業務には使用しないでください。</div>}
          {doc.status === 'superseded' && <div className="alert warn" style={{ marginBottom: 10 }}>この文書は別の文書に置き換えられました。</div>}
          {w && d.can.edit && <div className="alert info" style={{ marginBottom: 10 }}>改訂版 v{w.version} が <VerStatus s={w.status} /> です。公開されるまで、利用者には現在の v{cur?.version ?? '—'} が表示されます。</div>}
          {!cur && <div className="alert info" style={{ marginBottom: 10 }}>まだ公開されていない文書です。{w && <Link to={`/documents/${doc.id}/edit`}>下書き v{w.version} を開く</Link>}</div>}

          {att && (
            <section className="card no-print" aria-labelledby="att-h" style={{ borderColor: att.status === 'pending' ? '#fde68a' : undefined, background: att.status === 'pending' ? 'var(--warn-bg)' : undefined, marginBottom: 12 }}>
              <div className="row between"><h2 id="att-h" style={{ margin: 0 }}>内容の確認</h2><AttestBadge s={att.status} /></div>
              {att.status === 'pending' ? (
                <>
                  <p style={{ margin: '6px 0' }}>この版（v{cur.version}）を最後まで読み、内容を確認したら「確認しました」を押してください。期限：{fmtDate(att.due_date)}</p>
                  {cur.changeType === 'major' && cur.changeSummary && <p className="small"><ChangeBadge c="major" /> 変更点：{cur.changeSummary}</p>}
                  <p className="subtle">※「確認しました」は、あなたが内容を読んだことの記録です。理解度の証明ではありません。</p>
                  {!att.reached_end_at && att.require_scroll && <p className="subtle">↓ 文書の最後まで表示すると押せるようになります。</p>}
                </>
              ) : <p style={{ margin: '6px 0' }}>{fmtDate(att.acknowledged_at)} に確認済みです。</p>}
            </section>
          )}

          {cur ? (
            <div className="card">
              {doc.purpose && <p className="muted"><strong>目的：</strong>{doc.purpose}</p>}
              <DocContent content={cur.content} />
              <div ref={endRef} aria-hidden style={{ height: 1 }} />
              <div className="subtle" style={{ borderTop: '1px solid var(--line)', marginTop: 16, paddingTop: 8 }}>— 文書の終わり（v{cur.version}） —</div>
            </div>
          ) : null}

          {att?.status === 'pending' && (
            <div className="card no-print" style={{ marginTop: 12, textAlign: 'center' }}>
              <button className="btn primary lg" disabled={busy || (att.require_scroll && !att.reached_end_at)} onClick={() => void run(async () => {
                const r = await api.post(`/api/attestations/${att.id}/acknowledge`);
                st.setData((x: any) => ({ ...x, myAttestation: { ...x.myAttestation, ...r } }));
              }, '確認を記録しました')}><Icon name="check" />確認しました</button>
            </div>
          )}

          {cur && (
            <div className="grid cols-2 no-print" style={{ marginTop: 14 }}>
              <section className="card" aria-labelledby="fb-h">
                <h2 id="fb-h">このマニュアルについて</h2>
                <div className="row">
                  <button className="btn sm" onClick={() => void run(() => api.post(`/api/documents/${doc.id}/feedback`, { kind: 'helpful' }), 'ありがとうございます！')}>👍 役に立った</button>
                  {['outdated', 'unclear', 'suggestion'].map((k) => <button key={k} className="btn sm" onClick={() => { setFbKind(k); setModal('feedback'); }}>{FEEDBACK[k]}</button>)}
                </div>
                <p className="subtle" style={{ marginTop: 8 }}>フィードバックは担当者に届きます。本文が直接書き換わることはありません。</p>
                <div className="divider" />
                <div className="row">
                  {d.can.download && <button className="btn sm" onClick={() => void run(() => downloadExport('document-pdf', { documentId: doc.id }))}><Icon name="download" size={16} />PDF</button>}
                  {d.can.offline ? <button className="btn sm" onClick={() => void run(async () => { await saveOffline(doc.id); }, 'この端末に保存しました（オフラインで閲覧できます）')}><Icon name="download" size={16} />端末に保存</button>
                    : <span className="subtle">この機密区分はオフライン保存できません</span>}
                </div>
              </section>
              <section className="card" aria-labelledby="rel-h">
                <div className="row between"><h2 id="rel-h">関連文書</h2>{d.can.edit && <button className="btn sm" onClick={() => setModal('relation')}>追加</button>}</div>
                {d.relations.length ? <ul className="list">{d.relations.map((r: any) => (
                  <li key={r.id + r.dir} className="row between">
                    <span><span className="chip">{r.dir === 'out' ? REL[r.kind] : `被参照（${REL[r.kind]}）`}</span> <Link to={`/documents/${r.document_id}`}>{r.doc_number} {r.title}</Link> {['retired', 'superseded'].includes(r.status) && <DocStatus s={r.status} />}</span>
                    {d.can.edit && r.dir === 'out' && <button className="btn ghost sm" onClick={() => void run(async () => { await api.del(`/api/relations/${r.id}`); st.reload(); })}>外す</button>}
                  </li>))}</ul> : <p className="subtle">関連文書はありません</p>}
                {d.can.edit && <button className="btn ghost sm" onClick={() => setModal('impact')}>この文書を変更すると影響する文書</button>}
              </section>
            </div>
          )}

          {(d.can.edit || d.can.admin) && (
            <section className="card no-print" style={{ marginTop: 14 }} aria-labelledby="mg-h">
              <h2 id="mg-h">管理</h2>
              <dl className="kv">
                <dt>配布先</dt><dd>{doc.audienceAll ? '全社' : ''} {d.audiences.map((a: any) => <span key={a.kind + a.target} className="chip" style={{ marginRight: 4 }}>{a.kind === 'role' ? `役割:${ROLES[a.target]}` : a.label ?? a.target}</span>)}{!doc.audienceAll && !d.audiences.length && '担当者のみ'}</dd>
                <dt>レビュー周期</dt><dd>{doc.reviewCycleDays ? `${doc.reviewCycleDays}日` : '設定なし'}（最終 {fmtDate(doc.lastReviewedAt)}）</dd>
                <dt>重要文書の確認</dt><dd>{doc.requiresAttestation ? '公開時に対象者へ確認を依頼' : 'なし（重要な変更時は改訂ごとに指定）'}</dd>
              </dl>
              <div className="row" style={{ marginTop: 10 }}>
                <button className="btn sm" onClick={() => setModal('settings')}><Icon name="settings" size={16} />配布先・区分・周期を変更</button>
                {can('attestation.manage') && cur && <button className="btn sm" onClick={() => setModal('attest')}>確認依頼を配布</button>}
                {d.can.retire && doc.status !== 'retired' && <button className="btn sm danger" onClick={() => setModal('retire')}>廃止する</button>}
              </div>
            </section>
          )}

          {modal === 'revise' && <ReviseModal docId={doc.id} onClose={() => setModal(null)} onDone={() => nav(`/documents/${doc.id}/edit`)} />}
          {modal === 'feedback' && <FeedbackModal docId={doc.id} kind={fbKind} onClose={() => setModal(null)} />}
          {modal === 'settings' && <SettingsModal d={d} onClose={() => setModal(null)} onDone={() => { setModal(null); st.reload(); }} />}
          {modal === 'retire' && <RetireModal docId={doc.id} onClose={() => setModal(null)} onDone={() => { setModal(null); st.reload(); push('文書を廃止しました'); }} />}
          {modal === 'relation' && <RelationModal docId={doc.id} onClose={() => setModal(null)} onDone={() => { setModal(null); st.reload(); }} />}
          {modal === 'attest' && <AttestModal docId={doc.id} onClose={() => setModal(null)} />}
          {modal === 'impact' && <ImpactModal docId={doc.id} onClose={() => setModal(null)} />}
        </article>
      );
    }}</Loaded>
  );
}

function ReviseModal({ docId, onClose, onDone }: { docId: string; onClose: () => void; onDone: () => void }) {
  const [t, setT] = useState<'minor' | 'normal' | 'major'>('normal');
  const { busy, run } = useAction();
  const opts: Array<[typeof t, string, string]> = [
    ['minor', '軽微な修正', '誤字・表現の修正など。版番号は 1.0 → 1.1'],
    ['normal', '通常の改訂', '手順の追加・変更。版番号は 1.0 → 1.1'],
    ['major', '重要な変更', 'ルール・手順の大きな変更。版番号は 1.0 → 2.0。対象者に再確認を依頼できます'],
  ];
  return (
    <Modal title="改訂版を作成" onClose={onClose}>
      <p className="muted">公開中の版はそのまま残り、コピーした新しい下書きを編集します。承認されて公開されるまで、利用者には現在の版が表示されます。</p>
      <div className="stack" role="radiogroup" aria-label="変更の大きさ">
        {opts.map(([k, l, h]) => <label key={k} className="check card" style={{ margin: 0 }}><input type="radio" name="ct" checked={t === k} onChange={() => setT(k)} /><span><strong>{l}</strong><br /><span className="subtle">{h}</span></span></label>)}
      </div>
      <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button><button className="btn primary" disabled={busy} onClick={() => void run(async () => { await api.post(`/api/documents/${docId}/revisions`, { changeType: t }); onDone(); })}>下書きを作成</button></div>
    </Modal>
  );
}

function FeedbackModal({ docId, kind, onClose }: { docId: string; kind: string; onClose: () => void }) {
  const [body, setBody] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title={`フィードバック：${FEEDBACK[kind]}`} onClose={onClose}>
      <div className="field"><label htmlFor="fb">内容</label><textarea id="fb" value={body} onChange={(e) => setBody(e.target.value)} maxLength={3000} placeholder="どこが、どのように違う／分かりにくいかを書いてください" /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button><button className="btn primary" disabled={busy || !body.trim()} onClick={() => void run(async () => { await api.post(`/api/documents/${docId}/feedback`, { kind, body }); onClose(); }, '担当者に送信しました')}>送信</button></div>
    </Modal>
  );
}

function SettingsModal({ d, onClose, onDone }: { d: any; onClose: () => void; onDone: () => void }) {
  const { deps, users } = useDirectory();
  const doc = d.document;
  const [cls, setCls] = useState(doc.classification);
  const [aud, setAud] = useState<Audience>({ all: doc.audienceAll, items: d.audiences });
  const [cycle, setCycle] = useState<string>(doc.reviewCycleDays ? String(doc.reviewCycleDays) : '');
  const [reqAtt, setReqAtt] = useState<boolean>(doc.requiresAttestation);
  const [owner, setOwner] = useState<string>(doc.owner?.id ?? '');
  const { busy, run } = useAction();
  const aclLocked = doc.status !== 'draft' && !d.can.admin;
  return (
    <Modal title="配布先・区分・レビュー周期" onClose={onClose} wide>
      {aclLocked && <div className="alert info" style={{ marginBottom: 10 }}>公開後の配布先・機密区分の変更はナレッジ管理者が行います。</div>}
      <div className="grid cols-2">
        <div className="field"><label htmlFor="s-cls">機密区分</label><fieldset disabled={aclLocked} style={{ border: 0, padding: 0 }}><ClassificationSelect id="s-cls" value={cls} onChange={setCls} /></fieldset></div>
        <div className="field"><label htmlFor="s-cycle">定期レビュー周期</label>
          <select id="s-cycle" value={cycle} onChange={(e) => setCycle(e.target.value)}><option value="">設定しない</option>{[30, 90, 180, 365].map((n) => <option key={n} value={n}>{n}日</option>)}{cycle && ![30, 90, 180, 365].includes(Number(cycle)) && <option value={cycle}>{cycle}日</option>}</select>
          <div className="hint">期限が過ぎても自動で非公開にはなりません。担当者に通知されます。</div></div>
      </div>
      <div className="grid cols-2">
        <div className="field"><label htmlFor="s-owner">担当者（オーナー）</label><select id="s-owner" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">未設定</option>{users.filter((u) => !u.is_external).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
        <div className="field"><label>&nbsp;</label><label className="check"><input type="checkbox" checked={reqAtt} onChange={(e) => setReqAtt(e.target.checked)} />重要文書として、公開時に対象者へ「確認しました」を依頼する</label></div>
      </div>
      <div className="field"><label>配布先</label><AudiencePicker value={aud} onChange={setAud} deps={deps} users={users} disabled={aclLocked} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button>
        <button className="btn primary" disabled={busy} onClick={() => void run(async () => {
          const body: any = { reviewCycleDays: cycle ? Number(cycle) : null, requiresAttestation: reqAtt, ownerId: owner || null };
          if (!aclLocked) Object.assign(body, { classification: cls, audienceAll: aud.all, audiences: aud.items });
          await api.patch(`/api/documents/${doc.id}`, body);
          onDone();
        }, '保存しました')}>保存</button></div>
    </Modal>
  );
}

function RetireModal({ docId, onClose, onDone }: { docId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  return (
    <Modal title="文書を廃止する" onClose={onClose}>
      <p>廃止すると、検索・AI回答・一覧に表示されなくなります。履歴（版・承認・確認記録）は残ります。この文書を参照している文書の担当者に通知されます。</p>
      <div className="field"><label htmlFor="rr">廃止理由</label><input id="rr" type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button><button className="btn danger solid" disabled={busy || !reason.trim()} onClick={() => void run(async () => { await api.post(`/api/documents/${docId}/retire`, { reason }); onDone(); })}>廃止する</button></div>
    </Modal>
  );
}

function RelationModal({ docId, onClose, onDone }: { docId: string; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('related');
  const [res, setRes] = useState<any[]>([]);
  const { busy, run } = useAction();
  useEffect(() => { const t = setTimeout(() => api.get(`/api/documents?view=published&q=${encodeURIComponent(q)}&limit=20`).then((r) => setRes(r.items.filter((x: any) => x.id !== docId))).catch(() => undefined), 250); return () => clearTimeout(t); }, [q, docId]);
  return (
    <Modal title="関連文書を追加" onClose={onClose}>
      <div className="field"><label htmlFor="rk">関係</label><select id="rk" value={kind} onChange={(e) => setKind(e.target.value)}>{Object.entries(REL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
      <div className="field"><label htmlFor="rq">文書を探す</label><input id="rq" type="search" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <ul className="list">{res.map((r) => <li key={r.id} className="row between"><span>{r.doc_number} {r.title}</span><button className="btn sm" disabled={busy} onClick={() => void run(async () => { await api.post(`/api/documents/${docId}/relations`, { toDocumentId: r.id, kind }); onDone(); }, '追加しました')}>追加</button></li>)}</ul>
    </Modal>
  );
}

function AttestModal({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [due, setDue] = useState(new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10));
  const [reason, setReason] = useState('内容の確認をお願いします');
  const { busy, run } = useAction();
  return (
    <Modal title="確認依頼を配布" onClose={onClose}>
      <p className="muted">現在の公開版について、配布先の全員に「読んで確認しました」を依頼します。すでにこの版を確認済みの人には再依頼されません。</p>
      <div className="field"><label htmlFor="ad">期限</label><input id="ad" type="date" value={due} onChange={(e) => setDue(e.target.value)} /></div>
      <div className="field"><label htmlFor="ar">依頼の理由</label><input id="ar" type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>キャンセル</button><button className="btn primary" disabled={busy} onClick={() => void run(async () => { const r = await api.post(`/api/documents/${docId}/attestations`, { dueDate: due, reason }); onClose(); return r; }, '確認依頼を配布しました')}>配布する</button></div>
    </Modal>
  );
}

function ImpactModal({ docId, onClose }: { docId: string; onClose: () => void }) {
  const st = useLoad(() => api.get(`/api/documents/${docId}/impact`), [docId]);
  return (
    <Modal title="この文書を変更すると影響する文書" onClose={onClose}>
      <Loaded state={st}>{(r: any[]) => r.length ? <ul className="list">{r.map((x) => <li key={x.id}><Link to={`/documents/${x.id}`} onClick={onClose}>{x.doc_number} {x.title}</Link> <span className="chip">{REL[x.kind]}</span>{x.depth > 1 && <span className="subtle">（間接 {x.depth}段）</span>}</li>)}</ul> : <p className="subtle">この文書を参照している文書はありません。</p>}</Loaded>
    </Modal>
  );
}
