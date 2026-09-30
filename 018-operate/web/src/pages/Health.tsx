import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime } from '../labels';
import { DocStatus, Empty, Loaded, PageHead, Progress, Stat, Tabs, useLoad } from '../ui';

export default function Health() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'health' | 'search' | 'ai'>('health');
  const tabs: Array<['health' | 'search' | 'ai', string]> = [['health', 'ナレッジの状態']];
  if (can('analytics.read')) tabs.push(['search', '検索の分析']);
  if (can('ai.settings') || can('analytics.read')) tabs.push(['ai', 'AIの利用状況']);
  return (
    <>
      <PageHead title="ナレッジ状況" sub="マニュアル運用の状態を、記録された事実データで確認します。" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'health' && <KnowledgeHealth />}
      {tab === 'search' && <SearchAnalytics />}
      {tab === 'ai' && <AiUsage />}
    </>
  );
}

function KnowledgeHealth() {
  const st = useLoad(() => api.get('/api/health/knowledge'));
  return (
    <Loaded state={st}>{(h: any) => (
      <div className="stack" style={{ gap: 14 }}>
        <div className="grid cols-4">
          <Stat label="公開中の文書" value={h.documents.published} tone="blue" />
          <Stat label="定期レビュー期限切れ" value={`${h.documents.review_overdue}（${h.documents.reviewOverdueRate}%）`} tone={h.documents.review_overdue ? 'red' : undefined} to="/documents?reviewDue=overdue" />
          <Stat label="担当者不在の文書" value={h.documents.no_owner} tone={h.documents.no_owner ? 'amber' : undefined} />
          <Stat label="1年以上見直していない" value={h.documents.stale} tone={h.documents.stale ? 'amber' : undefined} />
          <Stat label="重要変更の未確認" value={`${h.majorChanges.pending}（${h.majorChanges.unacknowledgedRate}%）`} tone={h.majorChanges.overdue ? 'red' : undefined} to="/attestations" />
          <Stat label="研修の修了率" value={`${h.training.completionRate}%`} />
          <Stat label="研修の期限超過" value={h.training.overdue} tone={h.training.overdue ? 'red' : undefined} to="/manage/training?tab=report" />
          <Stat label="検索0件の割合（30日）" value={`${h.search.zeroResultRate}%`} />
        </div>
        <div className="grid cols-2">
          <section className="card"><h2>部署別</h2><table className="tbl"><thead><tr><th>部署</th><th>公開中</th><th>期限切れ</th></tr></thead><tbody>{h.byDepartment.map((d: any) => <tr key={d.name}><td>{d.name}</td><td>{d.published}</td><td>{d.overdue ? <span className="badge danger">{d.overdue}</span> : 0}</td></tr>)}</tbody></table></section>
          <section className="card"><h2>参照切れ（関連文書が廃止・置換）</h2>{h.brokenRelations.length ? <ul className="list">{h.brokenRelations.map((b: any, i: number) => <li key={i}><Link to={`/documents/${b.id}`}>{b.title}</Link> → {b.target_title} <DocStatus s={b.target_status} /></li>)}</ul> : <Empty>ありません</Empty>}</section>
        </div>
        <div className="card"><h2>検索後すぐ離脱した割合（30日）</h2><Progress value={h.search.quickExitRate} label="すぐ離脱した割合" /><p className="subtle">{h.search.quickExitRate}%（開いてから10秒以内に戻った検索）。内容が期待と違う可能性があります。</p></div>
        <p className="subtle">{h.note}</p>
      </div>
    )}</Loaded>
  );
}

function SearchAnalytics() {
  const st = useLoad(() => api.get('/api/analytics/search?days=30'));
  const nav = useNavigate();
  return (
    <Loaded state={st}>{(a: any) => (
      <div className="stack" style={{ gap: 14 }}>
        <section className="card"><h2>マニュアル作成の候補（検索しても見つからなかった言葉）</h2>
          {a.candidates.length ? <ul className="list">{a.candidates.map((c: any) => <li key={c.query} className="row between"><span><strong>{c.query}</strong> <span className="subtle">{c.count}回</span></span><button className="btn sm" onClick={() => nav('/documents/new')}>FAQ・SOPを作る</button></li>)}</ul> : <Empty>候補はありません</Empty>}
          <p className="subtle">候補は提案です。自動でマニュアルが作られたり公開されたりすることはありません。</p></section>
        <div className="grid cols-2">
          <section className="card"><h2>よく検索される言葉</h2><table className="tbl"><thead><tr><th>検索語</th><th>回数</th><th>平均件数</th><th>クリック</th></tr></thead><tbody>{a.top.map((t: any) => <tr key={t.query}><td>{t.query}</td><td>{t.n}</td><td>{t.avg_results}</td><td>{t.clicks}</td></tr>)}</tbody></table></section>
          <section className="card"><h2>よく開かれる文書</h2>{a.clicked.length ? <ul className="list">{a.clicked.map((c: any) => <li key={c.id}><Link to={`/documents/${c.id}`}>{c.title}</Link> <span className="subtle">{c.clicks}回</span></li>)}</ul> : <Empty>データなし</Empty>}</section>
        </div>
        <p className="subtle">{a.privacy}</p>
      </div>
    )}</Loaded>
  );
}

function AiUsage() {
  const st = useLoad(() => api.get('/api/ai/usage'));
  return (
    <Loaded state={st}>{(u: any) => (
      <div className="stack" style={{ gap: 14 }}>
        <div className="grid cols-4">
          <Stat label="今月の利用回数" value={u.month.requests} />
          <Stat label="根拠なしで回答しなかった" value={u.month.no_source} />
          <Stat label="今月の概算コスト" value={`$${Number(u.month.cost_usd).toFixed(2)}`} />
          <Stat label="月の予算上限" value={`$${u.settings.monthlyBudgetUsd}`} />
        </div>
        <section className="card"><h2>内訳</h2>{u.byKind.length ? <table className="tbl"><thead><tr><th>用途</th><th>提供元</th><th>モデル</th><th>回数</th><th>概算コスト</th></tr></thead><tbody>{u.byKind.map((k: any, i: number) => <tr key={i}><td>{({ answer: 'AI検索', draft: 'SOP下書き', quiz_draft: '問題案' } as any)[k.kind]}</td><td>{k.provider === 'local' ? '社内（外部送信なし）' : 'Anthropic'}</td><td>{k.model}</td><td>{k.n}</td><td>${Number(k.cost_usd).toFixed(3)}</td></tr>)}</tbody></table> : <Empty>今月の利用はありません</Empty>}</section>
        <p className="subtle">利用ログには質問文・回答文を保存していません（件数・トークン数・概算コストのみ）。最終更新 {fmtDateTime(new Date().toISOString())}</p>
      </div>
    )}</Loaded>
  );
}
