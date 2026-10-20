import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {actorOf,authenticate,parse,requireRole,ifMatch} from '../lib/http.js';
import {withTenant} from '../lib/db.js';
import {badRequest,forbidden,notFound,preconditionFailed} from '../lib/errors.js';
import {audit} from '../lib/events.js';
import {isManager} from '../services/leads.js';
import {managementReport} from '../services/reports.js';
const viewQuery=z.object({scope:z.enum(['all','mine','unassigned','reenquired','sla']).optional(),queue:z.enum(['active','new','scheduled','overdue','eoi','booked','lost','all','needs_update','unacknowledged']).optional(),q:z.string().max(200).optional(),source:z.string().max(50).optional(),ownerId:z.union([z.string().uuid(),z.literal('none'),z.literal('')]).optional(),temperature:z.enum(['hot','warm','cold','']).optional(),stage:z.enum(['new','contacted','meeting','site_visit','eoi','booked','lost','']).optional(),createdFrom:z.string().datetime({offset:true}).optional().or(z.literal('')),createdTo:z.string().datetime({offset:true}).optional().or(z.literal('')),sort:z.enum(['updated','created','next_action','score']).optional()}).strict();
const saved=z.object({name:z.string().trim().min(1).max(80),query:viewQuery,isShared:z.boolean().default(false)});
const manager=requireRole('owner','admin','manager');
export async function workspaceRoutes(app:FastifyInstance){
 app.addHook('preHandler',authenticate);
 app.get('/saved-views',async req=>{
  const a=actorOf(req);return withTenant(a.tenantId,async tx=>(await tx.query('SELECT v.*,u.full_name AS owner_name FROM saved_views v JOIN users u ON u.tenant_id=v.tenant_id AND u.id=v.owner_id WHERE v.tenant_id=$1 AND (v.owner_id=$2 OR v.is_shared) ORDER BY v.is_shared DESC,v.position,lower(v.name),v.id LIMIT 500',[a.tenantId,a.id])).rows);
 });
 app.post('/saved-views',async(req,reply)=>{
  const a=actorOf(req),b=parse(saved,req.body);if(b.isShared&&!isManager(a))throw forbidden('Only managers can publish shared views.');
  reply.code(201);return withTenant(a.tenantId,async tx=>{
   await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['views:'+a.tenantId+':'+a.id]);
   const count=(await tx.query('SELECT count(*)::int AS n FROM saved_views WHERE tenant_id=$1 AND owner_id=$2',[a.tenantId,a.id])).rows[0].n;if(count>=50)throw badRequest('You can save up to 50 views.');
   const v=(await tx.query('INSERT INTO saved_views(tenant_id,owner_id,name,query,is_shared) VALUES($1,$2,$3,$4,$5) RETURNING *',[a.tenantId,a.id,b.name,b.query,b.isShared])).rows[0];
   await audit(tx,a.tenantId,a.id,'saved_view',v.id,'create',{name:v.name,shared:v.is_shared});return v;
  });
 });
 app.put('/saved-views/:id',async req=>{
  const a=actorOf(req),b=parse(saved,req.body),id=parse(z.string().uuid(),(req.params as any).id),version=ifMatch(req);
  return withTenant(a.tenantId,async tx=>{
   const v=(await tx.query('SELECT * FROM saved_views WHERE tenant_id=$1 AND id=$2 AND (owner_id=$3 OR is_shared) FOR UPDATE',[a.tenantId,id,a.id])).rows[0];if(!v)throw notFound('View');
   if(v.owner_id!==a.id&&!(v.is_shared&&isManager(a)))throw forbidden();if(b.isShared&&!isManager(a))throw forbidden();
   if(version!==v.version)throw preconditionFailed('The saved view changed. Reload before editing.');
   const row=(await tx.query('UPDATE saved_views SET name=$3,query=$4,is_shared=$5,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',[a.tenantId,id,b.name,b.query,b.isShared])).rows[0];await audit(tx,a.tenantId,a.id,'saved_view',id,'update');return row;
  });
 });
 app.delete('/saved-views/:id',async(req,reply)=>{
  const a=actorOf(req),id=parse(z.string().uuid(),(req.params as any).id);
  await withTenant(a.tenantId,async tx=>{
   const v=(await tx.query('SELECT * FROM saved_views WHERE tenant_id=$1 AND id=$2 AND (owner_id=$3 OR is_shared) FOR UPDATE',[a.tenantId,id,a.id])).rows[0];if(!v)throw notFound('View');
   if(v.owner_id!==a.id&&!(v.is_shared&&isManager(a)))throw forbidden();
   if(ifMatch(req)!==v.version)throw preconditionFailed('The saved view changed. Reload it first.');
   await tx.query('DELETE FROM saved_views WHERE tenant_id=$1 AND id=$2',[a.tenantId,id]);await audit(tx,a.tenantId,a.id,'saved_view',id,'delete');
  });reply.code(204).send();
 });
 app.get('/reports/management',{preHandler:manager},async req=>{
  const a=actorOf(req),p=parse(z.object({from:z.string().datetime({offset:true}),to:z.string().datetime({offset:true}),agentId:z.string().uuid().optional(),source:z.string().max(50).optional()}),req.query);
  if(Date.parse(p.to)<=Date.parse(p.from)||Date.parse(p.to)-Date.parse(p.from)>366*86400000)throw badRequest('Choose a reporting period of up to 366 days.');
  return withTenant(a.tenantId,tx=>managementReport(tx,a,p));
 });
 app.post('/reconciliation',{preHandler:manager},async(req,reply)=>{
  const a=actorOf(req),b=parse(z.object({source:z.string().regex(/^[a-z0-9_]{1,50}$/),eventIds:z.array(z.string().trim().min(1).max(200)).min(1).max(5000)}),req.body);
  const ids=[...new Set(b.eventIds)];reply.code(201);
  return withTenant(a.tenantId,async tx=>{
   const receipts=(await tx.query('SELECT provider_event_id,lead_id FROM intake_receipts WHERE tenant_id=$1 AND source=$2 AND provider_event_id=ANY($3)',[a.tenantId,b.source,ids])).rows;
   const found=new Map(receipts.map(r=>[r.provider_event_id,r.lead_id]));
   // Rejected events are diagnostic only; a later accepted receipt always takes precedence.
   const rejected=new Set((await tx.query("SELECT DISTINCT provider_event_id FROM integration_events WHERE tenant_id=$1 AND source=$2 AND status='rejected' AND provider_event_id=ANY($3)",[a.tenantId,b.source,ids])).rows.map(r=>r.provider_event_id));
   const items=ids.map(id=>({provider_event_id:id,status:found.has(id)?'received':rejected.has(id)?'rejected':'missing',lead_id:found.get(id)??null}));
   const run=(await tx.query(`INSERT INTO reconciliation_runs(tenant_id,source,created_by,provider_count,received_count,missing_count,rejected_count,duplicate_rows) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[a.tenantId,b.source,a.id,ids.length,found.size,items.filter(i=>i.status==='missing').length,items.filter(i=>i.status==='rejected').length,b.eventIds.length-ids.length])).rows[0];
   await tx.query(`INSERT INTO reconciliation_items(tenant_id,run_id,provider_event_id,status,lead_id) SELECT $1,$2,x.provider_event_id,x.status,x.lead_id::uuid FROM jsonb_to_recordset($3::jsonb) AS x(provider_event_id text,status text,lead_id text)`,[a.tenantId,run.id,JSON.stringify(items)]);
   await audit(tx,a.tenantId,a.id,'reconciliation',run.id,'compare',{source:b.source,expected:ids.length,missing:run.missing_count});return {...run,items};
  });
 });
 app.get('/reconciliation',{preHandler:manager},async req=>{
  const a=actorOf(req);return withTenant(a.tenantId,async tx=>(await tx.query('SELECT r.*,u.full_name AS creator_name FROM reconciliation_runs r JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.created_by WHERE r.tenant_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 100',[a.tenantId])).rows);
 });
 app.get('/reconciliation/:id',{preHandler:manager},async req=>{
  const a=actorOf(req),id=parse(z.string().uuid(),(req.params as any).id);return withTenant(a.tenantId,async tx=>{
   const run=(await tx.query('SELECT * FROM reconciliation_runs WHERE tenant_id=$1 AND id=$2',[a.tenantId,id])).rows[0];if(!run)throw notFound('Reconciliation');
   return {...run,items:(await tx.query('SELECT provider_event_id,status,lead_id FROM reconciliation_items WHERE tenant_id=$1 AND run_id=$2 ORDER BY status,provider_event_id',[a.tenantId,id])).rows};
  });
 });
}
