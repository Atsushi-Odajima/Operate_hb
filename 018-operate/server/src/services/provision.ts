import { randomUUID } from 'node:crypto';
import { tx } from '../db/pool.js';
import { docFromBlocks } from '../lib/content.js';
import { hashPassword } from '../lib/crypto.js';
import { DEFAULT_SETTINGS, type OrgSettings } from '../lib/settings.js';
import { sql } from '../lib/sql.js';

export const SOP_TEMPLATE = {
  body: docFromBlocks([
    { h: '目的', p: 'この手順で達成すること、なぜ必要かを書きます。' },
    { h: '適用範囲', p: '対象の部署・業務・担当者を書きます。' },
    { h: '前提', li: ['作業を始める前に満たしている必要がある条件'] },
    { h: '必要なもの', li: ['使用するシステム、書類、権限など'] },
    { h: '手順', p: '下の「手順（ステップ）」に1ステップずつ入力します。' },
    { h: '確認ポイント', li: ['作業後に確認すること'] },
    { h: '例外対応', p: '通常と違うケースの対応を書きます。' },
    { h: 'エスカレーション', p: '判断に迷ったときの連絡先・相談先を書きます。' },
    { h: '関連資料', li: ['関連するマニュアル・規程'] },
    { h: '改訂履歴', p: '改訂履歴は Operate の「版の履歴」に自動で記録されます。' },
  ]),
  steps: [{ id: 's1', title: '最初の手順', instruction: '具体的な操作を書きます。', warning: '', expectedResult: '', imageId: null, checklist: [], reference: '' }],
  checklistItems: [],
};

export const CHECKLIST_TEMPLATE = {
  body: docFromBlocks([{ h: '目的', p: 'このチェックリストを使う場面を書きます。' }, { h: '注意事項', p: '' }]),
  steps: [],
  checklistItems: [{ id: 'c1', text: '確認項目1', required: true }],
};

export const POLICY_TEMPLATE = {
  body: docFromBlocks([
    { h: '目的', p: '' }, { h: '適用範囲', p: '' }, { h: '定義', p: '' }, { h: '規程', p: '' }, { h: '違反時の対応', p: '' }, { h: '問い合わせ先', p: '' },
  ]),
  steps: [],
  checklistItems: [],
};

export const FAQ_TEMPLATE = { body: docFromBlocks([{ h: '質問', p: '' }, { h: '回答', p: '' }, { h: '関連資料', p: '' }]), steps: [], checklistItems: [] };

export async function provisionOrg(input: {
  slug: string; name: string; ownerEmail: string; ownerName: string; ownerPassword: string; isSample?: boolean; settings?: Partial<OrgSettings>;
}) {
  const orgId = randomUUID();
  const ownerId = randomUUID();
  await tx(orgId, async (db) => {
    await db.exec(sql`INSERT INTO organizations (id, slug, name, settings, is_sample) VALUES (${orgId}, ${input.slug}, ${input.name}, ${JSON.stringify({ ...DEFAULT_SETTINGS, ...(input.settings ?? {}) })}, ${input.isSample ?? false})`);
    await db.exec(sql`INSERT INTO users (id, org_id, email, name, password_hash) VALUES (${ownerId}, ${orgId}, ${input.ownerEmail.toLowerCase()}, ${input.ownerName}, ${await hashPassword(input.ownerPassword)})`);
    await db.exec(sql`INSERT INTO user_roles (org_id, user_id, role) VALUES (${orgId}, ${ownerId}, 'owner'), (${orgId}, ${ownerId}, 'member')`);
    for (const [name, type, content] of [['標準SOP', 'sop', SOP_TEMPLATE], ['チェックリスト', 'checklist', CHECKLIST_TEMPLATE], ['社内規程', 'policy', POLICY_TEMPLATE], ['FAQ', 'faq', FAQ_TEMPLATE]] as const) {
      await db.exec(sql`INSERT INTO templates (org_id, name, doc_type, content, is_default) VALUES (${orgId}, ${name}, ${type}, ${JSON.stringify(content)}, true)`);
    }
    await db.exec(sql`INSERT INTO audit_events (org_id, actor_label, action, target_type, target_id, summary) VALUES (${orgId}, 'system', 'org.provision', 'organization', ${orgId}, ${`組織「${input.name}」を開設`})`);
  });
  return { orgId, ownerId };
}
