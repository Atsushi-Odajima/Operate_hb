import { z } from 'zod';

const cls = z.enum(['public_internal', 'internal', 'confidential', 'restricted']);
const docType = z.object({
  requireApproval: z.boolean(),
  approvalSteps: z.number().int().min(1).max(3),
  approvalMode: z.enum(['any', 'all']),
  reviewCycleDays: z.number().int().min(1).max(3650).nullable(),
  requireAttestation: z.boolean(),
});

export const settingsSchema = z.object({
  docTypes: z.object({
    sop: docType, policy: docType, guide: docType, faq: docType, checklist: docType, template: docType, reference: docType,
  }),
  requireChangeSummary: z.boolean(),
  reviewDueSoonDays: z.number().int().min(1).max(90),
  /** What happens when a review date passes: documents stay Published (never auto-expired); 'banner' also warns readers. */
  overduePolicy: z.enum(['flag', 'banner']),
  classification: z.object({
    offlineAllowed: z.array(cls),
    downloadAllowed: z.array(cls),
    externalAllowed: z.array(cls),
  }),
  attestation: z.object({ defaultDueDays: z.number().int().min(1).max(365), requireScroll: z.boolean() }),
  ai: z.object({
    enabled: z.boolean(),
    provider: z.enum(['local', 'anthropic']),
    model: z.string().max(100),
    allowedClassifications: z.array(cls),
    answerEnabled: z.boolean(),
    draftEnabled: z.boolean(),
    quizDraftEnabled: z.boolean(),
    monthlyBudgetUsd: z.number().min(0).max(100000),
    userPerMinute: z.number().int().min(1).max(120),
    orgPerDay: z.number().int().min(1).max(1000000),
    minScore: z.number().min(0).max(1),
  }),
  email: z.object({ enabled: z.boolean() }),
  searchAnalytics: z.object({ enabled: z.boolean(), retentionDays: z.number().int().min(7).max(730) }),
});
export type OrgSettings = z.infer<typeof settingsSchema>;

const t = (requireApproval: boolean, reviewCycleDays: number | null, requireAttestation = false) => ({
  requireApproval, approvalSteps: 1, approvalMode: 'any' as const, reviewCycleDays, requireAttestation,
});

export const DEFAULT_SETTINGS: OrgSettings = {
  docTypes: {
    sop: t(true, 180), policy: t(true, 365, true), guide: t(true, 365), faq: t(false, 180), checklist: t(true, 180),
    template: t(false, 365), reference: t(false, 365),
  },
  requireChangeSummary: true,
  reviewDueSoonDays: 14,
  overduePolicy: 'banner',
  classification: {
    offlineAllowed: ['public_internal', 'internal'],
    downloadAllowed: ['public_internal', 'internal', 'confidential'],
    externalAllowed: ['public_internal', 'internal'],
  },
  attestation: { defaultDueDays: 14, requireScroll: true },
  ai: {
    enabled: false,
    provider: 'local',
    model: '',
    allowedClassifications: ['public_internal', 'internal'],
    answerEnabled: true,
    draftEnabled: true,
    quizDraftEnabled: true,
    monthlyBudgetUsd: 30,
    userPerMinute: 6,
    orgPerDay: 1000,
    minScore: 0.18,
  },
  email: { enabled: false },
  searchAnalytics: { enabled: true, retentionDays: 180 },
};

function deepMerge(base: any, over: any): any {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out: any = { ...base };
  for (const k of Object.keys(base)) if (over && k in over) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export function resolveSettings(stored: unknown): OrgSettings {
  const merged = deepMerge(DEFAULT_SETTINGS, stored ?? {});
  const r = settingsSchema.safeParse(merged);
  return r.success ? r.data : DEFAULT_SETTINGS;
}
