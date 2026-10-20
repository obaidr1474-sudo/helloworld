import crypto from 'node:crypto';
import type { Tx } from '../lib/db.js';
import { emit, audit } from '../lib/events.js';
import { forbidden,notFound,preconditionFailed } from '../lib/errors.js';
import { matchProperty } from '../domain/matching.js';
import { isManager, type Actor } from './leads.js';

export interface PropertyInput {
  reference?: string; projectName: string; developer?: string; community: string; subCommunity?: string;
  offeringType: 'ready' | 'off_plan'; purpose?: 'sale' | 'rent'; propertyType: string; beds: number; baths?: number;
  areaSqft?: number; price: number; handover?: string; status?: string; permitNumber?: string; brochureUrl?: string;
  notes?: string; portalRefs?: Record<string, string>;
}

const canEditInventory = (a: Actor) => isManager(a) || a.role === 'listing_manager';

export async function upsertProperty(tx: Tx, actor: Actor, input:PropertyInput,id?:string,expectedVersion?:number) {
  if (!canEditInventory(actor)) throw forbidden('Only managers and listing managers can change inventory.');
  const ref = input.reference || `LV-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const cols = [ref, input.projectName, input.developer ?? null, input.community, input.subCommunity ?? null, input.offeringType,
    input.purpose ?? 'sale', input.propertyType, input.beds, input.baths ?? null, input.areaSqft ?? null, input.price, input.handover ?? null,
    input.status ?? 'available', input.permitNumber ?? null, input.brochureUrl ?? null, input.notes ?? null, input.portalRefs ?? {}];
  let row;
  if (id) {
    const old = (await tx.query(`SELECT price,status,version FROM properties WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`, [actor.tenantId, id])).rows[0];
    if(!old)throw notFound('Property');
    if(expectedVersion===undefined||expectedVersion!==old.version)throw preconditionFailed('This property changed. Reload it before saving.');
    row = (await tx.query(
      `UPDATE properties SET reference=$3, project_name=$4, developer=$5, community=$6, sub_community=$7, offering_type=$8, purpose=$9,
         property_type=$10, beds=$11, baths=$12, area_sqft=$13, price=$14, handover=$15, status=$16, permit_number=$17, brochure_url=$18,
         notes=$19,portal_refs=$20,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2 RETURNING *`, [actor.tenantId, id, ...cols])).rows[0];
    await emit(tx, actor.tenantId, 'property.updated', { property_id: id, price_dropped: Number(row.price) < Number(old.price) });
    if (Number(row.price) < Number(old.price) || (old.status !== 'available' && row.status === 'available')) await reverseMatch(tx, actor.tenantId, row);
  } else {
    row = (await tx.query(
      `INSERT INTO properties (tenant_id, reference, project_name, developer, community, sub_community, offering_type, purpose, property_type,
         beds, baths, area_sqft, price, handover, status, permit_number, brochure_url, notes, portal_refs, listing_agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`, [actor.tenantId, ...cols, actor.id])).rows[0];
    await emit(tx, actor.tenantId, 'property.created', { property_id: row.id });
    await reverseMatch(tx, actor.tenantId, row);
  }
  await audit(tx, actor.tenantId, actor.id, 'property', row.id, id ? 'update' : 'create');
  return row;
}

/** New or cheaper unit -> notify owners of active leads that now match at >= 70%. */
export async function reverseMatch(tx: Tx, tenantId: string, property: any, threshold = 70) {
  if (property.status !== 'available') return [];
  const { rows } = await tx.query(
    `SELECT id, owner_id, full_name, requirements FROM leads WHERE tenant_id = $1 AND deleted_at IS NULL AND stage NOT IN ('lost','booked')
       AND (requirements->>'budgetMax') IS NOT NULL AND (requirements->>'budgetMax')::numeric * 1.1 >= $2`, [tenantId, property.price]);
  const hits = rows.map((l) => ({ l, m: matchProperty(l.requirements, { ...property, price: Number(property.price) }) })).filter((x) => x.m && x.m.score >= threshold);
  for (const h of hits) {
    await emit(tx, tenantId, 'match.found', { lead_id: h.l.id, owner_id: h.l.owner_id, property_id: property.id, score: h.m!.score, lead_name: h.l.full_name, project: property.project_name });
  }
  return hits.map((h) => ({ leadId: h.l.id, score: h.m!.score }));
}

export async function matchingLeads(tx: Tx, actor: Actor, propertyId: string) {
  const p = (await tx.query(`SELECT * FROM properties WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [actor.tenantId, propertyId])).rows[0];
  if (!p) throw notFound('Property');
  const scope = isManager(actor) ? '' : 'AND owner_id = $2';
  const { rows } = await tx.query(`SELECT id, serial_no, full_name, owner_id, stage, score, requirements FROM leads
     WHERE tenant_id = $1 AND deleted_at IS NULL AND stage NOT IN ('lost','booked') ${scope}`, scope ? [actor.tenantId, actor.id] : [actor.tenantId]);
  return rows.map((l) => ({ lead: { id: l.id, serialNo: l.serial_no, name: l.full_name, ownerId: l.owner_id, stage: l.stage, score: l.score },
    match: matchProperty(l.requirements, { ...p, price: Number(p.price) }) }))
    .filter((x) => x.match).map((x) => ({ lead: x.lead, score: x.match!.score, reasons: x.match!.reasons })).sort((a, b) => b.score - a.score).slice(0, 50);
}
