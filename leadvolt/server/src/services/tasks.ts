import type { Tx } from '../lib/db.js';
import { emit } from '../lib/events.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { addInteraction, assertCanWrite, isManager, loadLead, type Actor } from './leads.js';

export interface TaskInput { leadId?: string | null; assigneeId?: string; type: string; title: string; notes?: string; dueAt: string; priority?: number; propertyId?: string | null }

export async function createTask(tx: Tx, actor: Actor, t: TaskInput) {
  if(!isManager(actor)&&actor.role!=='agent') throw forbidden('Your role cannot create tasks.');
  const due = new Date(t.dueAt);
  if (Number.isNaN(due.getTime())) throw badRequest('The due date is not valid.');
  const assignee = t.assigneeId ?? actor.id;
  if (!assignee) throw badRequest('Choose who the task is for.');
  if (assignee !== actor.id && !isManager(actor)) throw forbidden('Only managers can create tasks for other agents.');
  if (t.leadId) assertCanWrite(actor, await loadLead(tx, actor.tenantId, t.leadId));
  const { rows: [task] } = await tx.query(
    `INSERT INTO tasks (tenant_id, lead_id, property_id, assignee_id, created_by, type, title, notes, due_at, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [actor.tenantId, t.leadId ?? null, t.propertyId ?? null, assignee, actor.id, t.type, t.title.trim(), t.notes ?? null, due, t.priority ?? 2]);
  if (t.leadId) {
    await tx.query(`UPDATE leads SET next_action_at = LEAST(COALESCE(next_action_at, $3), $3), updated_at = now(), version = version + 1
                     WHERE tenant_id = $1 AND id = $2`, [actor.tenantId, t.leadId, due]);
    await addInteraction(tx, actor.tenantId, t.leadId, actor.id, 'task', `Task created: ${task.title} · due ${due.toISOString()}`, { direction: 'internal' });
  }
  await emit(tx, actor.tenantId, 'task.created', { task_id: task.id, lead_id: t.leadId ?? undefined, owner_id: assignee });
  return task;
}

export async function setTaskStatus(tx: Tx, actor: Actor, id: string, status: 'open' | 'done' | 'cancelled', outcome?: string) {
  const { rows: [task] } = await tx.query(`SELECT * FROM tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [actor.tenantId, id]);
  if(!task) throw notFound('Task');
  if(!isManager(actor)&&actor.role!=='agent') throw forbidden('Your role cannot update tasks.');
  if(task.lead_id) assertCanWrite(actor,await loadLead(tx,actor.tenantId,task.lead_id,true));
  if (task.assignee_id !== actor.id && !isManager(actor)) throw forbidden('This task belongs to another agent.');
  if(task.status===status)return task;
  const { rows: [u] } = await tx.query(
    `UPDATE tasks SET status = $3, completed_at = CASE WHEN $3 = 'done' THEN now() ELSE NULL END, outcome = COALESCE($4, outcome), updated_at = now()
      WHERE tenant_id = $1 AND id = $2 RETURNING *`, [actor.tenantId, id, status, outcome ?? null]);
  if (task.lead_id) {
    // next_action_at mirrors the earliest open task
    await tx.query(`UPDATE leads SET next_action_at = (SELECT min(due_at) FROM tasks WHERE tenant_id = $1 AND lead_id = $2 AND status = 'open'),
                    last_agent_update_at=CASE WHEN owner_id=$3 AND $4='done' THEN now() ELSE last_agent_update_at END,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2`,[actor.tenantId,task.lead_id,actor.id,status]);
    if (status === 'done') await addInteraction(tx, actor.tenantId, task.lead_id, actor.id, 'task', `Task done: ${task.title}${outcome ? '\n' + outcome : ''}`, { direction: 'internal' });
  }
  await emit(tx, actor.tenantId, 'task.updated', { task_id: id, lead_id: task.lead_id ?? undefined, owner_id: task.assignee_id, status });
  return u;
}

export async function listTasks(tx: Tx, actor: Actor, p: { queue?: 'overdue' | 'today' | 'upcoming' | 'done'; assigneeId?: string; leadId?: string; tz?: string }) {
  const where = ['t.tenant_id = $1']; const vals: unknown[] = [actor.tenantId];
  const tz=p.tz??(await tx.query('SELECT timezone FROM tenants WHERE id=$1',[actor.tenantId])).rows[0].timezone;
  if (!isManager(actor)) { vals.push(actor.id); where.push(`t.assignee_id = $${vals.length} AND (t.lead_id IS NULL OR l.owner_id=$${vals.length})`); }
  else if (p.assigneeId) { vals.push(p.assigneeId); where.push(`t.assignee_id = $${vals.length}`); }
  if (p.leadId) { vals.push(p.leadId); where.push(`t.lead_id = $${vals.length}`); }
  const endOfToday = () => { vals.push(tz); const tzp = `$${vals.length}`; return `((date_trunc('day', now() AT TIME ZONE ${tzp}) + interval '1 day') AT TIME ZONE ${tzp})`; };
  switch (p.queue) {
    case 'overdue': where.push(`t.status = 'open' AND t.due_at < now()`); break;
    case 'today': where.push(`t.status = 'open' AND t.due_at >= now() AND t.due_at < ${endOfToday()}`); break;
    case 'upcoming': where.push(`t.status = 'open' AND t.due_at >= ${endOfToday()}`); break;
    case 'done': where.push(`t.status = 'done'`); break;
  }
  const order = p.queue === 'done' ? 't.completed_at DESC' : 't.due_at ASC';
  const { rows } = await tx.query(
    `SELECT t.*, l.full_name AS lead_name, u.full_name AS assignee_name FROM tasks t
       LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 300`, vals);
  return rows;
}
