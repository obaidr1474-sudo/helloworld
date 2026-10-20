import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {actorOf,authenticate,ifMatch,parse,requireRole} from '../lib/http.js';
import {withTenant,type Tx} from '../lib/db.js';
import {audit,emit} from '../lib/events.js';
import {badRequest,forbidden,HttpError,notFound,preconditionFailed} from '../lib/errors.js';
import {isManager,loadLead,type Actor} from '../services/leads.js';
async function lockedDeal(tx:Tx,a:Actor,id:string){
 const snapshot=(await tx.query('SELECT lead_id FROM deals WHERE tenant_id=$1 AND id=$2',[a.tenantId,id])).rows[0];if(!snapshot)throw notFound('Booking');
 await loadLead(tx,a.tenantId,snapshot.lead_id,true);
 return (await tx.query('SELECT * FROM deals WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,id])).rows[0];
}
function checkVersion(version:number|undefined,current:number){if(version===undefined)throw new HttpError(428,'version_required','Reload the current booking before updating.');if(version!==current)throw preconditionFailed('This booking changed. Reload before saving.');}
export async function dealRoutes(app:FastifyInstance){
 app.addHook('preHandler',authenticate);
 app.get('/deals',async req=>{
  const a=actorOf(req),p=parse(z.object({status:z.enum(['pending_approval','approved','invoiced','paid','cancelled']).optional()}),req.query);
  return withTenant(a.tenantId,async tx=>(await tx.query(`SELECT d.*,l.full_name AS lead_name,l.serial_no,l.source,u.full_name AS agent_name,p.project_name,
  approver.full_name AS approver_name FROM deals d JOIN leads l ON l.tenant_id=d.tenant_id AND l.id=d.lead_id
  LEFT JOIN users u ON u.tenant_id=d.tenant_id AND u.id=d.agent_id LEFT JOIN properties p ON p.tenant_id=d.tenant_id AND p.id=d.property_id
  LEFT JOIN users approver ON approver.tenant_id=d.tenant_id AND approver.id=d.approved_by
  WHERE d.tenant_id=$1 AND ($2::boolean OR d.agent_id=$3) AND ($4::text IS NULL OR d.status=$4)
  ORDER BY d.booked_at DESC,d.id LIMIT 500`,[a.tenantId,isManager(a)||a.role==='viewer',a.id,p.status??null])).rows);
 });
 app.patch('/deals/:id',{preHandler:requireRole('owner','admin','manager')},async req=>{
  const a=actorOf(req),id=parse(z.string().uuid(),(req.params as any).id),b=parse(z.object({commissionPct:z.number().min(0).max(100).multipleOf(0.01)}),req.body);
  return withTenant(a.tenantId,async tx=>{
   const old=await lockedDeal(tx,a,id);checkVersion(ifMatch(req),old.version);
   if(old.status!=='pending_approval'||old.voided_at)throw badRequest('Only a pending booking can have its commission reviewed.');
   const row=(await tx.query('UPDATE deals SET commission_pct=$3,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *',[a.tenantId,id,b.commissionPct])).rows[0];
   await audit(tx,a.tenantId,a.id,'deal',id,'commission.reviewed',{from:old.commission_pct,to:b.commissionPct});await emit(tx,a.tenantId,'deal.updated',{lead_id:old.lead_id,deal_id:id});return row;
  });
 });
 app.post('/deals/:id/transition',{preHandler:requireRole('owner','admin','manager')},async req=>{
  const a=actorOf(req),id=parse(z.string().uuid(),(req.params as any).id),b=parse(z.object({status:z.enum(['approved','invoiced','paid','cancelled']),note:z.string().trim().max(2000).optional(),invoiceRef:z.string().trim().min(1).max(100).optional(),paymentRef:z.string().trim().min(1).max(100).optional()}),req.body);
  return withTenant(a.tenantId,async tx=>{
   const old=await lockedDeal(tx,a,id);checkVersion(ifMatch(req),old.version);
   if(old.voided_at||old.status==='cancelled')throw badRequest('This booking is already cancelled.');
   if(b.status==='invoiced'||b.status==='paid'){if(!['owner','admin'].includes(a.role))throw forbidden('Only owners and administrators can record invoice and payment references.');}
   const allowed:Record<string,string[]>= {pending_approval:['approved','cancelled'],approved:['invoiced','cancelled'],invoiced:['paid','cancelled'],paid:[]};
   if(!allowed[old.status]?.includes(b.status))throw badRequest(old.status==='paid'?'Paid bookings require a separate finance reversal; direct cancellation is disabled.':'This booking must follow approval, invoice and payment order.');
   if(b.status==='invoiced'&&!b.invoiceRef)throw badRequest('Record the reference of the invoice issued by your finance system.');
   if(b.status==='paid'&&!b.paymentRef)throw badRequest('Record the verified payment reference.');
   if(b.status==='cancelled'&&(!b.note||b.note.length<10))throw badRequest('Explain the cancellation in at least 10 characters.');
   const row=(await tx.query(`UPDATE deals SET status=$3,version=version+1,updated_at=now(),
    approved_by=CASE WHEN $3='approved' THEN $4 ELSE approved_by END,approved_at=CASE WHEN $3='approved' THEN now() ELSE approved_at END,
    external_invoice_ref=CASE WHEN $3='invoiced' THEN $5 ELSE external_invoice_ref END,invoiced_at=CASE WHEN $3='invoiced' THEN now() ELSE invoiced_at END,
    payment_ref=CASE WHEN $3='paid' THEN $6 ELSE payment_ref END,paid_at=CASE WHEN $3='paid' THEN now() ELSE paid_at END,
    voided_at=CASE WHEN $3='cancelled' THEN now() ELSE voided_at END,cancellation_reason=CASE WHEN $3='cancelled' THEN $7 ELSE cancellation_reason END
    WHERE tenant_id=$1 AND id=$2 RETURNING *`,[a.tenantId,id,b.status,a.id,b.invoiceRef??null,b.paymentRef??null,b.note??null])).rows[0];
   if(b.status==='cancelled'){
    await tx.query("UPDATE leads SET stage='lost',sub_status=NULL,lost_reason=$3,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2 AND stage='booked'",[a.tenantId,old.lead_id,b.note]);
    await emit(tx,a.tenantId,'lead.stage_changed',{lead_id:old.lead_id,to:'lost'});
   }
   await audit(tx,a.tenantId,a.id,'deal',id,'booking.'+b.status,{from:old.status,to:b.status,note:b.note??null,invoiceRef:b.invoiceRef??null,paymentRef:b.paymentRef??null,dealValue:row.deal_value,commissionPct:row.commission_pct,brokerage:row.brokerage_amount});
   await emit(tx,a.tenantId,'deal.updated',{lead_id:old.lead_id,deal_id:id,status:b.status});return row;
  });
 });
}
