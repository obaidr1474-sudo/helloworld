import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../lib/db.js';
import { actorOf,authenticate,ifMatch,parse,requireRole } from '../lib/http.js';
import { badRequest,forbidden } from '../lib/errors.js';
import { audit,emit } from '../lib/events.js';
import { leadDto,loadLead } from '../services/leads.js';
import { listListingRoutes,resolveLeadRouting,saveListingRoute } from '../services/routing.js';
const routeBody=z.object({
  source:z.string().trim().regex(/^[a-z0-9_]{1,50}$/),listingRef:z.string().trim().min(1).max(200),responsibleAgentId:z.string().uuid().nullable(),
  publisherAgentId:z.string().uuid().nullable().optional(),publisherAccount:z.string().trim().max(160).nullable().optional(),propertyId:z.string().uuid().nullable().optional(),
  enabled:z.boolean().optional(),notes:z.string().max(2000).nullable().optional(),
});
const manager=requireRole('owner','admin','manager');
export async function operationRoutes(app:FastifyInstance){
  app.addHook('preHandler',authenticate);
  app.get('/routing/listings',{preHandler:manager},async req=>{
    const actor=actorOf(req),p=parse(z.object({q:z.string().max(200).optional(),unresolved:z.enum(['true','false']).optional(),limit:z.coerce.number().int().min(1).max(100).optional(),offset:z.coerce.number().int().min(0).optional()}),req.query);
    return withTenant(actor.tenantId,tx=>listListingRoutes(tx,actor,{...p,unresolved:p.unresolved==='true'}));
  });
  app.post('/routing/listings',{preHandler:manager},async(req,reply)=>{
    const actor=actorOf(req),body=parse(routeBody,req.body);reply.code(201);
    return withTenant(actor.tenantId,tx=>saveListingRoute(tx,actor,body));
  });
  app.put('/routing/listings/:id',{preHandler:manager},async(req)=>{
    const actor=actorOf(req),body=parse(routeBody,req.body),{id}=req.params as {id:string},version=ifMatch(req);
    return withTenant(actor.tenantId,tx=>saveListingRoute(tx,actor,body,id,version));
  });
  app.get('/routing/exceptions',{preHandler:manager},async req=>{
    const actor=actorOf(req),p=parse(z.object({source:z.string().max(50).optional(),limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).default(0)}),req.query);
    return withTenant(actor.tenantId,async tx=>{
      const values=[actor.tenantId,p.source??null];
      const where=`l.tenant_id=$1 AND l.deleted_at IS NULL AND l.owner_id IS NULL AND l.routing_mode='listing' AND l.stage NOT IN ('lost','booked') AND ($2::text IS NULL OR l.source=$2)`;
      const {rows}=await tx.query(`SELECT l.*,r.version AS route_version,r.responsible_agent_id AS mapped_agent_id,u.full_name AS mapped_agent_name,
        (SELECT max(received_at) FROM lead_enquiries e WHERE e.tenant_id=l.tenant_id AND e.lead_id=l.id) AS last_enquiry_received_at
        FROM leads l LEFT JOIN listing_routes r ON r.tenant_id=l.tenant_id AND r.id=l.listing_route_id
        LEFT JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.responsible_agent_id WHERE ${where} ORDER BY l.created_at,l.id LIMIT $3 OFFSET $4`,[...values,p.limit,p.offset]);
      const total=(await tx.query(`SELECT count(*)::int AS total FROM leads l WHERE ${where}`,values)).rows[0].total;
      return {items:rows.map(r=>({...leadDto(r),routeVersion:r.route_version,mappedAgentId:r.mapped_agent_id,mappedAgentName:r.mapped_agent_name,lastEnquiryReceivedAt:r.last_enquiry_received_at})),total};
    });
  });
  app.post('/leads/:id/resolve-routing',{preHandler:manager},async req=>{
    const actor=actorOf(req),{id}=req.params as {id:string},body=parse(z.object({userId:z.string().uuid(),saveMapping:z.boolean().default(true),listingRef:z.string().trim().min(1).max(200).optional(),routeVersion:z.number().int().positive().optional()}),req.body),version=ifMatch(req);
    return withTenant(actor.tenantId,tx=>resolveLeadRouting(tx,actor,id,body,version));
  });
  app.post('/leads/:id/acknowledge',async req=>{
    const actor=actorOf(req),{id}=req.params as {id:string};
    return withTenant(actor.tenantId,async tx=>{
      const lead=await loadLead(tx,actor.tenantId,id,true);
      if(lead.owner_id!==actor.id) throw forbidden('Only the assigned agent can acknowledge receipt.');
      if(!lead.acknowledged_at){
        await tx.query('UPDATE leads SET acknowledged_at=now(),version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2',[actor.tenantId,id]);
        await audit(tx,actor.tenantId,actor.id,'lead',id,'acknowledge');
        await emit(tx,actor.tenantId,'lead.updated',{lead_id:id,owner_id:actor.id,acknowledged:true});
      }
      return leadDto(await loadLead(tx,actor.tenantId,id));
    });
  });
  app.get('/operations/overview',async req=>{
    const actor=actorOf(req),p=parse(z.object({agentId:z.string().uuid().optional()}),req.query);
    const isManager=['owner','admin','manager','viewer'].includes(actor.role);
    const agentId=isManager?p.agentId??null:actor.id;
    return withTenant(actor.tenantId,async tx=>{
      const {rows:[result]}=await tx.query(`WITH boundary AS(SELECT (date_trunc('day',now() AT TIME ZONE timezone) AT TIME ZONE timezone) AS start FROM tenants WHERE id=$1)
        SELECT count(*)::int AS total,
        count(*) FILTER(WHERE l.created_at>=b.start)::int AS received_today,
        count(*) FILTER(WHERE l.owner_id IS NULL AND l.routing_mode='listing')::int AS routing_exceptions,
        count(*) FILTER(WHERE l.owner_id IS NOT NULL AND l.acknowledged_at IS NULL)::int AS unacknowledged,
        count(*) FILTER(WHERE l.owner_id IS NOT NULL AND (l.last_agent_update_at IS NULL OR l.last_agent_update_at<b.start))::int AS needs_update,
        count(*) FILTER(WHERE l.next_action_at<now())::int AS overdue,
        count(*) FILTER(WHERE l.owner_id IS NOT NULL AND l.next_action_at IS NULL)::int AS missing_next_action
        FROM leads l CROSS JOIN boundary b WHERE l.tenant_id=$1 AND l.deleted_at IS NULL AND l.stage NOT IN ('lost','booked') AND ($2::uuid IS NULL OR l.owner_id=$2)`,[actor.tenantId,agentId]);
      const enquiries=(await tx.query(`SELECT count(*)::int AS n FROM lead_enquiries e JOIN leads l ON l.tenant_id=e.tenant_id AND l.id=e.lead_id
        JOIN tenants t ON t.id=e.tenant_id WHERE e.tenant_id=$1 AND e.received_at>=(date_trunc('day',now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone)
        AND ($2::uuid IS NULL OR l.owner_id=$2)`,[actor.tenantId,agentId])).rows[0].n;
      return {...result,enquiries_today:enquiries};
    });
  });
  app.get('/operations/team',{preHandler:manager},async req=>{
    const a=actorOf(req);
    return withTenant(a.tenantId,async tx=>(await tx.query(`SELECT u.id,u.full_name,u.is_active,u.broker_registration_number,
      count(l.id)::int AS active_leads,count(l.id) FILTER(WHERE l.acknowledged_at IS NULL)::int AS unacknowledged,
      count(l.id) FILTER(WHERE l.last_agent_update_at IS NULL OR l.last_agent_update_at<(date_trunc('day',now() AT TIME ZONE t.timezone) AT TIME ZONE t.timezone))::int AS needs_update,
      count(l.id) FILTER(WHERE l.next_action_at<now())::int AS overdue,max(l.last_agent_update_at) AS latest_update
      FROM users u JOIN tenants t ON t.id=u.tenant_id LEFT JOIN leads l ON l.tenant_id=u.tenant_id AND l.owner_id=u.id AND l.deleted_at IS NULL AND l.stage NOT IN ('lost','booked')
      WHERE u.tenant_id=$1 AND u.role IN ('agent','manager','admin','owner') GROUP BY u.id,t.timezone ORDER BY needs_update DESC,u.full_name`,[a.tenantId])).rows);
  });
  app.get('/operations/integrations',{preHandler:manager},async req=>{
    const a=actorOf(req);
    return withTenant(a.tenantId,async tx=>{
      const totals=(await tx.query(`SELECT source,count(*) FILTER(WHERE status='received')::int AS received,count(*) FILTER(WHERE status='duplicate')::int AS duplicates,
        count(*) FILTER(WHERE status='rejected')::int AS rejected,max(received_at) AS last_received_at FROM integration_events WHERE tenant_id=$1 AND received_at>now()-interval '24 hours' GROUP BY source ORDER BY source`,[a.tenantId])).rows;
      const events=(await tx.query('SELECT * FROM integration_events WHERE tenant_id=$1 ORDER BY received_at DESC,id DESC LIMIT 100',[a.tenantId])).rows;
      return {sources:totals,events};
    });
  });
  app.get('/operations/audit',{preHandler:manager},async req=>{
    const a=actorOf(req),p=parse(z.object({entityId:z.string().uuid().optional(),limit:z.coerce.number().int().min(1).max(200).default(100)}),req.query);
    return withTenant(a.tenantId,async tx=>(await tx.query(`SELECT a.*,u.full_name AS actor_name FROM audit_log a LEFT JOIN users u ON u.tenant_id=a.tenant_id AND u.id=a.actor_id
      WHERE a.tenant_id=$1 AND ($2::uuid IS NULL OR a.entity_id=$2) ORDER BY a.at DESC,a.id DESC LIMIT $3`,[a.tenantId,p.entityId??null,p.limit])).rows);
  });
}
