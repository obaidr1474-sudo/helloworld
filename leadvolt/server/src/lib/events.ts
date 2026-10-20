import type { Tx } from './db.js';

export type DomainEventType =
  | 'listing.mapping_changed' | 'routing.exception' | 'auth.session_revoked' | 'auth.revoked' | 'lead.created' | 'lead.updated' | 'lead.stage_changed' | 'lead.assigned' | 'lead.reenquired'
  | 'interaction.created' | 'message.queued' | 'message.failed' | 'message.received' | 'message.updated' | 'message.sent' | 'task.created' | 'task.updated'
  | 'task.due_soon' | 'sla.breached' | 'property.created' | 'property.updated' | 'match.found'
  | 'share_link.opened' | 'deal.updated' | 'deal.booked' | 'attendance.changed';

export interface EventPayload {
  lead_id?: string;
  owner_id?: string | null;
  user_ids?: string[];
  team_id?: string | null;
  [k: string]: unknown;
}

/** Transactional outbox: the event is visible to the dispatcher only if the transaction commits. */
export async function emit(tx: Tx, tenantId: string, type: DomainEventType, payload: EventPayload) {
  await tx.query('INSERT INTO outbox_events (tenant_id, type, payload) VALUES ($1, $2, $3)', [tenantId, type, payload]);
}

export async function audit(tx: Tx, tenantId: string, actorId: string | null, entity: string, entityId: string | null, action: string, diff?: unknown) {
  await tx.query('INSERT INTO audit_log (tenant_id, actor_id, entity, entity_id, action, diff) VALUES ($1,$2,$3,$4,$5,$6)', [
    tenantId, actorId, entity, entityId, action, diff ?? null,
  ]);
}
