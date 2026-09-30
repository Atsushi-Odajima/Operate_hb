import { forbidden } from './errors.js';
import { raw, sql, SQL } from './sql.js';
import type { OrgSettings } from './settings.js';

export const ROLES = ['owner', 'knowledge_admin', 'approver', 'editor', 'trainer', 'member', 'auditor', 'external'] as const;
export type Role = (typeof ROLES)[number];
export const CLASSIFICATIONS = ['public_internal', 'internal', 'confidential', 'restricted'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];
export const classRank = (c: string) => Math.max(0, CLASSIFICATIONS.indexOf(c as Classification));

export interface Actor {
  id: string;
  orgId: string;
  orgName: string;
  name: string;
  email: string;
  roles: Role[];
  deptIds: string[];
  teamIds: string[];
  isExternal: boolean;
  externalExpiresAt: string | null;
  extAllowDownload: boolean;
  extAllowAi: boolean;
  approverScopes: Array<string | null>;
  settings: OrgSettings;
  sessionId: string;
  csrf: string;
}

/** RBAC permission matrix. Resource-level (ABAC) checks are applied on top by the services. */
export const PERMS = {
  'org.settings': ['owner'],
  'ai.settings': ['owner'],
  'user.manage': ['owner'],
  'dept.manage': ['owner', 'knowledge_admin'],
  'doc.create': ['owner', 'knowledge_admin', 'editor'],
  'doc.admin': ['owner', 'knowledge_admin'],
  'doc.readAll': ['owner', 'knowledge_admin', 'auditor'],
  'doc.approve': ['owner', 'knowledge_admin', 'approver'],
  'doc.review': ['owner', 'knowledge_admin', 'approver', 'editor', 'trainer'],
  'template.manage': ['owner', 'knowledge_admin'],
  'training.manage': ['owner', 'knowledge_admin', 'trainer'],
  'training.report': ['owner', 'knowledge_admin', 'trainer', 'auditor'],
  'attestation.manage': ['owner', 'knowledge_admin'],
  'attestation.report': ['owner', 'knowledge_admin', 'auditor'],
  'health.read': ['owner', 'knowledge_admin', 'auditor'],
  'analytics.read': ['owner', 'knowledge_admin'],
  'feedback.manage': ['owner', 'knowledge_admin'],
  'audit.read': ['owner', 'auditor'],
  'audit.export': ['owner', 'auditor'],
  'external.manage': ['owner', 'knowledge_admin'],
  'import': ['owner', 'knowledge_admin', 'editor'],
  'backup': ['owner'],
  'ai.historical': ['owner', 'knowledge_admin', 'auditor'],
  'directory.read': ['owner', 'knowledge_admin', 'approver', 'editor', 'trainer', 'member', 'auditor'],
} as const satisfies Record<string, readonly Role[]>;
export type Perm = keyof typeof PERMS;

export function has(a: Actor, p: Perm): boolean {
  if (a.isExternal) return false; // external members have no management permissions
  return (PERMS[p] as readonly Role[]).some((r) => a.roles.includes(r));
}
export function need(a: Actor, p: Perm) {
  if (!has(a, p)) throw forbidden();
}

const uuidArr = (xs: string[]) => sql`${xs}::uuid[]`;
const textArr = (xs: string[]) => sql`${xs}::text[]`;

function audienceMatch(a: Actor, d: SQL): SQL {
  const deptT = a.deptIds;
  const teamT = a.teamIds;
  if (a.isExternal) {
    return sql`EXISTS (SELECT 1 FROM document_audiences da WHERE da.document_id = ${d}.id AND (
      (da.kind = 'user' AND da.target = ${a.id}) OR (da.kind = 'department' AND da.target = ANY(${textArr(deptT)}))))`;
  }
  return sql`EXISTS (SELECT 1 FROM document_audiences da WHERE da.document_id = ${d}.id AND (
      (da.kind = 'department' AND da.target = ANY(${textArr(deptT)}))
   OR (da.kind = 'team' AND da.target = ANY(${textArr(teamT)}))
   OR (da.kind = 'role' AND da.target = ANY(${textArr(a.roles)}))
   OR (da.kind = 'user' AND da.target = ${a.id})))`;
}

/**
 * Who may read the CURRENT PUBLISHED version of a document (list, view, search, AI retrieval, notifications, export).
 * - Owner / Knowledge Admin / Auditor: every document of the organization.
 * - Internal users: Published + (audience "全社" unless Restricted, explicit audience match, or document owner).
 * - External members: Published + explicitly shared to them (user or allowed department) + classification <= externalMax.
 *   "全社" audience never includes external members.
 */
export function docReadable(a: Actor, alias = 'd'): SQL {
  const d = raw(alias);
  if (has(a, 'doc.readAll')) return raw('TRUE');
  const published = sql`(${d}.status = 'published' AND ${d}.current_version_id IS NOT NULL)`;
  if (a.isExternal) {
    const allowed = a.settings.classification.externalAllowed;
    return sql`(${published} AND ${d}.classification = ANY(${textArr(allowed)}) AND ${audienceMatch(a, d)})`;
  }
  return sql`(${published} AND ((${d}.audience_all AND ${d}.classification <> 'restricted') OR ${d}.owner_id = ${a.id}::uuid OR ${audienceMatch(a, d)}))`;
}

/** Who may edit drafts / propose new versions of a document. */
export function docEditable(a: Actor, alias = 'd'): SQL {
  const d = raw(alias);
  if (a.isExternal) return raw('FALSE');
  if (has(a, 'doc.admin')) return raw('TRUE');
  if (!a.roles.includes('editor')) return raw('FALSE');
  return sql`(${d}.owner_id = ${a.id}::uuid OR ${d}.created_by = ${a.id}::uuid OR ${d}.department_id = ANY(${uuidArr(a.deptIds)}))`;
}

/** Reviewer / approver assigned to any working version of the document. */
export function docWorkflowParticipant(a: Actor, alias = 'd'): SQL {
  const d = raw(alias);
  return sql`(EXISTS (SELECT 1 FROM review_assignments ra JOIN review_requests rr ON rr.id = ra.review_id
                        JOIN document_versions v ON v.id = rr.version_id
                       WHERE v.document_id = ${d}.id AND ra.reviewer_id = ${a.id}::uuid AND rr.status = 'open')
           OR EXISTS (SELECT 1 FROM approval_step_approvers sa JOIN approval_steps st ON st.id = sa.step_id
                        JOIN document_versions v ON v.id = st.version_id
                       WHERE v.document_id = ${d}.id AND sa.approver_id = ${a.id}::uuid AND sa.active
                         AND v.status IN ('pending_approval','approved','scheduled')))`;
}

/** May open the document page (published view, or working draft as editor/reviewer/approver). */
export function docAccessible(a: Actor, alias = 'd'): SQL {
  if (a.isExternal) return docReadable(a, alias);
  return sql`(${docReadable(a, alias)} OR ${docEditable(a, alias)} OR ${docWorkflowParticipant(a, alias)})`;
}

/** Can the actor see non-current versions (history)? */
export function canSeeHistory(a: Actor, editable: boolean): boolean {
  return has(a, 'doc.readAll') || editable;
}

export function canApproveForDept(a: Actor, departmentId: string | null): boolean {
  if (a.isExternal) return false;
  if (a.roles.includes('owner') || a.roles.includes('knowledge_admin')) return true;
  if (!a.roles.includes('approver')) return false;
  return a.approverScopes.some((s) => s === null || s === departmentId);
}

export function canDownload(a: Actor, classification: string): boolean {
  if (a.isExternal && !a.extAllowDownload) return false;
  return a.settings.classification.downloadAllowed.includes(classification as Classification);
}

export function canOffline(a: Actor, classification: string): boolean {
  if (a.isExternal && !a.extAllowDownload) return false;
  return a.settings.classification.offlineAllowed.includes(classification as Classification);
}

/** Classifications this actor's AI queries may use as sources. */
export function aiClassifications(a: Actor): string[] {
  const allowed = a.settings.ai.allowedClassifications;
  if (a.isExternal) return allowed.filter((c) => a.settings.classification.externalAllowed.includes(c));
  return allowed;
}
