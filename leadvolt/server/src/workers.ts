import { dispatchQueuedMessages } from './services/delivery.js';
import type { FastifyBaseLogger } from 'fastify';
import { assignInternal,loadLead } from './services/leads.js';
import { withSystem } from './lib/db.js';
import { emit } from './lib/events.js';

/**
 * SLA monitor: marks new leads whose first-response deadline passed, notifies owner and managers, and
 * (if the tenant enables settings.sla_auto_reassign) moves the lead to the least-loaded clocked-in agent.
 * Task reminders: tasks due within 15 minutes notify their assignee once.
 */
export async function runSlaSweep(log?: FastifyBaseLogger) {
  return withSystem(async (tx) => {
    const { rows } = await tx.query(
      `SELECT l.id, l.tenant_id, l.owner_id,l.routing_mode,l.full_name, (t.settings->>'sla_auto_reassign')::boolean AS auto_reassign
         FROM leads l JOIN tenants t ON t.id = l.tenant_id
        WHERE l.first_response_at IS NULL AND l.sla_breached_at IS NULL AND l.deleted_at IS NULL AND l.stage = 'new' AND l.sla_due_at < now()
        ORDER BY l.sla_due_at LIMIT 200 FOR UPDATE OF l SKIP LOCKED`);
    for (const l of rows) {
      await tx.query(`UPDATE leads SET sla_breached_at = now() WHERE id = $1`, [l.id]);
      await emit(tx, l.tenant_id, 'sla.breached', { lead_id: l.id, owner_id: l.owner_id, name: l.full_name });
      if(l.auto_reassign&&l.routing_mode!=='listing'&&l.owner_id){
        const next = (await tx.query(
          `SELECT u.id FROM users u WHERE u.tenant_id = $1 AND u.is_active AND u.is_clocked_in AND u.role IN ('agent','manager') AND (u.capacity_max_open_leads IS NULL OR (SELECT count(*) FROM leads c WHERE c.tenant_id=u.tenant_id AND c.owner_id=u.id AND c.deleted_at IS NULL AND c.stage NOT IN ('lost','booked'))<u.capacity_max_open_leads) AND u.id IS DISTINCT FROM $2
            ORDER BY (SELECT count(*) FROM leads x WHERE x.owner_id = u.id AND x.deleted_at IS NULL AND x.stage NOT IN ('lost','booked')), u.id LIMIT 1`,
          [l.tenant_id, l.owner_id])).rows[0];
        if (next) {
          const actor={id:null,tenantId:l.tenant_id,role:'system'};
          await assignInternal(tx,actor,await loadLead(tx,l.tenant_id,l.id),next.id,'sla_breach');

        }
      }
    }
    const due = await tx.query(
      `UPDATE tasks SET reminded_at = now() WHERE id IN (
          SELECT id FROM tasks WHERE status = 'open' AND reminded_at IS NULL AND due_at < now() + interval '15 minutes' LIMIT 500 FOR UPDATE SKIP LOCKED)
       RETURNING id, tenant_id, assignee_id, lead_id, title, due_at`);
    for (const t of due.rows) await emit(tx, t.tenant_id, 'task.due_soon', { task_id: t.id, owner_id: t.assignee_id, lead_id: t.lead_id ?? undefined, title: t.title, due_at: t.due_at });
    if (rows.length || due.rowCount) log?.info({ breaches: rows.length, reminders: due.rowCount }, 'sla sweep');
    return { breaches: rows.length, reminders: due.rowCount ?? 0 };
  });
}

export function startWorkers(intervalMs: number, log: FastifyBaseLogger) {
  const timer = setInterval(() => runSlaSweep(log).catch((err) => log.error({ err }, 'sla sweep failed')), intervalMs);
  let sending=false;const deliveries=setInterval(()=>{if(sending)return;sending=true;dispatchQueuedMessages().catch(err=>log.error({err},'message delivery worker failed')).finally(()=>{sending=false;});},2000);
  return ()=>{clearInterval(timer);clearInterval(deliveries);};
}
