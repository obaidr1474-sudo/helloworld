import type { Tx } from '../lib/db.js';
import { emit, audit } from '../lib/events.js';
import { badRequest, conflict, forbidden, notFound, preconditionFailed } from '../lib/errors.js';
import { normalizePhone } from '../lib/phone.js';
import { DISPOSITIONS, dispositionByKey, isActiveStage, validateDisposition, type Stage } from '../domain/pipeline.js';
import { scoreLead, temperatureOf, type Requirements } from '../domain/scoring.js';
import { inventoryFit, rankMatches, type PropertyLike } from '../domain/matching.js';
import { allocate, DEFAULT_RULE, type Agent, type Rule } from '../domain/allocation.js';

export interface Actor { id: string | null; tenantId: string; role: string }

export const MANAGER_ROLES = new Set(['owner', 'admin', 'manager']);
export const isManager = (a: Actor) => MANAGER_ROLES.has(a.role);

export interface LeadRow {
  id: string; tenant_id: string; serial_no: number; full_name: string; phone_e164: string | null; email: string | null;
  owner_id: string | null; original_owner_id: string | null; team_id: string | null; stage: Stage; sub_status: string | null;
  lost_reason: string | null; source: string; sub_source: string | null; campaign: Record<string, unknown>; listing_ref: string | null;
  property_id: string | null; requirements: Requirements; score: number; temperature: 'hot' | 'warm' | 'cold';
  temperature_overridden: boolean; tags: string[]; reenquiry_count: number; inbound_count: number; connected_calls: number;
  deal_value: number | null; first_response_at: Date | null; last_contacted_at: Date | null; last_inbound_at: Date | null;
  next_action_at: Date | null; sla_due_at: Date | null; sla_breached_at: Date | null; created_at: Date; updated_at: Date; version: number;
}

export function leadDto(r: LeadRow) {
  return {
    id: r.id, serialNo: r.serial_no, name: r.full_name, phone: r.phone_e164, email: r.email, ownerId: r.owner_id,
    teamId: r.team_id, stage: r.stage, subStatus: r.sub_status, lostReason: r.lost_reason, source: r.source, subSource: r.sub_source,
    campaign: r.campaign, listingRef: r.listing_ref, propertyId: r.property_id, requirements: r.requirements, score: r.score,
    temperature: r.temperature, temperatureOverridden: r.temperature_overridden, tags: r.tags, reenquiryCount: r.reenquiry_count,
    dealValue: r.deal_value, firstResponseAt: r.first_response_at, lastContactedAt: r.last_contacted_at, lastInboundAt: r.last_inbound_at,
    nextActionAt: r.next_action_at, slaDueAt: r.sla_due_at, slaBreached: !!r.sla_breached_at, createdAt: r.created_at,
    updatedAt: r.updated_at, version: r.version,
  };
}
export type LeadDto = ReturnType<typeof leadDto>;

// ---------------------------------------------------------------- access

export function assertCanRead(actor: Actor, lead: Pick<LeadRow, 'owner_id'>) {
  if (isManager(actor) || actor.role === 'viewer') return;
  if (lead.owner_id === null || lead.owner_id === actor.id) return;
  throw forbidden('This lead belongs to another agent.');
}
export function assertCanWrite(actor: Actor, lead: Pick<LeadRow, 'owner_id'>) {
  if (actor.role === 'viewer') throw forbidden('Viewers cannot change leads.');
  assertCanRead(actor, lead);
}

export async function loadLead(tx: Tx, tenantId: string, id: string, lock = false): Promise<LeadRow> {
  const { rows } = await tx.query<LeadRow>(
    `SELECT * FROM leads WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL ${lock ? 'FOR UPDATE' : ''}`, [tenantId, id]);
  if (!rows[0]) throw notFound('Lead');
  return rows[0];
}

async function addInteraction(tx: Tx, tenantId: string, leadId: string, userId: string | null, type: string, summary: string,
  opts: { direction?: 'inbound' | 'outbound' | 'internal'; payload?: unknown; confidential?: boolean; externalId?: string } = {}) {
  const { rows } = await tx.query(
    `INSERT INTO interactions (tenant_id, lead_id, user_id, type, direction, summary, payload, is_confidential, external_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [tenantId, leadId, userId, type, opts.direction ?? null, summary, opts.payload ?? {}, opts.confidential ?? false, opts.externalId ?? null]);
  await emit(tx, tenantId, 'interaction.created', { lead_id: leadId, interaction_id: rows[0].id, type, summary: opts.confidential ? 'Confidential note' : summary });
  return rows[0];
}
export { addInteraction };

// ---------------------------------------------------------------- scoring

export async function availableProperties(tx: Tx, tenantId: string): Promise<(PropertyLike & Record<string, unknown>)[]> {
  const { rows } = await tx.query(
    `SELECT id, reference, project_name, community, property_type, offering_type, beds, baths, area_sqft, price, status, handover, brochure_url
       FROM properties WHERE tenant_id = $1 AND status = 'available' AND deleted_at IS NULL`, [tenantId]);
  return rows;
}

export async function rescore(tx: Tx, tenantId: string, lead: LeadRow, props?: PropertyLike[]): Promise<{ score: number; temperature: string }> {
  const inv = props ?? (await availableProperties(tx, tenantId));
  const last = [lead.last_contacted_at, lead.last_inbound_at, lead.created_at].filter(Boolean).map((d) => new Date(d as Date).getTime());
  const score = scoreLead({
    source: lead.source, stage: lead.stage, requirements: lead.requirements ?? {}, inboundCount: lead.inbound_count,
    connectedCalls: lead.connected_calls, reenquiryCount: lead.reenquiry_count,
    lastActivityAt: last.length ? new Date(Math.max(...last)) : null, inventoryFit: inventoryFit(lead.requirements ?? {}, inv),
  });
  const temperature = lead.temperature_overridden ? lead.temperature : temperatureOf(score);
  if (score !== lead.score || temperature !== lead.temperature) {
    await tx.query('UPDATE leads SET score = $3, temperature = $4 WHERE tenant_id = $1 AND id = $2', [tenantId, lead.id, score, temperature]);
  }
  return { score, temperature };
}

// ---------------------------------------------------------------- allocation

async function loadAllocationContext(tx: Tx, tenantId: string) {
  const rules = (await tx.query<Rule & { is_enabled: boolean }>(
    `SELECT id, name, priority, definition, rr_cursor FROM allocation_rules WHERE tenant_id = $1 AND is_enabled ORDER BY priority FOR UPDATE`, [tenantId])).rows;
  const agents = (await tx.query<Agent>(
    `SELECT u.id, u.team_id, u.is_active, u.is_clocked_in, u.capacity_max_open_leads,
            (SELECT count(*)::int FROM leads l WHERE l.tenant_id = u.tenant_id AND l.owner_id = u.id AND l.deleted_at IS NULL
               AND l.stage NOT IN ('lost','booked')) AS open_leads
       FROM users u WHERE u.tenant_id = $1 AND u.role IN ('agent','manager') AND u.is_active`, [tenantId])).rows;
  return { rules, agents };
}

export async function runAllocation(tx: Tx, tenantId: string, facts: Record<string, unknown>, sticky?: string | null) {
  let { rules, agents } = await loadAllocationContext(tx, tenantId);
  if (!rules.length) {
    // first allocation in a workspace: provision an editable catch-all rule so round-robin state persists
    await tx.query(`INSERT INTO allocation_rules (tenant_id, name, priority, definition) VALUES ($1, 'Default round robin', 1000, $2)`, [tenantId, DEFAULT_RULE]);
    ({ rules, agents } = await loadAllocationContext(tx, tenantId));
  }
  const result = allocate(facts, rules, agents, sticky);
  if (result.nextCursor !== undefined && result.ruleId) {
    await tx.query('UPDATE allocation_rules SET rr_cursor = $3 WHERE tenant_id = $1 AND id = $2', [tenantId, result.ruleId, result.nextCursor]);
  }
  const rule = rules.find((r) => r.id === result.ruleId);
  return { ...result, sla: rule?.definition.sla };
}

// ---------------------------------------------------------------- intake / create

export interface LeadInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  source: string;
  subSource?: string | null;
  listingRef?: string | null;
  campaign?: Record<string, unknown>;
  requirements?: Requirements;
  note?: string | null;
  ownerId?: string | null | 'auto';
  rawPayload?: unknown;
}

export interface CreateResult { lead: LeadDto; created: boolean; reenquiry: boolean; allocationReason?: string }

export async function createOrReenquire(tx: Tx, actor: Actor, input: LeadInput): Promise<CreateResult> {
  const tenantId = actor.tenantId;
  const phone = normalizePhone(input.phone);
  const email = input.email?.trim().toLowerCase() || null;
  if (!phone && !email) throw badRequest('A lead needs a phone number or an email address.');
  if (!input.name?.trim()) throw badRequest('A lead needs a name.');

  // email-only duplicates (phone duplicates are caught by the unique index below)
  let existing: LeadRow | undefined;
  if (!phone && email) {
    existing = (await tx.query<LeadRow>(`SELECT * FROM leads WHERE tenant_id = $1 AND email = $2 AND deleted_at IS NULL FOR UPDATE`, [tenantId, email])).rows[0];
  }

  let lead: LeadRow | undefined;
  if (!existing) {
    const listing = input.listingRef
      ? (await tx.query(`SELECT id FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL
           AND (reference = $2 OR EXISTS (SELECT 1 FROM jsonb_each_text(portal_refs) e WHERE e.value = $2)) LIMIT 1`, [tenantId, input.listingRef])).rows[0]
      : undefined;
    const { rows: [t] } = await tx.query(`UPDATE tenants SET lead_serial_seq = lead_serial_seq + 1 WHERE id = $1 RETURNING lead_serial_seq, settings`, [tenantId]);
    const ins = await tx.query<LeadRow>(
      `INSERT INTO leads (tenant_id, serial_no, full_name, phone_e164, email, source, sub_source, campaign, listing_ref, property_id,
                          requirements, sub_status, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Untouched',$12,$12)
       ON CONFLICT (tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL AND deleted_at IS NULL DO NOTHING
       RETURNING *`,
      [tenantId, t.lead_serial_seq, input.name.trim(), phone, email, input.source, input.subSource ?? null, input.campaign ?? {},
        input.listingRef ?? null, listing?.id ?? null, input.requirements ?? {}, actor.id]);
    lead = ins.rows[0];
    if (!lead && phone) {
      existing = (await tx.query<LeadRow>(`SELECT * FROM leads WHERE tenant_id = $1 AND phone_e164 = $2 AND deleted_at IS NULL FOR UPDATE`, [tenantId, phone])).rows[0];
    }
    if (lead) {
      await tx.query(`INSERT INTO lead_enquiries (tenant_id, lead_id, source, sub_source, listing_ref, raw_payload) VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, lead.id, input.source, input.subSource ?? null, input.listingRef ?? null, input.rawPayload ?? {}]);
      await addInteraction(tx, tenantId, lead.id, actor.id, 'system',
        `Lead created from ${input.source}${input.subSource ? ' · ' + input.subSource : ''}${input.note ? '\n' + input.note : ''}`);

      // allocation
      let ownerId: string | null = null; let reason = 'Manual'; let ruleId: string | null = null; let slaMinutes = Number(t.settings?.sla_minutes ?? 15);
      if (input.ownerId === 'auto' || input.ownerId === undefined) {
        const r = await runAllocation(tx, tenantId, { source: lead.source, sub_source: lead.sub_source, requirements: lead.requirements, listing_ref: lead.listing_ref });
        ownerId = r.agentId; reason = r.reason; ruleId = r.ruleId; if (r.sla?.firstResponseMinutes) slaMinutes = r.sla.firstResponseMinutes;
      } else ownerId = input.ownerId;
      await tx.query(`UPDATE leads SET owner_id = $3, original_owner_id = $3, sla_due_at = now() + make_interval(mins => $4) WHERE tenant_id = $1 AND id = $2`,
        [tenantId, lead.id, ownerId, slaMinutes]);
      if (ownerId) {
        await tx.query(`INSERT INTO lead_assignments (tenant_id, lead_id, to_user_id, assigned_by, rule_id, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
          [tenantId, lead.id, ownerId, actor.id, ruleId, input.ownerId === 'auto' || input.ownerId === undefined ? 'rule' : 'manual']);
        await addInteraction(tx, tenantId, lead.id, null, 'assignment', `Assigned (${reason})`, { payload: { to: ownerId, rule_id: ruleId } });
      }
      lead = await loadLead(tx, tenantId, lead.id);
      await rescore(tx, tenantId, lead);
      lead = await loadLead(tx, tenantId, lead.id);
      await emit(tx, tenantId, 'lead.created', { lead_id: lead.id, owner_id: lead.owner_id, name: lead.full_name, source: lead.source });
      await audit(tx, tenantId, actor.id, 'lead', lead.id, 'create');
      return { lead: leadDto(lead), created: true, reenquiry: false, allocationReason: reason };
    }
  }

  if (!existing) throw conflict('Could not create or match this lead. Try again.');
  // ---- re-enquiry on existing lead
  const reopened = existing.stage === 'lost';
  await tx.query(
    `UPDATE leads SET reenquiry_count = reenquiry_count + 1, last_reenquired_at = now(), last_inbound_at = now(), inbound_count = inbound_count + 1,
            stage = CASE WHEN stage = 'lost' THEN 'new' ELSE stage END,
            sub_status = CASE WHEN stage = 'lost' THEN 'Re-enquired' ELSE sub_status END,
            lost_reason = CASE WHEN stage = 'lost' THEN NULL ELSE lost_reason END,
            updated_at = now(), version = version + 1
      WHERE tenant_id = $1 AND id = $2`, [tenantId, existing.id]);
  await tx.query(`INSERT INTO lead_enquiries (tenant_id, lead_id, source, sub_source, listing_ref, raw_payload) VALUES ($1,$2,$3,$4,$5,$6)`,
    [tenantId, existing.id, input.source, input.subSource ?? null, input.listingRef ?? null, input.rawPayload ?? {}]);
  await addInteraction(tx, tenantId, existing.id, actor.id, 'reenquiry',
    `Re-enquired via ${input.source}${input.subSource ? ' · ' + input.subSource : ''}${input.note ? '\n' + input.note : ''}`, { direction: 'inbound' });
  if (!existing.owner_id) {
    const r = await runAllocation(tx, tenantId, { source: input.source, requirements: existing.requirements }, existing.original_owner_id);
    if (r.agentId) await assignInternal(tx, actor, existing, r.agentId, 'reenquiry_sticky');
  }
  let lead2 = await loadLead(tx, tenantId, existing.id);
  await rescore(tx, tenantId, lead2);
  lead2 = await loadLead(tx, tenantId, existing.id);
  await emit(tx, tenantId, 'lead.reenquired', { lead_id: lead2.id, owner_id: lead2.owner_id, name: lead2.full_name, reopened });
  return { lead: leadDto(lead2), created: false, reenquiry: true };
}

// ---------------------------------------------------------------- assignment

async function assignInternal(tx: Tx, actor: Actor, lead: LeadRow, toUserId: string | null, reason: 'manual' | 'sla_breach' | 'reenquiry_sticky' | 'bulk' | 'rule') {
  if (toUserId) {
    const u = (await tx.query(`SELECT id, full_name FROM users WHERE tenant_id = $1 AND id = $2 AND is_active`, [actor.tenantId, toUserId])).rows[0];
    if (!u) throw badRequest('That agent does not exist or is deactivated.');
  }
  if (lead.owner_id === toUserId) return;
  await tx.query(`UPDATE leads SET owner_id = $3, original_owner_id = COALESCE(original_owner_id, $3), updated_at = now(), version = version + 1,
                  updated_by = $4 WHERE tenant_id = $1 AND id = $2`, [actor.tenantId, lead.id, toUserId, actor.id]);
  await tx.query(`UPDATE tasks SET assignee_id = $3, updated_at = now() WHERE tenant_id = $1 AND lead_id = $2 AND status = 'open' AND $3::uuid IS NOT NULL`,
    [actor.tenantId, lead.id, toUserId]);
  await tx.query(`INSERT INTO lead_assignments (tenant_id, lead_id, from_user_id, to_user_id, assigned_by, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor.tenantId, lead.id, lead.owner_id, toUserId, actor.id, reason]);
  await addInteraction(tx, actor.tenantId, lead.id, actor.id, 'assignment', `Reassigned (${reason.replace('_', ' ')})`,
    { payload: { from: lead.owner_id, to: toUserId } });
  await emit(tx, actor.tenantId, 'lead.assigned', { lead_id: lead.id, owner_id: toUserId, user_ids: [lead.owner_id, toUserId].filter(Boolean) as string[], reason });
}

export async function assignLead(tx: Tx, actor: Actor, leadId: string, toUserId: string | null) {
  const lead = await loadLead(tx, actor.tenantId, leadId, true);
  if (!isManager(actor)) {
    // agents may only claim unassigned leads for themselves
    if (!(lead.owner_id === null && toUserId === actor.id)) throw forbidden('Only managers can reassign leads.');
  }
  await assignInternal(tx, actor, lead, toUserId, 'manual');
  return leadDto(await loadLead(tx, actor.tenantId, leadId));
}
export { assignInternal };

// ---------------------------------------------------------------- disposition

export interface DispositionRequest {
  disposition: string;
  subStatus?: string;
  nextActionAt?: string | null;
  dealValue?: number | null;
  propertyId?: string | null;
  note?: string | null;
  assignTo?: string | null;
}

export async function applyDisposition(tx: Tx, actor: Actor, leadId: string, req: DispositionRequest, expectedVersion?: number) {
  const tenantId = actor.tenantId;
  const lead = await loadLead(tx, tenantId, leadId, true);
  assertCanWrite(actor, lead);
  if (expectedVersion !== undefined && expectedVersion !== lead.version) {
    throw preconditionFailed('This lead was updated by someone else. Reload it and try again.', { currentVersion: lead.version });
  }
  const d = dispositionByKey(req.disposition);
  const subStatus = req.subStatus ?? d?.subStatuses[0];
  const err = validateDisposition(lead.stage, { ...req, subStatus });
  if (err || !d) throw badRequest(err ?? 'Invalid status');

  const nextAt = d.requiresNextAction || (d.allowsNextAction && req.nextActionAt) ? new Date(req.nextActionAt!) : null;
  const prop = req.propertyId ? (await tx.query(`SELECT id, project_name FROM properties WHERE tenant_id = $1 AND id = $2`, [tenantId, req.propertyId])).rows[0] : null;

  // close open tasks; the disposition supersedes them
  await tx.query(`UPDATE tasks SET status = 'done', completed_at = now(), outcome = 'Closed by status update', updated_at = now()
                   WHERE tenant_id = $1 AND lead_id = $2 AND status = 'open'`, [tenantId, leadId]);

  const summary = `${d.label}${subStatus ? ' › ' + subStatus : ''}${nextAt ? ' · next ' + nextAt.toISOString() : ''}${prop ? ' · ' + prop.project_name : ''}${d.requiresDealValue ? ' · AED ' + Number(req.dealValue).toLocaleString('en-AE') : ''}${req.note ? '\n' + req.note : ''}`;
  const inter = await addInteraction(tx, tenantId, leadId, actor.id, 'status_change', summary, {
    direction: 'internal',
    payload: { from: { stage: lead.stage, sub_status: lead.sub_status }, to: { stage: d.stage, sub_status: subStatus }, property_id: prop?.id ?? null },
  });

  await tx.query(
    `UPDATE leads SET stage = $3, sub_status = $4, lost_reason = $5, next_action_at = $6,
            deal_value = COALESCE($7, deal_value), first_response_at = COALESCE(first_response_at, now()),
            last_contacted_at = now(), updated_at = now(), updated_by = $8, version = version + 1
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, leadId, d.stage, d.isLost ? null : subStatus, d.isLost ? subStatus : null, nextAt, d.requiresDealValue ? req.dealValue : null, actor.id]);

  let task = null;
  const ownerAfter = req.assignTo !== undefined ? req.assignTo : lead.owner_id;
  if (nextAt) {
    const assignee = ownerAfter ?? actor.id;
    if (assignee) {
      task = (await tx.query(
        `INSERT INTO tasks (tenant_id, lead_id, property_id, assignee_id, created_by, type, title, due_at, source_interaction_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [tenantId, leadId, prop?.id ?? null, assignee, actor.id, d.taskType ?? 'follow_up',
          `${d.label}: ${lead.full_name}${prop ? ' · ' + prop.project_name : ''}`, nextAt, inter.id])).rows[0];
      await emit(tx, tenantId, 'task.created', { lead_id: leadId, task_id: task.id, owner_id: assignee, due_at: nextAt.toISOString() });
    }
  }
  if (d.requiresDealValue) {
    await tx.query(`INSERT INTO deals (tenant_id, lead_id, property_id, agent_id, deal_value) VALUES ($1,$2,$3,$4,$5)`,
      [tenantId, leadId, prop?.id ?? lead.property_id, ownerAfter ?? actor.id, req.dealValue]);
    await emit(tx, tenantId, 'deal.booked', { lead_id: leadId, owner_id: ownerAfter, deal_value: req.dealValue });
  }
  if (req.assignTo !== undefined && req.assignTo !== lead.owner_id) {
    if (!isManager(actor)) throw forbidden('Only managers can reassign leads.');
    await assignInternal(tx, actor, await loadLead(tx, tenantId, leadId), req.assignTo, 'manual');
  }
  let updated = await loadLead(tx, tenantId, leadId);
  await rescore(tx, tenantId, updated);
  updated = await loadLead(tx, tenantId, leadId);
  await emit(tx, tenantId, 'lead.stage_changed', { lead_id: leadId, owner_id: updated.owner_id, from: lead.stage, to: d.stage, version: updated.version });
  await audit(tx, tenantId, actor.id, 'lead', leadId, 'disposition', { from: lead.stage, to: d.stage, sub_status: subStatus });
  return { lead: leadDto(updated), task, interaction: inter };
}

// ---------------------------------------------------------------- patch, notes, calls

export interface LeadPatch {
  name?: string; phone?: string | null; email?: string | null; source?: string; subSource?: string | null;
  requirements?: Requirements; temperature?: 'hot' | 'warm' | 'cold' | null; tags?: string[];
}

export async function patchLead(tx: Tx, actor: Actor, leadId: string, patch: LeadPatch, expectedVersion?: number) {
  const lead = await loadLead(tx, actor.tenantId, leadId, true);
  assertCanWrite(actor, lead);
  if (expectedVersion !== undefined && expectedVersion !== lead.version) throw preconditionFailed('This lead was updated by someone else. Reload it and try again.', { currentVersion: lead.version });
  const sets: string[] = []; const vals: unknown[] = [actor.tenantId, leadId];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (patch.name !== undefined) set('full_name', patch.name.trim());
  if (patch.phone !== undefined) {
    const p = normalizePhone(patch.phone);
    if (patch.phone && !p) throw badRequest('That phone number is not valid.');
    if (p) {
      const dup = (await tx.query(`SELECT serial_no, full_name FROM leads WHERE tenant_id = $1 AND phone_e164 = $2 AND id <> $3 AND deleted_at IS NULL`, [actor.tenantId, p, leadId])).rows[0];
      if (dup) throw conflict(`${dup.full_name} (#${dup.serial_no}) already uses this phone number.`);
    }
    set('phone_e164', p);
  }
  if (patch.email !== undefined) set('email', patch.email?.trim().toLowerCase() || null);
  if (patch.source !== undefined) set('source', patch.source);
  if (patch.subSource !== undefined) set('sub_source', patch.subSource);
  if (patch.requirements !== undefined) set('requirements', patch.requirements);
  if (patch.tags !== undefined) set('tags', patch.tags);
  if (patch.temperature !== undefined) {
    set('temperature_overridden', patch.temperature !== null);
    if (patch.temperature) set('temperature', patch.temperature);
  }
  if (!sets.length) return leadDto(lead);
  set('updated_by', actor.id);
  await tx.query(`UPDATE leads SET ${sets.join(', ')}, updated_at = now(), version = version + 1 WHERE tenant_id = $1 AND id = $2`, vals);
  let updated = await loadLead(tx, actor.tenantId, leadId);
  await rescore(tx, actor.tenantId, updated);
  updated = await loadLead(tx, actor.tenantId, leadId);
  await emit(tx, actor.tenantId, 'lead.updated', { lead_id: leadId, owner_id: updated.owner_id, version: updated.version });
  await audit(tx, actor.tenantId, actor.id, 'lead', leadId, 'update', patch);
  return leadDto(updated);
}

export async function addNote(tx: Tx, actor: Actor, leadId: string, body: string, confidential = false) {
  const lead = await loadLead(tx, actor.tenantId, leadId);
  assertCanWrite(actor, lead);
  if (!body.trim()) throw badRequest('Write a note first.');
  const mentions = [...body.matchAll(/@([\p{L}][\p{L}\-']+)/gu)].map((m) => m[1].toLowerCase());
  let mentioned: string[] = [];
  if (mentions.length) {
    mentioned = (await tx.query(`SELECT id FROM users WHERE tenant_id = $1 AND lower(split_part(full_name, ' ', 1)) = ANY($2)`, [actor.tenantId, mentions])).rows.map((r) => r.id);
  }
  const i = await addInteraction(tx, actor.tenantId, leadId, actor.id, 'note', body.trim(), { direction: 'internal', confidential, payload: { mentions: mentioned } });
  if (mentioned.length) await emit(tx, actor.tenantId, 'lead.updated', { lead_id: leadId, user_ids: mentioned, mention: true });
  return i;
}

export async function logCall(tx: Tx, actor: Actor, leadId: string, call: { direction: 'inbound' | 'outbound'; outcome: string; durationSec?: number; notes?: string; externalId?: string; recordingUrl?: string }) {
  const lead = await loadLead(tx, actor.tenantId, leadId, true);
  assertCanWrite(actor, lead);
  const connected = call.outcome === 'connected';
  const i = await addInteraction(tx, actor.tenantId, leadId, actor.id, 'call',
    `${call.direction === 'inbound' ? 'Incoming' : 'Outgoing'} call · ${call.outcome.replace('_', ' ')}${connected && call.durationSec ? ' · ' + Math.round(call.durationSec / 60) + ' min' : ''}${call.notes ? '\n' + call.notes : ''}`,
    { direction: call.direction, externalId: call.externalId, payload: { outcome: call.outcome, duration_sec: call.durationSec ?? 0, recording_url: call.recordingUrl ?? null } });
  await tx.query(
    `UPDATE leads SET last_contacted_at = now(),
            first_response_at = CASE WHEN $3 = 'outbound' THEN COALESCE(first_response_at, now()) ELSE first_response_at END,
            last_inbound_at = CASE WHEN $3 = 'inbound' THEN now() ELSE last_inbound_at END,
            inbound_count = inbound_count + CASE WHEN $3 = 'inbound' THEN 1 ELSE 0 END,
            connected_calls = connected_calls + CASE WHEN $4 THEN 1 ELSE 0 END,
            updated_at = now(), version = version + 1
      WHERE tenant_id = $1 AND id = $2`, [actor.tenantId, leadId, call.direction, connected]);
  const updated = await loadLead(tx, actor.tenantId, leadId);
  await rescore(tx, actor.tenantId, updated);
  return i;
}

// ---------------------------------------------------------------- queries

export interface ListParams {
  scope?: 'all' | 'mine' | 'unassigned' | 'reenquired' | 'sla';
  queue?: 'active' | 'new' | 'scheduled' | 'overdue' | 'eoi' | 'booked' | 'lost' | 'all';
  source?: string; stage?: Stage; ownerId?: string; temperature?: string; q?: string;
  sort?: 'updated' | 'created' | 'next_action' | 'score';
  cursor?: string; limit?: number; createdFrom?: string; createdTo?: string;
}

const SORTS = {
  updated: { col: 'updated_at', dir: 'desc' },
  created: { col: 'created_at', dir: 'desc' },
  next_action: { col: "COALESCE(next_action_at, 'infinity'::timestamptz)", dir: 'asc' },
  score: { col: 'score', dir: 'desc' },
} as const;

function leadWhere(actor: Actor, p: ListParams) {
  const where: string[] = ['tenant_id = $1', 'deleted_at IS NULL']; const vals: unknown[] = [actor.tenantId];
  const add = (sql: string, ...v: unknown[]) => { let s = sql; for (const x of v) { vals.push(x); s = s.replace('?', `$${vals.length}`); } where.push(s); };
  if (!isManager(actor) && actor.role !== 'viewer') add('(owner_id = ? OR owner_id IS NULL)', actor.id);
  switch (p.scope) {
    case 'mine': add('owner_id = ?', actor.id); break;
    case 'unassigned': where.push('owner_id IS NULL'); break;
    case 'reenquired': where.push('reenquiry_count > 0'); break;
    case 'sla': where.push('sla_breached_at IS NOT NULL AND first_response_at IS NULL'); break;
  }
  switch (p.queue ?? 'active') {
    case 'active': where.push(`stage NOT IN ('lost','booked')`); break;
    case 'new': where.push(`stage = 'new'`); break;
    case 'scheduled': where.push(`stage NOT IN ('lost','booked') AND next_action_at >= now()`); break;
    case 'overdue': where.push(`stage NOT IN ('lost','booked') AND next_action_at < now()`); break;
    case 'eoi': where.push(`stage = 'eoi'`); break;
    case 'booked': where.push(`stage = 'booked'`); break;
    case 'lost': where.push(`stage = 'lost'`); break;
  }
  if (p.source) add('source = ?', p.source);
  if (p.stage) add('stage = ?', p.stage);
  if (p.ownerId) p.ownerId === 'none' ? where.push('owner_id IS NULL') : add('owner_id = ?', p.ownerId);
  if (p.temperature) add('temperature = ?', p.temperature);
  if (p.q?.trim()) {
    const term = p.q.trim();
    if (/^#?\d+$/.test(term)) add('(serial_no = ? OR phone_e164 LIKE ?)', Number(term.replace('#', '')), `%${term.replace('#', '')}%`);
    else {
      // Digits inside a person's name are not a phone search (e.g. 'Buyer 01').
      const phoneTerm = /^[+\d\s().-]+$/.test(term) ? term.replace(/\D/g, '') : term;
      add('(full_name ILIKE ? OR email ILIKE ? OR phone_e164 LIKE ?)', `%${term}%`, `%${term}%`, `%${phoneTerm}%`);
    }
  }
  if (p.createdFrom) add('created_at >= ?', p.createdFrom);
  if (p.createdTo) add('created_at < ?', p.createdTo);
  return { where, vals };
}

export async function listLeads(tx: Tx, actor: Actor, p: ListParams) {
  const { where, vals } = leadWhere(actor, p);
  const sort = SORTS[p.sort ?? (p.queue === 'overdue' || p.queue === 'scheduled' ? 'next_action' : 'updated')];
  if (p.cursor) {
    let c;
    try {
      c = JSON.parse(Buffer.from(p.cursor, 'base64url').toString());
      if (!c || typeof c.id !== 'string' || c.v == null) throw new Error();
    } catch { throw badRequest('The page cursor is invalid. Refresh the lead list.'); }
    vals.push(c.v, c.id);
    where.push(`(${sort.col}, id) ${sort.dir === 'desc' ? '<' : '>'} ($${vals.length - 1}, $${vals.length})`);
  }
  const limit = Math.min(Math.max(p.limit ?? 50, 1), 200);
  const { rows } = await tx.query<LeadRow & { _k: unknown }>(
    `SELECT *, ${sort.col} AS _k FROM leads WHERE ${where.join(' AND ')} ORDER BY ${sort.col} ${sort.dir}, id ${sort.dir} LIMIT ${limit + 1}`, vals);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last
    ? Buffer.from(JSON.stringify({ v: last._k instanceof Date ? last._k.toISOString() : last._k === Infinity ? 'infinity' : last._k, id: last.id })).toString('base64url') : null;
  return { items: page.map(leadDto), nextCursor };
}

export async function queueCounts(tx: Tx, actor: Actor, p: ListParams = {}) {
  const { where, vals } = leadWhere(actor, { ...p, queue: 'all' });
  const { rows: [r] } = await tx.query(
    `SELECT count(*)::int AS all,
            count(*) FILTER (WHERE reenquiry_count > 0)::int AS reenquired,
            count(*) FILTER (WHERE stage NOT IN ('lost','booked'))::int AS active,
            count(*) FILTER (WHERE stage = 'new')::int AS new,
            count(*) FILTER (WHERE stage NOT IN ('lost','booked') AND next_action_at >= now())::int AS scheduled,
            count(*) FILTER (WHERE stage NOT IN ('lost','booked') AND next_action_at < now())::int AS overdue,
            count(*) FILTER (WHERE stage = 'eoi')::int AS eoi,
            count(*) FILTER (WHERE stage = 'booked')::int AS booked,
            count(*) FILTER (WHERE stage = 'lost')::int AS lost,
            count(*) FILTER (WHERE owner_id IS NULL AND stage NOT IN ('lost','booked'))::int AS unassigned,
            count(*) FILTER (WHERE sla_breached_at IS NOT NULL AND first_response_at IS NULL)::int AS sla
       FROM leads WHERE ${where.join(' AND ')}`, vals);
  return r;
}

export async function timeline(tx: Tx, actor: Actor, leadId: string, before?: string, limit = 50) {
  const lead = await loadLead(tx, actor.tenantId, leadId);
  assertCanRead(actor, lead);
  const canSeeConfidential = isManager(actor) || lead.owner_id === actor.id;
  const vals: unknown[] = [actor.tenantId, leadId];
  let extra = '';
  if (before) { vals.push(before); extra += ` AND i.occurred_at < $${vals.length}`; }
  if (!canSeeConfidential) extra += ' AND NOT i.is_confidential';
  const { rows } = await tx.query(
    `SELECT i.id, i.type, i.direction, i.summary, i.payload, i.is_confidential, i.occurred_at, i.user_id, u.full_name AS user_name
       FROM interactions i LEFT JOIN users u ON u.id = i.user_id
      WHERE i.tenant_id = $1 AND i.lead_id = $2 ${extra} ORDER BY i.occurred_at DESC LIMIT ${Math.min(limit, 200)}`, vals);
  return rows;
}

export async function matchesForLead(tx: Tx, actor: Actor, leadId: string, limit = 20) {
  const lead = await loadLead(tx, actor.tenantId, leadId);
  assertCanRead(actor, lead);
  const props = await availableProperties(tx, actor.tenantId);
  return rankMatches(lead.requirements ?? {}, props, limit).map((m) => ({ property: m.property, score: m.score, reasons: m.reasons }));
}

export async function softDelete(tx: Tx, actor: Actor, leadId: string) {
  if (!isManager(actor)) throw forbidden('Only managers can delete leads.');
  await loadLead(tx, actor.tenantId, leadId, true);
  await tx.query(`UPDATE leads SET deleted_at = now(), updated_at = now(), version = version + 1 WHERE tenant_id = $1 AND id = $2`, [actor.tenantId, leadId]);
  await audit(tx, actor.tenantId, actor.id, 'lead', leadId, 'delete');
  await emit(tx, actor.tenantId, 'lead.updated', { lead_id: leadId, deleted: true });
}

export const DISPOSITION_CATALOG = DISPOSITIONS;
export { isActiveStage };
