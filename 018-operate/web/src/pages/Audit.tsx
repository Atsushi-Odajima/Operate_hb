import { useState } from 'react';
import { api, downloadExport, qs } from '../api';
import { fmtDateTime } from '../labels';
import { Empty, Icon, Loaded, PageHead, Tabs, useAction, useLoad } from '../ui';
import { useDirectory } from './common';

export default function Audit() {
  const [tab, setTab] = useState<'log' | 'package'>('package');
  return (
    <>
      <PageHead title="監査・レポート" sub="承認・公開・確認・研修・権限変更などの記録を検索し、監査用の資料をまとめて出力します。" />
      <Tabs tabs={[['package', '監査パッケージ出力'], ['log', '操作ログ']]} value={tab} onChange={setTab} />
      {tab === 'package' ? <PackageExport /> : <Log />}
    </>
  );
}

function PackageExport() {
  const { deps } = useDirectory();
  const y = new Date().getFullYear();
  const [f, setF] = useState({ from: `${y}-01-01`, to: new Date().toISOString().slice(0, 10), departmentId: '', includePdf: true });
  const { busy, run } = useAction();
  return (
    <div className="card">
      <p>指定した期間・部署について、次の内容を1つのZIPファイルにまとめます。</p>
      <ul className="small"><li>現行SOP一覧（版・公開日・施行日・次回レビュー）と各SOPのPDF</li><li>版の履歴・承認履歴（承認時の内容ハッシュ付き）・レビュー履歴</li><li>重要文書の確認記録・研修受講記録・改訂期限</li><li>操作ログの抜粋、各ファイルのSHA-256を記録した manifest.json</li></ul>
      <div className="grid cols-4">
        <div className="field"><label htmlFor="pf">開始日</label><input id="pf" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
        <div className="field"><label htmlFor="pt">終了日</label><input id="pt" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
        <div className="field"><label htmlFor="pd">部署</label><select id="pd" value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">すべて</option>{deps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></div>
        <div className="field"><label>&nbsp;</label><label className="check"><input type="checkbox" checked={f.includePdf} onChange={(e) => setF({ ...f, includePdf: e.target.checked })} />SOPのPDFを含める</label></div>
      </div>
      <div className="row"><button className="btn primary" disabled={busy} onClick={() => void run(() => downloadExport('audit-package', { ...f, departmentId: f.departmentId || null }), 'ダウンロードを開始しました')}><Icon name="download" />監査パッケージを出力</button>
        <button className="btn" disabled={busy} onClick={() => void run(() => downloadExport('audit-log', { from: f.from, to: f.to }))}>操作ログCSV</button></div>
      <p className="subtle" style={{ marginTop: 10 }}>出力は操作ログに記録されます。本機能は記録を整理して出力するもので、法令・規格への準拠を自動的に保証するものではありません。</p>
    </div>
  );
}

function Log() {
  const [f, setF] = useState({ action: '', actor: '', from: '', to: '' });
  const [applied, setApplied] = useState(f);
  const st = useLoad(() => api.get(`/api/audit${qs({ ...applied, limit: 200 })}`), [applied]);
  return (
    <>
      <form className="row card" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <select aria-label="操作の種類" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} style={{ width: 'auto' }}>
          <option value="">すべての操作</option>
          {[['auth.', 'ログイン'], ['document.', '文書'], ['version.', '版'], ['approval.', '承認'], ['review.', 'レビュー'], ['attestation.', '確認'], ['training.', '研修'], ['quiz.', 'テスト'], ['user.', 'ユーザー'], ['external.', '外部メンバー'], ['export.', '出力'], ['ai.', 'AI'], ['settings.', '設定'], ['backup.', 'バックアップ']].map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="text" aria-label="操作者" placeholder="操作者" value={f.actor} onChange={(e) => setF({ ...f, actor: e.target.value })} style={{ maxWidth: 180 }} />
        <input type="date" aria-label="開始日" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} style={{ maxWidth: 170 }} />
        <input type="date" aria-label="終了日" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} style={{ maxWidth: 170 }} />
        <button className="btn">絞り込み</button>
      </form>
      <Loaded state={st}>{(rows: any[]) => rows.length ? (
        <div className="card pad-0 table-wrap"><table className="tbl"><thead><tr><th>日時</th><th>操作者</th><th>操作</th><th>概要</th><th>IP</th></tr></thead><tbody>
          {rows.map((r) => <tr key={r.id}><td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.created_at)}</td><td className="small">{r.actor_label}</td><td><code className="small">{r.action}</code></td><td className="small">{r.summary}</td><td className="subtle">{r.ip}</td></tr>)}
        </tbody></table></div>
      ) : <Empty>該当する記録はありません</Empty>}</Loaded>
      <p className="subtle">操作ログは追記専用で、アプリケーションからは変更・削除できません。</p>
    </>
  );
}
