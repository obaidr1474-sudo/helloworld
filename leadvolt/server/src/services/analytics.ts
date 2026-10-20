import type { Tx } from '../lib/db.js';
import { isManager, type Actor } from './leads.js';

export async function overview(tx: Tx, actor: Actor, p: { from?: string; to?: string; agentIds?: string[] }) {
  const vals: unknown[] = [actor.tenantId];
  const conds: ((a: string) => string)[] = [(a) => `${a}tenant_id = $1`, (a) => `${a}deleted_at IS NULL`];
  const addCond = (v: unknown, f: (a: string, n: string) => string) => { vals.push(v); const n = `$${vals.length}`; conds.push((a) => f(a, n)); };
  if (p.from) addCond(p.from, (a, n) => `${a}created_at >= ${n}`);
  if (p.to) addCond(p.to, (a, n) => `${a}created_at < ${n}`);
  let userFilter = '';
  if (!isManager(actor) && actor.role !== 'viewer') { addCond(actor.id, (a, n) => `${a}owner_id = ${n}`); userFilter = `AND u.id = $${vals.length}`; }
  else if (p.agentIds?.length) { addCond(p.agentIds, (a, n) => `${a}owner_id = ANY(${n})`); userFilter = `AND u.id = ANY($${vals.length})`; }
  const W = conds.map((f) => f('')).join(' AND ');
  const WL = conds.map((f) => f('l.')).join(' AND ');
  const [totals, sources, agents, sla] = await Promise.all([
    tx.query(`SELECT count(*)::int AS leads,
        count(*) FILTER (WHERE stage = 'new')::int AS untouched,
        count(*) FILTER (WHERE stage = 'contacted')::int AS contacted,
        count(*) FILTER (WHERE stage = 'meeting')::int AS meeting,
        count(*) FILTER (WHERE stage = 'site_visit')::int AS site_visit,
        count(*) FILTER (WHERE stage = 'eoi')::int AS eoi,
        count(*) FILTER (WHERE stage NOT IN ('lost','booked') AND next_action_at >= now())::int AS scheduled,
        count(*) FILTER (WHERE stage NOT IN ('lost','booked'))::int AS active,
        count(*) FILTER (WHERE stage NOT IN ('lost','booked') AND next_action_at < now())::int AS overdue,
        count(*) FILTER (WHERE stage IN ('contacted','meeting','site_visit','eoi','booked'))::int AS prospect,
        count(*) FILTER (WHERE stage IN ('site_visit','eoi','booked'))::int AS opportunity,
        count(*) FILTER (WHERE stage = 'booked')::int AS booked,
        COALESCE(sum(deal_value) FILTER (WHERE stage = 'booked'), 0)::float AS booked_value,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM first_response_at - created_at)) FILTER (WHERE first_response_at IS NOT NULL) AS median_first_response_sec
      FROM leads WHERE ${W}`, vals),
    tx.query(`SELECT source, count(*)::int AS leads, count(*) FILTER (WHERE stage = 'booked')::int AS booked,
        COALESCE(sum(deal_value) FILTER (WHERE stage = 'booked'), 0)::float AS value
      FROM leads WHERE ${W} GROUP BY source ORDER BY leads DESC`, vals),
    tx.query(`SELECT u.id, u.full_name, u.is_clocked_in,
        count(l.*)::int AS leads,
        count(l.*) FILTER (WHERE l.stage NOT IN ('lost','booked'))::int AS active,
        count(l.*) FILTER (WHERE l.stage IN ('site_visit','eoi','booked'))::int AS visit_plus,
        count(l.*) FILTER (WHERE l.stage = 'booked')::int AS booked,
        COALESCE(sum(l.deal_value) FILTER (WHERE l.stage = 'booked'), 0)::float AS value,
        count(l.*) FILTER (WHERE l.stage NOT IN ('lost','booked') AND l.next_action_at < now())::int AS overdue,
        (SELECT count(*)::int FROM interactions i WHERE i.tenant_id = u.tenant_id AND i.user_id = u.id AND i.type = 'call' AND i.lead_id IN (SELECT l.id FROM leads l WHERE ${WL})) AS calls
      FROM users u LEFT JOIN leads l ON l.owner_id = u.id AND ${WL}
      WHERE u.tenant_id = $1 AND u.is_active AND u.role IN ('agent','manager') ${userFilter}
      GROUP BY u.id ORDER BY value DESC, booked DESC`, vals),
    tx.query(`SELECT id, full_name, source, owner_id, created_at FROM leads
      WHERE ${W} AND sla_breached_at IS NOT NULL AND first_response_at IS NULL ORDER BY created_at LIMIT 20`, vals),
  ]);
  const t = totals.rows[0];
  return {
    totals: t,
    funnel: [
      { stage: 'Leads', count: t.leads }, { stage: 'Prospect', count: t.prospect },
      { stage: 'Opportunity', count: t.opportunity }, { stage: 'Booked', count: t.booked },
    ],
    sources: sources.rows,
    agents: agents.rows.map((a) => ({ ...a, conversion: a.leads ? a.booked / a.leads : 0 })),
    slaBreaches: sla.rows,
  };
}
