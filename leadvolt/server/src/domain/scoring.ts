import type { Stage } from './pipeline.js';

export interface Requirements {
  purpose?: 'buy' | 'rent' | 'invest' | '';
  offering?: 'ready' | 'off_plan' | 'any';
  types?: string[];
  beds?: number | null;
  budgetMin?: number | null;
  budgetMax?: number | null;
  communities?: string[];
}

export const SOURCE_WEIGHT: Record<string, number> = {
  referral: 20, walk_in: 18, channel_partner: 16, website: 15, bayut: 14, property_finder: 14, ivr: 14,
  whatsapp: 12, dubizzle: 10, google: 10, facebook: 8, other: 6,
};

export interface ScoreInput {
  source: string;
  stage: Stage;
  requirements: Requirements;
  inboundCount: number;
  connectedCalls: number;
  reenquiryCount: number;
  lastActivityAt: Date | null;
  /** number of available units within budget (from matching) */
  inventoryFit: number;
}

export const STAGE_BONUS: Record<Stage, number> = { new: 0, contacted: 4, meeting: 12, site_visit: 18, eoi: 24, booked: 30, lost: 0 };

/** Rules-based v1 lead score (0-100). Deterministic, explainable, cheap to recompute on every event. */
export function scoreLead(i: ScoreInput, now = new Date()): number {
  let s = SOURCE_WEIGHT[i.source] ?? 6;
  const r = i.requirements ?? {};
  const filled = [r.purpose, r.types?.length, r.beds !== null && r.beds !== undefined ? 1 : 0, r.budgetMax, r.communities?.length].filter(Boolean).length;
  s += filled * 4;
  s += Math.min(15, i.inventoryFit * 5);
  s += Math.min(20, i.inboundCount * 5 + i.connectedCalls * 6);
  s += STAGE_BONUS[i.stage] ?? 0;
  s += Math.min(10, i.reenquiryCount * 5);
  if (i.lastActivityAt && now.getTime() - i.lastActivityAt.getTime() > 7 * 86_400_000) s -= 10;
  if (i.stage === 'lost') s = Math.min(s, 15);
  return Math.max(0, Math.min(100, Math.round(s)));
}

export const temperatureOf = (score: number): 'hot' | 'warm' | 'cold' => (score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold');
