import type { Tx } from '../lib/db.js';
import { audit, emit } from '../lib/events.js';
import { badRequest, conflict, forbidden, notFound, preconditionFailed } from '../lib/errors.js';
import { assignInternal, isManager, leadDto, loadLead, type Actor } from './leads.js';

export const PORTAL_SOURCES = new Set(['bayut','property_finder','dubizzle']);
export const normalizeReference = (value?: string | null) => value?.trim() || null;
export interface RouteInput {
  source: string; listingRef: string; responsibleAgentId: string | null;
  publisherAgentId?: string | null; publisherAccount?: string | null;
  propertyId?: string | null; enabled?: boolean; notes?: string | null;
}
export async function requireAssignableAgent(tx: Tx, tenantId: string, id: string) {
  const agent = (await tx.query(`SELECT id,full_name,role,is_active FROM users WHERE tenant_id=$1 AND id=$2 FOR SHARE`,[tenantId,id])).rows[0];
  if (!agent || !agent.is_active || !['agent','manager','admin','owner'].includes(agent.role)) throw badRequest('Choose an active agent in this workspace.');
  return agent;
}

/** A row lock serializes first enquiries with mapping changes. No publishing-account inference. */
export async function ensureListingRoute(tx: Tx, tenantId: string, source: string, listingRef: string) {
  await tx.query(`INSERT INTO listing_routes(tenant_id,source,listing_ref,property_id)
    VALUES($1,$2,$3,(SELECT id FROM properties WHERE tenant_id=$1 AND deleted_at IS NULL
      AND (reference=$3 OR portal_refs->>$2=$3) ORDER BY id LIMIT 1))
    ON CONFLICT(tenant_id,source,listing_ref) DO NOTHING`,[tenantId,source,listingRef]);
  const route=(await tx.query(`SELECT r.*,u.is_active AS agent_active,u.role AS agent_role
    FROM listing_routes r LEFT JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.responsible_agent_id
    WHERE r.tenant_id=$1 AND r.source=$2 AND r.listing_ref=$3 FOR UPDATE OF r`,[tenantId,source,listingRef])).rows[0];
  if(route.responsible_agent_id){const agent=(await tx.query('SELECT is_active,role FROM users WHERE tenant_id=$1 AND id=$2 FOR SHARE',[tenantId,route.responsible_agent_id])).rows[0];route.agent_active=agent?.is_active;route.agent_role=agent?.role;}
  return route;
}
export function routeDecision(route: any) {
  if (!route.enabled) return {ownerId:null,status:'manual_review',reason:'Listing routing is paused by an administrator'};
  if (!route.responsible_agent_id) return {ownerId:null,status:'unmapped',reason:'Listing reference has no responsible CRM agent'};
  if (!route.agent_active || !['agent','manager','admin','owner'].includes(route.agent_role)) return {ownerId:null,status:'agent_unavailable',reason:'The mapped agent is inactive or cannot receive leads'};
  return {ownerId:route.responsible_agent_id as string,status:'assigned',reason:'Assigned to the listing’s responsible CRM agent'};
}

export async function listListingRoutes(tx: Tx, actor: Actor, query: {q?:string; unresolved?:boolean; limit?:number; offset?:number}) {
  if (!isManager(actor)) throw forbidden();
  const where = `r.tenant_id=$1 AND ($2::text IS NULL OR r.listing_ref ILIKE '%'||$2||'%' OR a.full_name ILIKE '%'||$2||'%' OR p.project_name ILIKE '%'||$2||'%')
    AND (NOT $3::boolean OR r.responsible_agent_id IS NULL OR NOT r.enabled OR NOT COALESCE(a.is_active,false))`;
  const params=[actor.tenantId,query.q || null,!!query.unresolved];
  const join=`FROM listing_routes r LEFT JOIN users a ON a.tenant_id=r.tenant_id AND a.id=r.responsible_agent_id
    LEFT JOIN users b ON b.tenant_id=r.tenant_id AND b.id=r.publisher_agent_id
    LEFT JOIN properties p ON p.tenant_id=r.tenant_id AND p.id=r.property_id`;
  const {rows}=await tx.query(`SELECT r.*,a.full_name AS agent_name,a.is_active AS agent_active,b.full_name AS publisher_name,p.project_name,
    (SELECT count(*)::int FROM leads l WHERE l.tenant_id=r.tenant_id AND l.listing_route_id=r.id AND l.deleted_at IS NULL AND l.owner_id IS NULL AND l.stage NOT IN ('lost','booked')) AS pending_leads,
    (SELECT max(e.received_at) FROM lead_enquiries e JOIN leads l ON l.id=e.lead_id AND l.tenant_id=e.tenant_id WHERE l.tenant_id=r.tenant_id AND l.listing_route_id=r.id) AS last_enquiry_at
    ${join} WHERE ${where} ORDER BY r.updated_at DESC,r.id LIMIT $4 OFFSET $5`,[...params,query.limit??50,query.offset??0]);
  const total=(await tx.query(`SELECT count(*)::int AS total ${join} WHERE ${where}`,params)).rows[0].total;
  return {items:rows,total};
}

export async function assignPendingListingLeads(tx: Tx, actor: Actor, route: any) {
  if (!route.enabled || !route.responsible_agent_id) return 0;
  await requireAssignableAgent(tx,actor.tenantId,route.responsible_agent_id);
  const {rows}=await tx.query(`SELECT id FROM leads WHERE tenant_id=$1 AND listing_route_id=$2 AND owner_id IS NULL
    AND deleted_at IS NULL AND stage NOT IN ('lost','booked') ORDER BY id FOR UPDATE`,[actor.tenantId,route.id]);
  for (const item of rows) {
    const lead=await loadLead(tx,actor.tenantId,item.id);
    await tx.query(`UPDATE leads SET routing_status='assigned',routing_note='Resolved through listing ownership mapping',property_id=COALESCE($3,property_id)
      WHERE tenant_id=$1 AND id=$2`,[actor.tenantId,lead.id,route.property_id]);
    await assignInternal(tx,actor,lead,route.responsible_agent_id,'listing_mapping');
  }
  return rows.length;
}

export async function saveListingRoute(tx: Tx, actor: Actor, input: RouteInput, id?:string, expectedVersion?:number) {
  if (!isManager(actor)) throw forbidden('Only administrators and managers can map listing ownership.');
  const reference=normalizeReference(input.listingRef);
  if (!reference) throw badRequest('Enter the exact listing reference supplied by the portal.');
  let old:any;
  if (id) {
    old=(await tx.query(`SELECT * FROM listing_routes WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,[actor.tenantId,id])).rows[0];
    if (!old) throw notFound('Listing mapping');
    if (expectedVersion===undefined) throw preconditionFailed('Reload the mapping before editing it.');
    if (expectedVersion!==old.version) throw preconditionFailed('Another administrator changed this mapping. Reload it and try again.');
    if (old.source!==input.source || old.listing_ref!==reference) throw badRequest('A mapping’s portal and reference cannot be changed. Create a separate mapping instead.');
  }
  if (input.responsibleAgentId) await requireAssignableAgent(tx,actor.tenantId,input.responsibleAgentId);
  if (input.publisherAgentId) await requireAssignableAgent(tx,actor.tenantId,input.publisherAgentId);
  if (input.propertyId && !(await tx.query('SELECT 1 FROM properties WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL',[actor.tenantId,input.propertyId])).rowCount) throw badRequest('Choose a property in this workspace.');
  const values=[actor.tenantId,input.source,reference,input.responsibleAgentId,input.publisherAgentId??null,input.publisherAccount?.trim()||null,input.propertyId??null,input.enabled??true,input.notes?.trim()||null,actor.id];
  const row=id
    ? (await tx.query(`UPDATE listing_routes SET responsible_agent_id=$4,publisher_agent_id=$5,publisher_account=$6,property_id=$7,enabled=$8,notes=$9,
        updated_by=$10,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND source=$2 AND listing_ref=$3 RETURNING *`,values)).rows[0]
    : (await tx.query(`INSERT INTO listing_routes(tenant_id,source,listing_ref,responsible_agent_id,publisher_agent_id,publisher_account,property_id,enabled,notes,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) ON CONFLICT(tenant_id,source,listing_ref) DO NOTHING RETURNING *`,values)).rows[0];
  if (!row) throw conflict('This listing reference already exists. Open its mapping to update it.');
  const assigned=await assignPendingListingLeads(tx,actor,row);
  await audit(tx,actor.tenantId,actor.id,'listing_route',row.id,id?'update':'create',{from:old?{responsibleAgentId:old.responsible_agent_id,publisherAgentId:old.publisher_agent_id,enabled:old.enabled}:null,to:input,pendingAssigned:assigned});
  await emit(tx,actor.tenantId,'listing.mapping_changed',{route_id:row.id,assigned});
  return {...row,pendingAssigned:assigned};
}

export async function resolveLeadRouting(tx: Tx, actor: Actor, leadId:string, input:{userId:string;saveMapping:boolean;listingRef?:string;routeVersion?:number}, expectedVersion?:number) {
  if (!isManager(actor)) throw forbidden();
  const snapshot=await loadLead(tx,actor.tenantId,leadId);
  if (snapshot.routing_mode!=='listing') throw badRequest('This enquiry does not use listing-based routing.');
  const reference=normalizeReference(input.listingRef)??snapshot.listing_ref;
  const route=reference?await ensureListingRoute(tx,actor.tenantId,snapshot.source,reference):null;
  const lead=await loadLead(tx,actor.tenantId,leadId,true);
  if (expectedVersion===undefined || lead.version!==expectedVersion) throw preconditionFailed('This lead changed. Reload it before resolving ownership.');
  if (lead.owner_id) throw conflict('This enquiry already has an assigned agent.');
  await requireAssignableAgent(tx,actor.tenantId,input.userId);
  if (input.saveMapping && !route) throw badRequest('A listing reference is required to remember ownership for future enquiries.');
  if (route) await tx.query(`UPDATE leads SET listing_ref=$3,listing_route_id=$4,opportunity_key=$5 WHERE tenant_id=$1 AND id=$2`,[actor.tenantId,lead.id,reference,route.id,`${lead.source}:${reference}`]);
  if (input.saveMapping && route) {
    if (route.responsible_agent_id && route.responsible_agent_id!==input.userId && input.routeVersion!==route.version) throw preconditionFailed('This listing already has a different owner. Review its mapping first.');
    const saved=await saveListingRoute(tx,actor,{source:route.source,listingRef:route.listing_ref,responsibleAgentId:input.userId,publisherAgentId:route.publisher_agent_id,publisherAccount:route.publisher_account,propertyId:route.property_id,enabled:true,notes:route.notes},route.id,route.version);
    return {lead:leadDto(await loadLead(tx,actor.tenantId,lead.id)),pendingAssigned:saved.pendingAssigned};
  }
  await tx.query(`UPDATE leads SET routing_status='assigned',routing_note='One-off administrator assignment; future enquiries still require a listing mapping' WHERE tenant_id=$1 AND id=$2`,[actor.tenantId,lead.id]);
  await assignInternal(tx,actor,lead,input.userId,'manual');
  await audit(tx,actor.tenantId,actor.id,'lead',lead.id,'routing.resolve',{saveMapping:false,userId:input.userId});
  return {lead:leadDto(await loadLead(tx,actor.tenantId,lead.id)),pendingAssigned:1};
}
