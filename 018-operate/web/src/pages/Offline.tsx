import { useEffect, useState } from 'react';
import { DocContent } from '../DocRenderer';
import { useOnline } from '../Layout';
import { fmtDate, fmtDateTime } from '../labels';
import { listOffline, recheckOffline, removeOffline, type OfflineDoc } from '../offline';
import { ClassBadge, Empty, Modal, PageHead, useAction } from '../ui';

export default function Offline() {
  const [docs, setDocs] = useState<OfflineDoc[] | null>(null);
  const [open, setOpen] = useState<OfflineDoc | null>(null);
  const online = useOnline();
  const { busy, run } = useAction();
  const load = () => listOffline().then(setDocs).catch(() => setDocs([]));
  useEffect(() => { void load(); }, []);
  return (
    <>
      <PageHead title="端末に保存した文書" sub="電波の届かない現場でも読めるよう、この端末に保存したマニュアルです。オンラインに戻ると最新版か自動で確認し、古い版は更新・廃止された文書は削除されます。">
        {online && <button className="btn" disabled={busy} onClick={() => void run(async () => { const r = await recheckOffline(); await load(); return r; }, '最新の状態を確認しました')}>今すぐ確認</button>}
      </PageHead>
      {docs === null ? null : docs.length ? (
        <ul className="list card">{docs.map((d) => (
          <li key={d.documentId} className="row between">
            <span><button className="btn ghost" style={{ padding: 0, minHeight: 0 }} onClick={() => setOpen(d)}>{d.docNumber} {d.title}</button><div className="row small"><span>v{d.version}</span><ClassBadge c={d.classification} /><span className="subtle">施行日 {fmtDate(d.effectiveDate)} ・ 保存 {fmtDateTime(d.savedAt)}</span></div></span>
            <button className="btn sm danger" onClick={() => void removeOffline(d.documentId).then(load)}>削除</button>
          </li>
        ))}</ul>
      ) : <Empty>保存した文書はありません。文書の画面で「端末に保存」を押すと保存できます（機密区分によっては保存できません）。</Empty>}
      {open && <Modal title={open.title} onClose={() => setOpen(null)} wide>
        <div className="alert warn" style={{ marginBottom: 10 }}>端末に保存したコピー（v{open.version}・{fmtDateTime(open.savedAt)} 時点）を表示しています。最新版とは異なる可能性があります。</div>
        <DocContent content={open.content} />
      </Modal>}
    </>
  );
}
