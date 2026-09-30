/**
 * E2E-1 〜 E2E-7, E2E-9, E2E-10 (desktop). E2E-8 is in mobile.spec.ts (iPhone / Android / iPad).
 * Runs against a freshly seeded database ("Sample Works株式会社") through the real UI.
 */
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import pg from 'pg';
import yauzl from 'yauzl';
import { apiCall, dialog, loginAs, waitFor } from './helpers';

test.describe.configure({ mode: 'serial' });

const S: { docId?: string; docTitle: string; quizId?: string; courseTitle: string } = { docTitle: `電話での住所変更受付 ${Date.now().toString(36)}`, courseTitle: '住所変更 研修' };

async function openInboxItem(page: Page, title: string) {
  await page.goto('/inbox');
  await page.getByRole('link', { name: title }).first().click();
  await expect(page.getByRole('heading', { name: /レビュー・承認/ })).toBeVisible();
}

async function submitForApproval(page: Page, opts: { reviewer?: string; approver: string; scheduled?: boolean }) {
  await page.getByRole('button', { name: 'レビュー・承認に提出' }).click();
  const d = dialog(page);
  if (opts.reviewer) await d.getByRole('group', { name: 'レビュー担当' }).getByLabel(opts.reviewer).check();
  await d.getByRole('group', { name: 'ステップ1の承認者' }).getByLabel(opts.approver).check();
  if (opts.scheduled) {
    await d.locator('#pm').selectOption('scheduled');
    const t = new Date(Date.now() + 90_000 + 9 * 3600_000); // local (Asia/Tokyo) wall clock, next minute or later
    await d.locator('#pa').fill(t.toISOString().slice(0, 16));
  }
  await d.getByRole('button', { name: '提出する' }).click();
  await expect(d).toBeHidden();
}

test('E2E-1: SOP作成 → レビュー → 修正依頼 → 修正 → 承認 → 指定日公開 → 検索 → 閲覧 → 確認', async ({ browser }) => {
  test.setTimeout(300_000);
  const editor = await loginAs(browser, 'editor');
  const reviewer = await loginAs(browser, 'approver');
  const approver = await loginAs(browser, 'approver2');
  const member = await loginAs(browser, 'member-cs');
  const admin = await loginAs(browser, 'admin');

  // Editor creates v1 from the standard SOP template
  const p = editor.page;
  await p.goto('/documents/new');
  await p.locator('#title').fill(S.docTitle);
  await p.locator('#summary').fill('電話で住所変更の依頼を受けたときの手順');
  await p.getByRole('button', { name: '下書きを作成して編集する' }).click();
  await expect(p).toHaveURL(/\/documents\/[0-9a-f-]+\/edit$/);
  S.docId = p.url().split('/')[4];
  await p.locator('.ProseMirror').click();
  await p.keyboard.press('Control+End');
  await p.keyboard.type('本人確認のうえ、新しい住所を復唱して登録します。');
  await p.locator('#st-t-s1').fill('本人確認をする');
  await p.locator('#st-i-s1').fill('氏名・生年月日・登録電話番号の3点で本人確認をします。');
  await p.getByRole('button', { name: '＋ 手順を追加' }).click();
  await p.getByLabel('タイトル').last().fill('新住所を登録する');
  await p.getByRole('button', { name: '保存', exact: true }).click();
  await expect(p.getByText(/自動保存しました|保存しました/).first()).toBeVisible();
  await submitForApproval(p, { reviewer: '鈴木 健（CS部長）', approver: '高橋 誠（管理部長）' });
  await expect(p.getByText('レビュー中').first()).toBeVisible();

  // Reviewer requests changes (comment is recorded against this version)
  await openInboxItem(reviewer.page, S.docTitle);
  await reviewer.page.getByRole('button', { name: '修正を依頼' }).click();
  await dialog(reviewer.page).locator('#dc').fill('手順2に「住所を復唱する」を追記してください');
  await dialog(reviewer.page).getByRole('button', { name: '修正依頼する' }).click();
  await expect(reviewer.page.getByText('修正依頼').first()).toBeVisible();

  // Editor fixes and resubmits (scheduled publish)
  await p.goto(`/documents/${S.docId}/edit`);
  await expect(p.getByRole('heading', { name: '修正依頼のコメント' })).toBeVisible();
  await p.locator('[id^="st-w-"]').last().fill('新しい住所は必ず復唱して確認する');
  await p.getByRole('button', { name: '保存', exact: true }).click();
  await expect(p.getByText(/保存しました/).first()).toBeVisible();
  await submitForApproval(p, { reviewer: '鈴木 健（CS部長）', approver: '高橋 誠（管理部長）', scheduled: true });

  await openInboxItem(reviewer.page, S.docTitle);
  await reviewer.page.getByRole('button', { name: '確認完了' }).click();
  await dialog(reviewer.page).getByRole('button', { name: '確認完了する' }).click();

  await openInboxItem(approver.page, S.docTitle);
  await expect(approver.page.getByText('あなたの承認を待っています')).toBeVisible();
  await approver.page.getByRole('tab', { name: '変更点' }).click();
  await expect(approver.page.getByRole('region', { name: '差分' })).toBeVisible();
  await approver.page.getByRole('button', { name: '承認する' }).first().click();
  await dialog(approver.page).getByRole('button', { name: '承認する' }).click();
  await expect(approver.page.getByText(/に自動で公開されます/)).toBeVisible();

  // Not visible to members before the publish time
  expect((await apiCall(member.page, 'GET', `/api/documents/${S.docId}`)).status).toBe(404);
  await waitFor(() => apiCall(admin.page, 'GET', `/api/documents/${S.docId}`), (r) => r.body?.document?.status === 'published', 200_000, 5000);

  // Knowledge admin asks the audience to confirm it
  await admin.page.goto(`/documents/${S.docId}`);
  await admin.page.getByRole('button', { name: '確認依頼を配布' }).click();
  await dialog(admin.page).getByRole('button', { name: '配布する' }).click();
  await expect(dialog(admin.page)).toBeHidden();

  // Member searches, reads to the end, confirms
  const m = member.page;
  await m.goto('/search');
  await m.getByLabel('検索語または質問').fill('住所変更');
  await m.getByRole('button', { name: '検索' }).click();
  await m.getByRole('link', { name: new RegExp(S.docTitle) }).click();
  await expect(m.getByRole('heading', { name: '内容の確認' })).toBeVisible();
  await m.getByText(/— 文書の終わり/).scrollIntoViewIfNeeded();
  const btn = m.getByRole('button', { name: '確認しました' });
  await expect(btn).toBeEnabled();
  await btn.click();
  await expect(m.getByText('確認済み').first()).toBeVisible();
  for (const x of [editor, reviewer, approver, member, admin]) await x.ctx.close();
});

test('E2E-2: Major 変更 v2 → 承認 → 公開 → 再確認 → 履歴で v1/v2 を確認', async ({ browser }) => {
  const editor = await loginAs(browser, 'editor');
  const approver = await loginAs(browser, 'approver2');
  const member = await loginAs(browser, 'member-cs');
  const admin = await loginAs(browser, 'admin');
  const p = editor.page;
  await p.goto(`/documents/${S.docId}`);
  await p.getByRole('button', { name: '改訂する' }).click();
  await dialog(p).getByLabel(/重要な変更/).check();
  await dialog(p).getByRole('button', { name: '下書きを作成' }).click();
  await expect(p).toHaveURL(/\/edit$/);
  await expect(p.getByRole('heading', { name: /v2\.0/ })).toBeVisible();
  await p.locator('#cs').fill('本人確認の項目に「登録メールアドレス」を追加');
  await p.locator('#st-i-s1').fill('氏名・生年月日・登録電話番号・登録メールアドレスで本人確認をします。');
  await p.getByRole('button', { name: '保存', exact: true }).click();
  await expect(p.getByText(/保存しました/).first()).toBeVisible();
  await submitForApproval(p, { approver: '高橋 誠（管理部長）' });

  await openInboxItem(approver.page, S.docTitle);
  await approver.page.getByRole('button', { name: '承認する' }).first().click();
  await dialog(approver.page).getByRole('button', { name: '承認する' }).click();
  await waitFor(() => apiCall(admin.page, 'GET', `/api/documents/${S.docId}`), (r) => r.body?.current?.version === '2.0', 30_000, 1000);

  // Re-attestation is required for v2 even though v1 was confirmed
  await member.page.goto('/');
  await expect(member.page.getByRole('region', { name: '確認が必要なルール変更' }).getByRole('link', { name: S.docTitle })).toBeVisible();
  await member.page.goto(`/documents/${S.docId}`);
  await expect(member.page.getByText('この版（v2.0）を最後まで読み')).toBeVisible();
  await member.page.getByText(/— 文書の終わり/).scrollIntoViewIfNeeded();
  await member.page.getByRole('button', { name: '確認しました' }).click();
  await expect(member.page.getByText('確認済み').first()).toBeVisible();

  // History: v1.0 kept as past version, v2.0 current
  await admin.page.goto(`/documents/${S.docId}/history`);
  await expect(admin.page.getByRole('cell', { name: 'v2.0' })).toBeVisible();
  await expect(admin.page.getByRole('cell', { name: 'v1.0' })).toBeVisible();
  await expect(admin.page.getByText('過去の版')).toBeVisible();
  await admin.page.goto('/attestations');
  await expect(admin.page.getByRole('row', { name: new RegExp(`${S.docTitle}.*v1\\.0`) })).toBeVisible();
  await expect(admin.page.getByRole('row', { name: new RegExp(`${S.docTitle}.*v2\\.0`) })).toBeVisible();
  for (const x of [editor, approver, member, admin]) await x.ctx.close();
});

test('E2E-3: 研修コース作成 → AI問題案 → 人間確認 → 部署へ割当 → 受講 → 合格 → 修了', async ({ browser }) => {
  const trainer = await loginAs(browser, 'trainer');
  const member = await loginAs(browser, 'member-cs');
  const t = trainer.page;
  await t.goto('/manage/training?tab=quizzes');
  await t.getByLabel('新しいテスト名').fill('情報持ち出しルール 理解度テスト');
  await t.getByRole('button', { name: '作成' }).click();
  await expect(t).toHaveURL(/\/manage\/quizzes\//);
  S.quizId = t.url().split('/').pop();
  await t.getByRole('button', { name: 'マニュアルからAIで問題案を作る' }).click();
  await dialog(t).locator('#qd').selectOption({ label: 'POL-001 情報持ち出しルール（v2.0）' });
  await dialog(t).locator('#qc').fill('3');
  await dialog(t).getByRole('button', { name: '問題案を作成' }).click();
  await expect(t.getByText(/AIが作成した問題のうち \d+ 問が未確認です/)).toBeVisible();
  await expect(t.getByRole('button', { name: '公開する' })).toBeDisabled();
  for (const c of await t.getByLabel(/問題文・正解・誤答選択肢・根拠を確認しました/).all()) await c.check();
  await t.locator('#ps').fill('60');
  await t.getByRole('button', { name: '公開する' }).click();
  await expect(t.getByText('公開中').first()).toBeVisible();

  await t.goto('/manage/training?tab=courses');
  await t.getByLabel('新しいコース名').fill(S.courseTitle);
  await t.getByRole('button', { name: '作成' }).click();
  await expect(t).toHaveURL(/\/manage\/courses\//);
  await t.getByRole('button', { name: 'マニュアルを読む' }).click();
  await t.locator('select[id^="md"]').selectOption({ label: 'POL-001 情報持ち出しルール（v2.0）' });
  await t.getByRole('button', { name: 'テスト', exact: true }).click();
  await t.locator('select[id^="mq"]').selectOption({ label: '情報持ち出しルール 理解度テスト（v1）' });
  await t.getByRole('button', { name: '公開する' }).click();
  await expect(t.getByText(/公開中 v1/)).toBeVisible();
  await t.getByRole('button', { name: '割り当てる' }).click();
  await dialog(t).getByLabel('CS部', { exact: true }).check();
  await dialog(t).getByRole('button', { name: '割り当てる' }).click();
  await expect(dialog(t)).toBeHidden();

  // correct answers (to answer as the learner) come from the trainer's view of the published quiz
  const quiz = (await apiCall(t, 'GET', `/api/quizzes/${S.quizId}`)).body;
  const qs = quiz.versions.find((v: any) => v.status === 'published').questions;

  const m = member.page;
  await m.goto('/training');
  await m.getByRole('link', { name: new RegExp(S.courseTitle) }).click();
  await m.getByRole('button', { name: '読みました' }).click();
  await m.getByRole('button', { name: 'テストを受ける' }).click();
  const quizDialog = m.getByRole('dialog');
  await expect(quizDialog.getByRole('group').first()).toBeVisible();
  // the in-progress attempt (same one the UI shows) tells us the shuffled question order
  const asgId = m.url().split('/').pop();
  const asg = (await apiCall(m, 'GET', `/api/assignments/${asgId}`)).body;
  const mod = asg.modules.find((x: any) => x.type === 'quiz');
  const attempt = (await apiCall(m, 'POST', `/api/quizzes/${S.quizId}/attempts`, { assignmentId: asgId, moduleId: mod.id })).body;
  const groups = quizDialog.getByRole('group');
  for (let i = 0; i < attempt.questions.length; i++) {
    const q = qs.find((x: any) => x.id === attempt.questions[i].id);
    const correctText = q.choices.find((c: any) => c.id === q.correct[0]).text;
    await groups.nth(i).getByLabel(correctText, { exact: true }).check();
  }
  await quizDialog.getByRole('button', { name: '提出する' }).click();
  await expect(quizDialog.getByText('合格')).toBeVisible();
  await quizDialog.getByRole('button', { name: '閉じる' }).click();
  await expect(m.getByText(/修了しました/)).toBeVisible();
  await expect(m.getByRole('link', { name: '完了証PDF' })).toBeVisible();
  for (const x of [trainer, member]) await x.ctx.close();
});

test('E2E-4: CS 限定 SOP は CS 所属 A は検索・AI 可能、IT 所属 B は一切取得不可', async ({ browser }) => {
  const a = await loginAs(browser, 'member-cs');
  const b = await loginAs(browser, 'member-it');
  const cs001 = (await apiCall(a.page, 'GET', '/api/search?q=%E8%BF%94%E9%87%91')).body.items.find((x: any) => x.doc_number === 'CS-001');
  expect(cs001).toBeTruthy();
  await a.page.goto('/search?q=返金');
  await expect(a.page.getByRole('link', { name: /CS-001 返金問い合わせ一次対応/ })).toBeVisible();
  await a.page.getByLabel('検索語または質問').fill('返金問い合わせの本人確認は？');
  await a.page.getByRole('button', { name: 'AIに質問する' }).click();
  await expect(a.page.getByRole('link', { name: /\[1\] CS-001/ })).toBeVisible();

  await b.page.goto('/search?q=返金');
  await expect(b.page.getByText('0 件')).toBeVisible();
  await expect(b.page.getByText('返金問い合わせ一次対応')).toHaveCount(0);
  await b.page.getByLabel('検索語または質問').fill('返金問い合わせの本人確認は？');
  await b.page.getByRole('button', { name: 'AIに質問する' }).click();
  await expect(b.page.getByText('承認済み手順を確認できません。')).toBeVisible();
  await expect(b.page.getByText('CS-001')).toHaveCount(0);
  await b.page.goto(`/documents/${cs001.id}`);
  await expect(b.page.getByText('見つからないか、閲覧する権限がありません。')).toBeVisible();
  await expect(b.page.getByText('本人確認')).toHaveCount(0);
  for (const x of [a, b]) await x.ctx.close();
});

test('E2E-5: External Member へ限定 Guide を 30 日共有 → 閲覧 → 期限切れで拒否 → 監査履歴', async ({ browser }) => {
  const admin = await loginAs(browser, 'admin');
  const p = admin.page;
  await p.goto('/admin?tab=externals');
  await p.getByRole('button', { name: '外部メンバーを招待' }).click();
  const d = dialog(p);
  await d.locator('#xn').fill('配送パートナー 佐々木');
  await d.locator('#xe').fill('sasaki@partner.example');
  await d.getByLabel(/OPS-020 倉庫パートナー向け/).check();
  await d.getByRole('button', { name: '保存' }).click();
  const pw = (await p.getByRole('dialog', { name: '仮パスワード' }).locator('p[style*="monospace"]').textContent())!.trim();
  await p.getByRole('dialog', { name: '仮パスワード' }).getByRole('button', { name: '閉じる' }).click();

  const ext = await loginAs(browser, 'sasaki@partner.example', { password: pw });
  await ext.page.goto('/documents');
  await expect(ext.page.getByRole('link', { name: '倉庫パートナー向け 入荷受付ガイド' })).toBeVisible();
  await expect(ext.page.getByRole('link', { name: '経費精算の締め日' })).toHaveCount(0); // 全社文書は見えない
  await ext.page.getByRole('link', { name: '倉庫パートナー向け 入荷受付ガイド' }).click();
  await expect(ext.page.getByRole('heading', { name: '倉庫パートナー向け 入荷受付ガイド' })).toBeVisible();

  // the share period ends (stopped now) -> access is refused at the next request
  await p.goto('/admin?tab=externals');
  await p.getByRole('row', { name: /配送パートナー 佐々木/ }).getByRole('button', { name: '今すぐ停止' }).click();
  await expect(p.getByRole('row', { name: /配送パートナー 佐々木/ }).getByText('期限切れ・停止')).toBeVisible();
  await ext.page.reload();
  await expect(ext.page).toHaveURL(/\/login/);
  await expect(ext.page.getByText('共有期間が終了したため、ログアウトしました。')).toBeVisible();

  const auditor = await loginAs(browser, 'auditor');
  await auditor.page.goto('/audit');
  await auditor.page.getByRole('tab', { name: '操作ログ' }).click();
  await auditor.page.getByLabel('操作の種類').selectOption('external.');
  await auditor.page.getByRole('button', { name: '絞り込み' }).click();
  await expect(auditor.page.getByText('external.revoke')).toBeVisible();
  await expect(auditor.page.getByText('external.create')).toBeVisible();
  for (const x of [admin, ext, auditor]) await x.ctx.close();
});

test('E2E-6: Review 期限超過 SOP → Knowledge Admin Dashboard → 変更なしで再確認 → 次回レビュー日更新', async ({ browser }) => {
  const admin = await loginAs(browser, 'admin');
  const p = admin.page;
  await expect(p.getByRole('heading', { name: 'ナレッジの状態' })).toBeVisible();
  await p.getByRole('region', { name: 'ナレッジの状態' }).getByRole('link', { name: /BO-003 月末請求確認/ }).click();
  await expect(p.getByText(/定期レビューの期限（.*）を過ぎています/)).toBeVisible();
  const before = (await apiCall(p, 'GET', p.url().replace(/.*\/documents\//, '/api/documents/'))).body.document.nextReviewDate;
  await p.getByRole('button', { name: '変更なしで再確認' }).click();
  await expect(p.getByText('次回レビュー日を更新しました')).toBeVisible();
  const after = (await apiCall(p, 'GET', p.url().replace(/.*\/documents\//, '/api/documents/'))).body.document.nextReviewDate;
  expect(after > before).toBe(true);
  expect(after > new Date().toISOString().slice(0, 10)).toBe(true);
  await expect(p.getByText(/定期レビューの期限（.*）を過ぎています/)).toHaveCount(0);
  await admin.ctx.close();
});

test('E2E-9: Audit Package 生成 → 内容が一致し、他部署の非対象機密文書を含まない', async ({ browser }) => {
  const auditor = await loginAs(browser, 'auditor');
  const p = auditor.page;
  await p.goto('/audit');
  await p.locator('#pf').fill('2000-01-01');
  await p.locator('#pd').selectOption({ label: 'CS部' });
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: '監査パッケージを出力' }).click()]);
  const zip = readFileSync(await dl.path());
  const entries = await unzip(zip);
  const names = entries.map((e) => e.name);
  expect(names).toEqual(expect.arrayContaining(['README.txt', 'manifest.json', '01_現行SOP一覧.csv', '02_version履歴.csv', '03_承認履歴.csv', '05_重要文書の確認記録.csv', '06_研修受講記録.csv', '08_監査ログ抜粋.csv']));
  const get = (n: string) => entries.find((e) => e.name === n)!.data.toString('utf8');
  expect(get('01_現行SOP一覧.csv')).toContain(S.docTitle);
  expect(get('01_現行SOP一覧.csv')).toContain('CS-001');
  for (const other of ['BO-003', 'IT-020', 'IT-005', '月末請求確認', '退職者アカウント停止']) expect(entries.map((e) => e.data.toString('utf8')).join('\n')).not.toContain(other);
  expect(get('02_version履歴.csv')).toContain('"2.0"');
  expect(get('03_承認履歴.csv')).toContain('高橋 誠（管理部長）');
  expect(get('03_承認履歴.csv')).toContain('一致');
  expect(get('05_重要文書の確認記録.csv')).toContain('中村 優（CS）');
  expect(get('06_研修受講記録.csv')).toContain(S.courseTitle);
  expect(names.some((n) => n.startsWith('SOP/') && n.endsWith('.pdf'))).toBe(true);
  const manifest = JSON.parse(get('manifest.json'));
  expect(manifest.files.length).toBe(entries.length - 2);
  await auditor.ctx.close();
});

test('E2E-7: AI 検索 → 承認済み CS SOP のみを version/section 引用付きで回答 → 根拠文書 Retire 後は除外', async ({ browser }) => {
  const member = await loginAs(browser, 'member-cs');
  const admin = await loginAs(browser, 'admin');
  const m = member.page;
  await m.goto('/search');
  await m.getByLabel('検索語または質問').fill('返金問い合わせの最初の手順は？');
  await m.getByRole('button', { name: 'AIに質問する' }).click();
  const cite = m.getByRole('link', { name: /\[1\] CS-001 返金問い合わせ一次対応/ });
  await expect(cite).toBeVisible();
  await expect(m.getByText(/— v1\.0 ・ .+ ・ 公開/).first()).toBeVisible();
  await expect(m.getByText('本人確認').first()).toBeVisible();

  const id = (await apiCall(m, 'GET', '/api/search?q=CS-001')).body.items[0].id;
  await admin.page.goto(`/documents/${id}`);
  await admin.page.getByRole('button', { name: '廃止する' }).click();
  await dialog(admin.page).locator('#rr').fill('新しい返金ポリシーへ移行');
  await dialog(admin.page).getByRole('button', { name: '廃止する' }).click();
  await expect(admin.page.getByText('この文書は廃止されています。')).toBeVisible();

  await m.getByRole('button', { name: 'AIに質問する' }).click();
  await expect(m.getByText('承認済み手順を確認できません。')).toBeVisible();
  await expect(m.getByRole('link', { name: /CS-001/ })).toHaveCount(0);
  for (const x of [member, admin]) await x.ctx.close();
});

test('E2E-10: Backup → 空環境へ Restore → currentVersion / ACL / Course / Quiz / Attempt / Attestation / Audit が一致', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await loginAs(browser, 'owner');
  const p = owner.page;
  await p.goto('/admin?tab=backup');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.getByRole('button', { name: 'バックアップを作成' }).click()]);
  const file = await dl.path();
  const b = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
  expect(b.format).toBe('operate-backup');
  const src = process.env.E2E_DB ?? 'operate_e2e';
  const dst = `${src}_restore`;
  const root = new pg.Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres' });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${dst} WITH (FORCE)`);
  await root.query(`CREATE DATABASE ${dst} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'`);
  await root.end();
  const env = { ...process.env, DATABASE_ADMIN_URL: `postgres://postgres:postgres@127.0.0.1:5432/${dst}`, DATABASE_URL: `postgres://operate_app:operate_app@127.0.0.1:5432/${dst}` };
  execFileSync('npx', ['tsx', 'src/cli/migrate.ts'], { cwd: '../server', env });
  const out = execFileSync('npx', ['tsx', 'src/cli/restore.ts', file], { cwd: '../server', env }).toString();
  expect(out).toContain('"restored": true');
  const a = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:5432/${src}` });
  const c = new pg.Client({ connectionString: `postgres://postgres:postgres@127.0.0.1:5432/${dst}` });
  await a.connect(); await c.connect();
  const org = (await a.query(`SELECT id FROM organizations WHERE slug = 'sample-works'`)).rows[0].id;
  for (const qtext of [
    'SELECT id, current_version_id, status FROM documents WHERE org_id = $1 ORDER BY id',
    'SELECT document_id, kind, target FROM document_audiences WHERE org_id = $1 ORDER BY 1,2,3',
    'SELECT user_id, role FROM user_roles WHERE org_id = $1 ORDER BY 1,2',
    'SELECT id, current_version_id, status FROM courses WHERE org_id = $1 ORDER BY id',
    'SELECT id, current_version_id FROM quizzes WHERE org_id = $1 ORDER BY id',
    'SELECT id, score, result FROM quiz_attempts WHERE org_id = $1 ORDER BY id',
    'SELECT id, status, acknowledged_at FROM user_attestations WHERE org_id = $1 ORDER BY id',
    'SELECT id, content_hash FROM approvals WHERE org_id = $1 ORDER BY id',
  ]) expect((await c.query(qtext, [org])).rows).toEqual((await a.query(qtext, [org])).rows);
  // audit log: every event that existed at backup time is present and identical
  const n = b.counts.audit_events;
  expect((await c.query('SELECT id, action, target_id FROM audit_events WHERE org_id = $1 ORDER BY id', [org])).rows).toEqual((await a.query('SELECT id, action, target_id FROM audit_events WHERE org_id = $1 ORDER BY id LIMIT $2', [org, n])).rows);
  await a.end(); await c.end();
  await owner.ctx.close();
});

function unzip(buf: Buffer): Promise<Array<{ name: string; data: Buffer }>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);
      const out: Array<{ name: string; data: Buffer }> = [];
      zip.readEntry();
      zip.on('entry', (e) => zip.openReadStream(e, (er, s) => {
        if (er || !s) return reject(er);
        const chunks: Buffer[] = [];
        s.on('data', (c) => chunks.push(c));
        s.on('end', () => { out.push({ name: e.fileName, data: Buffer.concat(chunks) }); zip.readEntry(); });
      }));
      zip.on('end', () => resolve(out));
    });
  });
}
