import type { Requirements } from './scoring.js';

export interface PropertyLike {
  id: string;
  project_name: string;
  community: string;
  property_type: string;
  offering_type: 'ready' | 'off_plan';
  beds: number;
  price: number;
  status: string;
  handover?: string | null;
}

export interface Match<P extends PropertyLike = PropertyLike> {
  property: P;
  score: number;
  reasons: string[];
}

const BUDGET_SLACK = 0.1;

/** Hard filters then weighted soft score: price 40, location 25, beds 15, type 10, offering 10. */
export function matchProperty<P extends PropertyLike>(req: Requirements, p: P): Match<P> | null {
  if (p.status !== 'available') return null;
  const reasons: string[] = [];
  const price = Number(p.price) || 0;
  let pf = 0.5, lf = 0.5, bf = 0.5, tf = 0.5, of = 0.5;

  if (req.budgetMax) {
    const lo = (req.budgetMin ?? 0) * (1 - BUDGET_SLACK);
    const hi = req.budgetMax * (1 + BUDGET_SLACK);
    if (price < lo || price > hi) return null;
    const mid = ((req.budgetMin || req.budgetMax * 0.7) + req.budgetMax) / 2;
    pf = Math.max(0, 1 - Math.abs(price - mid) / mid);
    reasons.push(price <= req.budgetMax ? 'Within budget' : 'Slightly over budget');
  }
  if (req.types?.length) {
    if (!req.types.includes(p.property_type)) return null;
    tf = 1;
    reasons.push(p.property_type);
  }
  if (req.beds !== null && req.beds !== undefined) {
    const diff = Math.abs((p.beds ?? 0) - req.beds);
    if (diff > 1) return null;
    bf = diff === 0 ? 1 : 0.5;
    if (diff === 0) reasons.push(p.beds === 0 ? 'Studio' : `${p.beds} BR match`);
  }
  if (req.communities?.length) {
    lf = req.communities.some((c) => c.toLowerCase() === p.community.toLowerCase()) ? 1 : 0;
    if (lf) reasons.push(p.community);
  }
  if (req.offering && req.offering !== 'any') {
    of = req.offering === p.offering_type ? 1 : 0;
    if (of) reasons.push(p.offering_type === 'off_plan' ? 'Off-plan' : 'Ready');
  }
  const score = Math.round(40 * pf + 25 * lf + 15 * bf + 10 * tf + 10 * of);
  return { property: p, score, reasons };
}

export function rankMatches<P extends PropertyLike>(req: Requirements, props: P[], limit = 20): Match<P>[] {
  return props
    .map((p) => matchProperty(req, p))
    .filter((m): m is Match<P> => m !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/** Count of available units inside the budget band; feeds the lead score. */
export function inventoryFit(req: Requirements, props: PropertyLike[]): number {
  if (!req.budgetMax) return 0;
  return props.filter((p) => p.status === 'available' && p.price <= req.budgetMax! * 1.1 && p.price >= (req.budgetMin ?? 0) * 0.9).length;
}
