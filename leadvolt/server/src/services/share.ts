import crypto from 'node:crypto';
import type { Tx } from '../lib/db.js';
import { config } from '../lib/config.js';
import { emit } from '../lib/events.js';
import { badRequest } from '../lib/errors.js';
import { addInteraction, assertCanWrite, loadLead, type Actor } from './leads.js';

export async function createShareLink(tx: Tx, actor: Actor, leadId: string, propertyIds: string[], channel = 'whatsapp') {
  if (!propertyIds.length || propertyIds.length > 5) throw badRequest('Share between 1 and 5 properties at a time.');
  const lead = await loadLead(tx, actor.tenantId, leadId);
  assertCanWrite(actor, lead);
  const props = (await tx.query(`SELECT id, project_name, community, beds, property_type, price, area_sqft, handover, offering_type, brochure_url
      FROM properties WHERE tenant_id = $1 AND id = ANY($2) AND deleted_at IS NULL`, [actor.tenantId, propertyIds])).rows;
  if (props.length !== propertyIds.length) throw badRequest('One or more properties were not found.');
  const code = crypto.randomBytes(18).toString('base64url');
  await tx.query(`INSERT INTO share_links (tenant_id, code, lead_id, created_by, property_ids, channel, expires_at) VALUES ($1,$2,$3,$4,$5,$6, now() + interval '60 days')`,
    [actor.tenantId, code, leadId, actor.id, propertyIds, channel]);
  const url = `${config.publicBaseUrl}/s/${code}`;
  const first = lead.full_name.split(/\s+/)[0];
  const lines = props.map((p, i) => `${i + 1}. ${p.project_name}, ${p.community} · ${p.beds === 0 ? 'Studio' : p.beds + ' BR'} ${p.property_type} · AED ${Number(p.price).toLocaleString('en-AE')}`);
  const message = `Hi ${first}, here ${props.length > 1 ? 'are some options' : 'is an option'} that fit what you're looking for:\n\n${lines.join('\n')}\n\nDetails, floor plans and payment plans: ${url}`;
  await addInteraction(tx, actor.tenantId, leadId, actor.id, 'brochure_shared', `Shared ${props.length} propert${props.length > 1 ? 'ies' : 'y'}: ${props.map((p) => p.project_name).join(', ')}`,
    { direction: 'outbound', payload: { code, property_ids: propertyIds } });
  return { code, url, message, properties: props };
}

/** Public: resolve a share code (no auth). Runs in system scope; records the open. */
export async function openShareLink(tx: Tx, code: string) {
  const link = (await tx.query(`UPDATE share_links SET open_count = open_count + 1, last_opened_at = now()
      WHERE code = $1 AND (expires_at IS NULL OR expires_at > now()) RETURNING *`, [code])).rows[0];
  if (!link) return null;
  const props = (await tx.query(`SELECT project_name, community, property_type, beds, baths, area_sqft, price, currency, handover, offering_type, brochure_url, notes
      FROM properties WHERE tenant_id = $1 AND id = ANY($2) AND deleted_at IS NULL`, [link.tenant_id, link.property_ids])).rows;
  const lead = (await tx.query(`SELECT id, owner_id, full_name FROM leads WHERE id = $1`, [link.lead_id])).rows[0];
  const tenant = (await tx.query(`SELECT name FROM tenants WHERE id = $1`, [link.tenant_id])).rows[0];
  {
    await tx.query(`INSERT INTO interactions (tenant_id, lead_id, type, direction, summary, payload) VALUES ($1,$2,'brochure_opened','inbound',$3,$4)`,
      [link.tenant_id, link.lead_id, `Opened shared properties (view ${link.open_count})`, { code }]);
    await tx.query(`UPDATE leads SET inbound_count = inbound_count + CASE WHEN $2 = 1 THEN 1 ELSE 0 END, last_inbound_at = now() WHERE id = $1`, [link.lead_id, link.open_count]);
    await emit(tx, link.tenant_id, 'share_link.opened', { lead_id: link.lead_id, owner_id: lead?.owner_id, lead_name: lead?.full_name, opens: link.open_count });
  }
  return { tenantName: tenant?.name ?? 'LeadVolt', properties: props };
}
