import { randomUUID } from 'node:crypto';
import { tx, type Db } from '../db/pool.js';
import { actorForUser } from '../http.js';
import type { Actor } from '../lib/authz.js';
import { docFromBlocks, type Content } from '../lib/content.js';
import { hashPassword } from '../lib/crypto.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { sql } from '../lib/sql.js';
import { acknowledge, markProgress } from './attestations.js';
import { approvalDecision, approvalRequired, createDocument, createRevision, saveDraft, submitVersion, type DocInput } from './documents.js';
import { provisionOrg } from './provision.js';
import { assignCourse, evaluateAssignment } from './training.js';

export const DEMO_PASSWORD = 'Operate-Demo-2026!';

const step = (id: string, title: string, instruction: string, extra: { warning?: string; expectedResult?: string; checklist?: string[]; reference?: string } = {}) => ({
  id, title, instruction, warning: extra.warning ?? '', expectedResult: extra.expectedResult ?? '', imageId: null, checklist: extra.checklist ?? [], reference: extra.reference ?? '',
});

const C = {
  cs001: (): Content => ({
    body: docFromBlocks([
      { h: '目的', p: '返金に関するお問い合わせに、誰が対応しても同じ品質で一次対応するための手順です。' },
      { h: '適用範囲', p: 'CS部 一次対応チームが受け付ける、メール・電話・チャットでの返金問い合わせ。' },
      { h: '必要なもの', li: ['注文管理画面の閲覧権限', '返金ポリシー（最新版）', '問い合わせ管理ツール'] },
      { h: '確認ポイント', li: ['本人確認が完了していること', '返金可否の判断を一次対応で約束していないこと'] },
      { h: '例外対応', p: '購入から30日を超えている場合、または高額（5万円以上）の場合は、一次対応で結論を出さず二次対応へ引き継ぎます。' },
      { h: 'エスカレーション', p: '判断に迷う場合は CS 二次対応チームのリーダーへ、問い合わせ管理ツールの「エスカレーション」から連絡します。' },
      { warn: 'お客様に「必ず返金します」と約束してはいけません。返金可否は二次対応で決定します。' },
    ]),
    steps: [
      step('s1', '本人確認をする', '注文番号・氏名・メールアドレスの3点で、お客様本人であることを確認します。', { expectedResult: '3点が注文情報と一致している', checklist: ['注文番号', '氏名', 'メールアドレス'] }),
      step('s2', '注文状況を確認する', '注文管理画面で、発送状況・支払方法・購入日を確認します。', { warning: '決済情報（カード番号など）を読み上げない' }),
      step('s3', '返金理由を聞き取る', '返金を希望する理由を聞き取り、問い合わせ管理ツールに記録します。', { expectedResult: '理由がカテゴリ付きで記録されている' }),
      step('s4', '今後の流れを案内する', '「担当部署で確認し、2営業日以内にご連絡します」と案内し、二次対応へ引き継ぎます。'),
    ],
    checklistItems: [],
  }),
  ops010: (): Content => ({
    body: docFromBlocks([{ h: '目的', p: '出荷前の検品漏れ・誤配送を防ぐためのチェックリストです。' }, { h: '適用範囲', p: 'EC運営部 出荷チーム。' }]),
    steps: [],
    checklistItems: [
      { id: 'c1', text: 'ピッキングリストと商品のSKUが一致している', required: true },
      { id: 'c2', text: '数量が一致している', required: true },
      { id: 'c3', text: '破損・汚れがない', required: true },
      { id: 'c4', text: '納品書を同梱した', required: true },
      { id: 'c5', text: 'ギフト指定の有無を確認した', required: false },
    ],
  }),
  bo003: (): Content => ({
    body: docFromBlocks([
      { h: '目的', p: '月末の請求データに誤りがないかを確認し、翌月初の請求書発行を正確に行う。' },
      { h: '適用範囲', p: 'バックオフィス部 経理担当。' },
      { h: 'エスカレーション', p: '差異が1万円以上ある場合はバックオフィス部長へ報告する。' },
    ]),
    steps: [
      step('s1', '売上データを出力する', '会計システムから当月の売上明細をCSVで出力する。'),
      step('s2', '請求予定と突合する', '請求予定一覧と売上明細を突合し、差異を洗い出す。', { expectedResult: '差異一覧が作成されている' }),
      step('s3', '差異を解消する', '差異の原因を担当者に確認し、修正または翌月繰越の判断を記録する。', { warning: '承認なく金額を変更しない' }),
    ],
    checklistItems: [],
  }),
  it005: (): Content => ({
    body: docFromBlocks([
      { h: '目的', p: '新入社員が入社日から業務を始められるよう、必要なアカウントを発行する。' },
      { h: '適用範囲', p: 'IT部 ヘルプデスク。' },
      { h: '前提', li: ['人事から入社連絡（氏名・部署・入社日）を受け取っていること'] },
    ]),
    steps: [
      step('s1', 'メールアカウントを作成する', '管理コンソールで「名.姓@会社ドメイン」のアカウントを作成する。', { expectedResult: 'ログインできる' }),
      step('s2', '部署グループに追加する', '所属部署のグループへ追加する。', { checklist: ['部署グループ', '全社グループ'] }),
      step('s3', '初期パスワードを通知する', '初期パスワードは本人の上長経由で手渡しし、チャットやメールでは送らない。', { warning: '初期パスワードをチャットに貼らない' }),
      step('s4', 'Operate のアカウントを作成する', 'Operate の「組織・ユーザー設定」→「ユーザー」で所属部署・役割を設定し、オンボーディングを開始する。'),
    ],
    checklistItems: [],
  }),
  pol001: (v2 = false): Content => ({
    body: docFromBlocks([
      { h: '目的', p: '顧客情報・社内情報の漏えいを防ぐため、社外への情報持ち出しのルールを定める。' },
      { h: '適用範囲', p: '全従業員（業務委託を含む）。' },
      { h: '規程', li: [
        '顧客情報を個人のPC・スマートフォン・USBメモリに保存してはならない。',
        '社外で業務を行う場合は、会社支給の端末のみを使用する。',
        v2 ? '生成AIサービスに顧客情報・機密情報を入力してはならない（会社が許可したサービスを除く）。' : '社外に資料を送付する場合は、上長の承認を得る。',
        ...(v2 ? ['社外に資料を送付する場合は、上長の承認を得る。'] : []),
      ] },
      { h: '違反時の対応', p: '違反が判明した場合は、速やかに情報システム担当へ報告する。' },
      { h: '問い合わせ先', p: 'IT部 ヘルプデスク' },
    ]),
    steps: [],
    checklistItems: [],
  }),
  it020: (): Content => ({
    body: docFromBlocks([{ h: '目的', p: '退職者のアカウントを退職日当日に確実に停止する。' }, { warn: '退職日より前に停止しない。停止漏れは情報漏えいにつながる。' }]),
    steps: [],
    checklistItems: [
      { id: 'c1', text: 'メールアカウントを停止した', required: true },
      { id: 'c2', text: 'チャットツールのアカウントを停止した', required: true },
      { id: 'c3', text: 'Operate のユーザーを無効化した', required: true },
      { id: 'c4', text: '貸与PCの回収を確認した', required: true },
    ],
  }),
  ops020: (): Content => ({
    body: docFromBlocks([
      { h: '目的', p: '倉庫パートナーの皆さまが入荷品を受け付けるときの手順です。' },
      { h: '受付手順', ol: ['入荷予定表と納品書を照合する', '外装の破損を確認する', '受付システムに入荷を登録する'] },
      { note: '不明点は EC運営部 出荷チームへご連絡ください。' },
    ]),
    steps: [],
    checklistItems: [],
  }),
  cs002: (): Content => ({
    body: docFromBlocks([{ h: '目的', p: '返品受付の手順を統一する。' }, { h: '適用範囲', p: 'CS部' }]),
    steps: [step('s1', '返品理由を確認する', '返品理由と商品の状態を確認する。'), step('s2', '返品受付番号を発行する', '問い合わせ管理ツールで返品受付番号を発行し、お客様へ案内する。')],
    checklistItems: [],
  }),
  faq: (): Content => ({ body: docFromBlocks([{ h: '質問', p: '経費精算の締め日はいつですか？' }, { h: '回答', p: '毎月25日です。25日が休日の場合は前営業日が締め日です。' }]), steps: [], checklistItems: [] }),
};

async function publishNew(db: Db, author: Actor, approver: Actor, input: DocInput) {
  const { document, version } = await createDocument(db, author, input);
  const need = approvalRequired(author.settings, input.type, false);
  await submitVersion(db, author, version.id, { reviewers: [], approvalSteps: need ? [{ mode: 'any', approvers: [approver.id] }] : undefined, publishMode: 'immediate' });
  if (need) await approvalDecision(db, approver, version.id, 'approved', '内容を確認しました', version.content_hash);
  return { documentId: document.id as string, versionId: version.id as string };
}

export async function seedSample(slug = 'sample-works', name = 'Sample Works株式会社') {
  const { orgId, ownerId } = await provisionOrg({
    slug, name, ownerEmail: `owner@${slug}.example`, ownerName: '佐藤 真理', ownerPassword: DEMO_PASSWORD, isSample: true,
    settings: { ai: { ...DEFAULT_SETTINGS.ai, enabled: true, provider: 'local' } },
  });
  const pw = await hashPassword(DEMO_PASSWORD);
  return tx(orgId, async (db) => {
    const dept: Record<string, string> = {};
    for (const [code, n] of [['CS', 'CS部'], ['OPS', 'EC運営部'], ['BO', 'バックオフィス部'], ['IT', 'IT部']]) {
      dept[code] = (await db.one(sql`INSERT INTO departments (org_id, name, code) VALUES (${orgId}, ${n}, ${code}) RETURNING id`)).id;
    }
    const team: Record<string, string> = {};
    for (const [key, code, n] of [['CS1', 'CS', '一次対応チーム'], ['CS2', 'CS', '二次対応チーム'], ['OPS1', 'OPS', '出荷チーム'], ['IT1', 'IT', 'ヘルプデスク']]) {
      team[key] = (await db.one(sql`INSERT INTO teams (org_id, department_id, name) VALUES (${orgId}, ${dept[code]}, ${n}) RETURNING id`)).id;
    }
    await db.exec(sql`INSERT INTO memberships (org_id, user_id, department_id) VALUES (${orgId}, ${ownerId}, ${dept.BO})`);
    const users: Record<string, string> = { owner: ownerId };
    const mk = async (key: string, n: string, roles: string[], ms: Array<[string, string?]>, scopes: Array<string | null> = [], hire?: string) => {
      const id = randomUUID();
      await db.exec(sql`INSERT INTO users (id, org_id, email, name, password_hash, hire_date) VALUES (${id}, ${orgId}, ${`${key}@${slug}.example`}, ${n}, ${pw}, ${hire ?? null})`);
      for (const r of roles) await db.exec(sql`INSERT INTO user_roles (org_id, user_id, role) VALUES (${orgId}, ${id}, ${r})`);
      for (const [d, t] of ms) await db.exec(sql`INSERT INTO memberships (org_id, user_id, department_id, team_id) VALUES (${orgId}, ${id}, ${dept[d]}, ${t ? team[t] : null})`);
      for (const s of scopes) await db.exec(sql`INSERT INTO approver_scopes (org_id, user_id, department_id) VALUES (${orgId}, ${id}, ${s ? dept[s] : null})`);
      users[key] = id;
      return id;
    };
    await mk('admin', '田中 恵（ナレッジ管理）', ['knowledge_admin', 'member'], [['BO']]);
    await mk('approver', '鈴木 健（CS部長）', ['approver', 'member'], [['CS', 'CS2']], ['CS', 'OPS']);
    await mk('approver2', '高橋 誠（管理部長）', ['approver', 'member'], [['BO']], [null]);
    await mk('editor', '伊藤 彩（CS編集）', ['editor', 'member'], [['CS', 'CS2']]);
    await mk('editor-it', '渡辺 翔（IT編集）', ['editor', 'member'], [['IT', 'IT1']]);
    await mk('trainer', '山本 由佳（研修担当）', ['trainer', 'member'], [['BO']]);
    await mk('member-cs', '中村 優（CS）', ['member'], [['CS', 'CS1']]);
    await mk('member-it', '小林 大輔（IT）', ['member'], [['IT', 'IT1']]);
    await mk('member-ops', '加藤 美咲（EC運営）', ['member'], [['OPS', 'OPS1']]);
    await mk('auditor', '吉田 直樹（監査）', ['auditor'], [['BO']]);
    await mk('newhire', '山田 花子（新入社員）', ['member'], [['CS', 'CS1']], [], new Date().toISOString().slice(0, 10));
    const extId = randomUUID();
    await db.exec(sql`INSERT INTO users (id, org_id, email, name, password_hash, is_external, external_expires_at) VALUES (${extId}, ${orgId}, ${`partner@${slug}.example`}, '倉庫パートナー 木村', ${pw}, true, now() + interval '30 days')`);
    await db.exec(sql`INSERT INTO user_roles (org_id, user_id, role) VALUES (${orgId}, ${extId}, 'external')`);
    users.partner = extId;

    const A: Record<string, Actor> = {};
    for (const k of Object.keys(users)) A[k] = await actorForUser(db, users[k]);
    const docs: Record<string, string> = {};

    docs.cs001 = (await publishNew(db, A.editor, A.approver, { type: 'sop', docNumber: 'CS-001', title: '返金問い合わせ一次対応', summary: '返金に関する問い合わせを受けたときの一次対応手順', category: '問い合わせ対応', tags: ['返金', '一次対応', 'CS'], classification: 'internal', departmentId: dept.CS, audiences: [{ kind: 'department', target: dept.CS }], content: C.cs001() })).documentId;
    docs.ops010 = (await publishNew(db, A.admin, A.approver, { type: 'checklist', docNumber: 'OPS-010', title: '出荷前確認', summary: '出荷前の検品チェックリスト', category: '出荷', tags: ['出荷', '検品'], classification: 'internal', departmentId: dept.OPS, ownerId: users.admin, audiences: [{ kind: 'department', target: dept.OPS }], content: C.ops010() })).documentId;
    docs.bo003 = (await publishNew(db, A.admin, A.approver2, { type: 'sop', docNumber: 'BO-003', title: '月末請求確認', summary: '月末の請求データ確認手順', category: '経理', tags: ['請求', '月末'], classification: 'confidential', departmentId: dept.BO, audiences: [{ kind: 'department', target: dept.BO }], reviewCycleDays: 90, content: C.bo003() })).documentId;
    docs.it005 = (await publishNew(db, A['editor-it'], A.approver2, { type: 'sop', docNumber: 'IT-005', title: '新入社員アカウント発行', summary: '新入社員のアカウント発行手順', category: 'アカウント管理', tags: ['入社', 'アカウント'], classification: 'internal', departmentId: dept.IT, audiences: [{ kind: 'department', target: dept.IT }], content: C.it005() })).documentId;
    docs.it020 = (await publishNew(db, A['editor-it'], A.approver2, { type: 'checklist', docNumber: 'IT-020', title: '退職者アカウント停止', summary: '退職日当日のアカウント停止チェックリスト', category: 'アカウント管理', tags: ['退職', 'アカウント'], classification: 'restricted', departmentId: dept.IT, audiences: [{ kind: 'department', target: dept.IT }], content: C.it020() })).documentId;
    docs.ops020 = (await publishNew(db, A.admin, A.approver, { type: 'guide', docNumber: 'OPS-020', title: '倉庫パートナー向け 入荷受付ガイド', summary: '外部倉庫パートナー向けの入荷受付手順', category: '出荷', tags: ['入荷', 'パートナー'], classification: 'public_internal', departmentId: dept.OPS, ownerId: users.admin, audiences: [{ kind: 'department', target: dept.OPS }, { kind: 'user', target: extId }], content: C.ops020() })).documentId;
    docs.faq = (await publishNew(db, A.admin, A.approver2, { type: 'faq', docNumber: 'FAQ-001', title: '経費精算の締め日', summary: '経費精算の締め日について', category: '経費', tags: ['経費'], classification: 'internal', departmentId: dept.BO, audienceAll: true, content: C.faq() })).documentId;
    const pol = await publishNew(db, A.admin, A.approver2, { type: 'policy', docNumber: 'POL-001', title: '情報持ち出しルール', summary: '社外への情報持ち出しに関する全社ルール', category: '情報セキュリティ', tags: ['情報セキュリティ', '全社'], classification: 'internal', departmentId: dept.BO, audienceAll: true, requiresAttestation: true, reviewCycleDays: 365, content: C.pol001() });
    docs.pol001 = pol.documentId;
    // Some users acknowledge v1.0 ...
    for (const k of ['member-cs', 'member-it', 'editor']) {
      const ua = await db.one(sql`SELECT id FROM user_attestations WHERE user_id = ${users[k]} AND version_id = ${pol.versionId}`);
      await markProgress(db, A[k], ua.id, 'reached_end');
      await acknowledge(db, A[k], ua.id);
    }
    // ... then a Major revision v2.0 requires everyone to confirm again.
    const v2 = await createRevision(db, A.admin, docs.pol001, 'major');
    const saved = await saveDraft(db, A.admin, v2.id, { editSeq: v2.edit_seq, content: C.pol001(true), changeSummary: '生成AIサービスへの機密情報入力の禁止を追加', changeType: 'major' });
    await submitVersion(db, A.admin, v2.id, { reviewers: [], approvalSteps: [{ mode: 'any', approvers: [users.approver2] }], publishMode: 'immediate' });
    await approvalDecision(db, A.approver2, v2.id, 'approved', '全社周知をお願いします', saved.content_hash);
    // Review overdue example
    await db.exec(sql`UPDATE documents SET next_review_date = current_date - 10, last_reviewed_at = now() - interval '100 days' WHERE id = ${docs.bo003}`);
    // A draft waiting for review
    const cs002 = await createDocument(db, A.editor, { type: 'sop', docNumber: 'CS-002', title: '返品受付', summary: '返品を受け付けるときの手順', classification: 'internal', departmentId: dept.CS, audiences: [{ kind: 'department', target: dept.CS }], content: C.cs002() });
    docs.cs002 = cs002.document.id;
    await submitVersion(db, A.editor, cs002.version.id, { reviewers: [users.approver], approvalSteps: [{ mode: 'any', approvers: [users.approver] }], publishMode: 'immediate' });
    // relation
    await db.exec(sql`INSERT INTO document_relations (org_id, from_document_id, to_document_id, kind, created_by) VALUES (${orgId}, ${docs.cs001}, ${docs.pol001}, 'related', ${users.editor}), (${orgId}, ${docs.it005}, ${docs.pol001}, 'dependsOn', ${users['editor-it']})`);

    // ---------------------------------------------------------------- quiz + course
    const quizId = randomUUID();
    const qvId = randomUUID();
    const cs001v = (await db.one(sql`SELECT current_version_id FROM documents WHERE id = ${docs.cs001}`)).current_version_id;
    const q = (id: string, prompt: string, choices: string[], correct: number, section: string, explanation: string) => ({
      id, type: 'single', prompt, choices: choices.map((t, i) => ({ id: `c${i + 1}`, text: t })), correct: [`c${correct + 1}`], explanation,
      sourceDocumentId: docs.cs001, sourceVersionId: cs001v, sourceSection: section, points: 1, aiGenerated: false, reviewed: true, reviewedBy: '山本 由佳（研修担当）', reviewedAt: new Date().toISOString(),
    });
    const questions = [
      q('q1', '返金問い合わせで最初に行うことはどれですか？', ['本人確認をする', '返金を約束する', '返金処理を実行する', '上長に電話する'], 0, '手順1: 本人確認をする', '最初に注文番号・氏名・メールアドレスで本人確認をします。'),
      q('q2', '本人確認で使う情報の組み合わせとして正しいものは？', ['注文番号・氏名・メールアドレス', '氏名だけ', '電話番号と住所', 'カード番号'], 0, '手順1: 本人確認をする', '3点で確認します。'),
      q('q3', '一次対応でお客様に「必ず返金します」と約束してよいですか？', ['約束してはいけない', '約束してよい', '高額なら約束してよい', '上長がいなければ約束してよい'], 0, '本文', '返金可否は二次対応で決定します。'),
      q('q4', '購入から30日を超えている場合の対応は？', ['二次対応へ引き継ぐ', 'その場で返金する', 'お断りする', '記録せず終了する'], 0, '例外対応', '一次対応で結論を出さず二次対応へ引き継ぎます。'),
      { id: 'q5', type: 'truefalse', prompt: '決済情報（カード番号など）は確認のために読み上げてよい。', choices: [{ id: 'true', text: '正しい' }, { id: 'false', text: '誤り' }], correct: ['false'], explanation: '読み上げてはいけません。', sourceDocumentId: docs.cs001, sourceVersionId: cs001v, sourceSection: '手順2: 注文状況を確認する', points: 1, aiGenerated: false, reviewed: true },
    ];
    await db.exec(sql`INSERT INTO quizzes (id, org_id, title, owner_id, status) VALUES (${quizId}, ${orgId}, 'CS基礎理解度テスト', ${users.trainer}, 'published')`);
    await db.exec(sql`INSERT INTO quiz_versions (id, org_id, quiz_id, version_no, status, questions, settings, created_by, published_by, published_at)
      VALUES (${qvId}, ${orgId}, ${quizId}, 1, 'published', ${JSON.stringify(questions)}, ${JSON.stringify({ passScore: 80, maxAttempts: 3, cooldownMinutes: 0, shuffleQuestions: true, shuffleChoices: true, showExplanation: 'after_submit' })}, ${users.trainer}, ${users.trainer}, now())`);
    await db.exec(sql`UPDATE quizzes SET current_version_id = ${qvId} WHERE id = ${quizId}`);
    const courseId = randomUUID();
    const cvId = randomUUID();
    const modules = [
      { id: 'm1', type: 'text', title: 'はじめに', required: true, text: 'Sample Works へようこそ。このコースでは、入社後すぐに必要なルールとCSの基本手順を学びます。' },
      { id: 'm2', type: 'document', title: '情報持ち出しルールを読む', required: true, documentId: docs.pol001 },
      { id: 'm3', type: 'document', title: '返金問い合わせ一次対応を読む', required: true, documentId: docs.cs001 },
      { id: 'm4', type: 'quiz', title: 'CS基礎理解度テスト', required: true, quizId },
      { id: 'm5', type: 'acknowledgement', title: '受講内容の確認', required: true, text: '私は本コースの内容を確認し、業務で守ります。' },
    ];
    await db.exec(sql`INSERT INTO courses (id, org_id, title, description, owner_id, status, due_days, validity_days) VALUES (${courseId}, ${orgId}, '新入社員オンボーディング', '入社後1週間で受講する基本研修です。', ${users.trainer}, 'published', 14, 365)`);
    await db.exec(sql`INSERT INTO course_versions (id, org_id, course_id, version_no, status, modules, published_at, created_by) VALUES (${cvId}, ${orgId}, ${courseId}, 1, 'published', ${JSON.stringify(modules)}, now(), ${users.trainer})`);
    await db.exec(sql`UPDATE courses SET current_version_id = ${cvId} WHERE id = ${courseId}`);
    await assignCourse(db, A.trainer, A.trainer.settings, courseId, [users['member-cs'], users.editor], { source: 'department', sourceRef: dept.CS });
    // member-cs has completed the course
    const asg = await db.one(sql`SELECT id FROM training_assignments WHERE user_id = ${users['member-cs']} AND course_id = ${courseId}`);
    for (const m of ['m1', 'm2', 'm3', 'm4', 'm5']) await db.exec(sql`INSERT INTO module_progress (org_id, assignment_id, module_id) VALUES (${orgId}, ${asg.id}, ${m})`);
    await evaluateAssignment(db, A.trainer.settings, asg.id, null);
    // onboarding template + run for the new hire
    const tplId = (await db.one(sql`INSERT INTO onboarding_templates (org_id, name, role, department_id, items, created_by) VALUES (${orgId}, '新人オンボーディング（CS）', 'member', ${dept.CS},
      ${JSON.stringify([{ courseId, offsetDays: 7, label: 'Week1' }])}, ${users.trainer}) RETURNING id`)).id;
    const run = await db.one(sql`INSERT INTO onboarding_runs (org_id, template_id, template_snapshot, user_id, start_date, created_by) VALUES (${orgId}, ${tplId}, ${JSON.stringify([{ courseId, offsetDays: 7, label: 'Week1' }])}, ${users.newhire}, current_date, ${users.trainer}) RETURNING id`);
    await assignCourse(db, A.trainer, A.trainer.settings, courseId, [users.newhire], { dueDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), source: 'onboarding', sourceRef: run.id });

    // ---------------------------------------------------------------- feedback, improvement, checklist run, search history
    const cs001cur = (await db.one(sql`SELECT current_version_id FROM documents WHERE id = ${docs.cs001}`)).current_version_id;
    await db.exec(sql`INSERT INTO feedback (org_id, document_id, version_id, user_id, kind, body) VALUES (${orgId}, ${docs.cs001}, ${cs001cur}, ${users['member-cs']}, 'outdated', 'チャットでの問い合わせ時の本人確認方法も追記してほしいです。'),
      (${orgId}, ${docs.cs001}, ${cs001cur}, ${users.newhire}, 'helpful', '')`);
    await db.exec(sql`INSERT INTO improvement_tickets (org_id, document_id, title, summary, priority, owner_id, created_by) VALUES (${orgId}, ${docs.cs001}, 'チャット問い合わせの本人確認手順を追加', '誤案内が1件発生。チャット時の本人確認手順が不足している。', 'high', ${users.editor}, ${users.approver})`);
    const ops010v = (await db.one(sql`SELECT current_version_id, (SELECT content FROM document_versions WHERE id = current_version_id) AS content FROM documents WHERE id = ${docs.ops010}`));
    const items = (ops010v.content as Content).checklistItems.map((x) => ({ id: x.id, text: x.text, required: x.required, stepId: null, checked: true, checkedAt: new Date().toISOString(), checkedBy: '加藤 美咲（EC運営）', note: '' }));
    await db.exec(sql`INSERT INTO checklist_runs (org_id, document_id, version_id, assignee_id, started_by, status, items, started_at, completed_at) VALUES (${orgId}, ${docs.ops010}, ${ops010v.current_version_id}, ${users['member-ops']}, ${users['member-ops']}, 'completed', ${JSON.stringify(items)}, now() - interval '1 hour', now())`);
    for (const [qq, n, clicked] of [['返金', 3, docs.cs001], ['出荷 検品', 1, docs.ops010], ['有給休暇 申請', 0, null], ['有給休暇 申請', 0, null], ['経費 締め日', 1, docs.faq]] as const) {
      await db.exec(sql`INSERT INTO search_queries (org_id, query, mode, result_count, clicked_document_id, dwell_ms) VALUES (${orgId}, ${qq}, 'keyword', ${n}, ${clicked}, ${clicked ? 45000 : null})`);
    }
    return { orgId, users, docs, dept, team, courseId, quizId };
  });
}
