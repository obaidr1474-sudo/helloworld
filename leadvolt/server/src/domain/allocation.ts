/**
 * Allocation rule engine. Rules are evaluated by ascending priority; the first rule whose
 * conditions match picks an agent from its pool with its strategy.
 */
export type Op = 'eq' | 'neq' | 'in' | 'nin' | 'gte' | 'lte' | 'contains';
export interface Condition { field: string; op: Op; value: unknown }
export type Strategy = 'round_robin' | 'least_loaded' | 'sticky_owner' | 'manual_pool';

export interface RuleDefinition {
  conditions: { all?: Condition[]; any?: Condition[] };
  strategy: Strategy;
  pool: { userIds?: string[]; teamId?: string; onlyClockedIn?: boolean; respectCapacity?: boolean };
  sla?: { firstResponseMinutes?: number; reassignAfterMinutes?: number };
}

export interface Rule { id: string; name: string; priority: number; definition: RuleDefinition; rr_cursor: number }

export interface Agent {
  id: string;
  team_id: string | null;
  is_active: boolean;
  is_clocked_in: boolean;
  capacity_max_open_leads: number | null;
  open_leads: number;
}

export interface LeadFacts { [k: string]: unknown }

function get(obj: LeadFacts, path: string): unknown {
  return path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), obj);
}

export function evalCondition(facts: LeadFacts, c: Condition): boolean {
  const v = get(facts, c.field);
  switch (c.op) {
    case 'eq': return v === c.value;
    case 'neq': return v !== c.value;
    case 'in': return Array.isArray(c.value) && c.value.includes(v);
    case 'nin': return Array.isArray(c.value) && !c.value.includes(v);
    case 'gte': return typeof v === 'number' && v >= Number(c.value);
    case 'lte': return typeof v === 'number' && v <= Number(c.value);
    case 'contains': return Array.isArray(v) ? v.includes(c.value) : typeof v === 'string' && v.toLowerCase().includes(String(c.value).toLowerCase());
    default: return false;
  }
}

export function ruleMatches(facts: LeadFacts, def: RuleDefinition): boolean {
  const all = def.conditions?.all ?? [];
  const any = def.conditions?.any ?? [];
  return all.every((c) => evalCondition(facts, c)) && (any.length === 0 || any.some((c) => evalCondition(facts, c)));
}

export interface AllocationResult { agentId: string | null; ruleId: string | null; strategy: Strategy | 'none'; nextCursor?: number; reason: string }

export function pickAgent(rule: Rule, agents: Agent[], stickyOwnerId?: string | null): AllocationResult {
  const def = rule.definition;
  let pool = agents.filter((a) => a.is_active);
  if (def.pool.userIds?.length) pool = pool.filter((a) => def.pool.userIds!.includes(a.id));
  if (def.pool.teamId) pool = pool.filter((a) => a.team_id === def.pool.teamId);
  if (def.strategy === 'sticky_owner' && stickyOwnerId && pool.some((a) => a.id === stickyOwnerId)) {
    return { agentId: stickyOwnerId, ruleId: rule.id, strategy: 'sticky_owner', reason: 'Returned to previous owner' };
  }
  if (def.pool.onlyClockedIn) pool = pool.filter((a) => a.is_clocked_in);
  if (def.pool.respectCapacity !== false) pool = pool.filter((a) => a.capacity_max_open_leads==null || a.open_leads < a.capacity_max_open_leads);
  if (def.strategy === 'manual_pool' || pool.length === 0) {
    return { agentId: null, ruleId: rule.id, strategy: def.strategy, reason: pool.length ? 'Left in unassigned pool' : 'No eligible agent available' };
  }
  pool.sort((a, b) => a.id.localeCompare(b.id));
  if (def.strategy === 'least_loaded') {
    const a = pool.slice().sort((x, y) => x.open_leads - y.open_leads || x.id.localeCompare(y.id))[0];
    return { agentId: a.id, ruleId: rule.id, strategy: 'least_loaded', reason: 'Fewest open leads' };
  }
  const idx = Number(rule.rr_cursor % pool.length);
  return { agentId: pool[idx].id, ruleId: rule.id, strategy: 'round_robin', nextCursor: Number(rule.rr_cursor) + 1, reason: 'Round robin' };
}

export function allocate(facts: LeadFacts, rules: Rule[], agents: Agent[], stickyOwnerId?: string | null): AllocationResult {
  const sorted = rules.slice().sort((a, b) => a.priority - b.priority);
  for (const r of sorted) if (ruleMatches(facts, r.definition)) return pickAgent(r, agents, stickyOwnerId);
  return { agentId: null, ruleId: null, strategy: 'none', reason: 'No allocation rule matched' };
}

export const DEFAULT_RULE: RuleDefinition = {
  conditions: { all: [] },
  strategy: 'round_robin',
  pool: { onlyClockedIn: false, respectCapacity: true },
  sla: { firstResponseMinutes: 15 },
};
