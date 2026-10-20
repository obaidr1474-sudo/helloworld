import {withSystem,withTenant} from '../lib/db.js';
import {config} from '../lib/config.js';
import {emit,audit} from '../lib/events.js';
import {hasWhatsAppWindow,markOutboundContact} from './messages.js';
import {applyMessageReceipt} from './receipts.js';

export class DeliveryError extends Error {constructor(message:string,public uncertain:boolean){super(message);}}
export type MessageTransport=(payload:any)=>Promise<{providerId:string}>;
const send:MessageTransport=async payload=>{
  let response:Response;
  try{response=await fetch(`https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`,{method:'POST',headers:{Authorization:'Bearer '+config.whatsapp.accessToken,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});}
  catch{throw new DeliveryError('Provider acknowledgement was not received. Check provider delivery records before resending.',true);}
  const data:any=await response.json().catch(()=>null);
  if(!response.ok)throw new DeliveryError('Provider rejected this delivery (HTTP '+response.status+'). Review the provider configuration or template.',response.status>=500);
  if(!data?.messages?.[0]?.id)throw new DeliveryError('Provider acknowledgement did not include a message ID. Check delivery before resending.',true);
  return {providerId:String(data.messages[0].id)};
};

/** Claim durably, contact the provider outside a transaction, then record acknowledgement.
 * An interrupted/ambiguous send is never retried automatically: external delivery cannot be rolled back. */
export async function dispatchQueuedMessages(transport:MessageTransport=send){
  await withSystem(async tx=>{
    const stale=(await tx.query(`UPDATE messages SET status='delivery_unknown',delivery_error='Worker interrupted while awaiting provider acknowledgement. Verify delivery before resending.' WHERE status='processing' AND send_attempted_at<now()-interval '5 minutes' RETURNING tenant_id,lead_id,id`)).rows;
    for(const m of stale)await emit(tx,m.tenant_id,'message.failed',{lead_id:m.lead_id,message_id:m.id,status:'delivery_unknown'});
  });
  const jobs=await withSystem(async tx=>(await tx.query(`UPDATE messages SET status='processing',send_attempted_at=now() WHERE id IN
    (SELECT id FROM messages WHERE status='queued' ORDER BY created_at,id LIMIT 10 FOR UPDATE SKIP LOCKED) RETURNING *`)).rows);
  for(const job of jobs){
    try{
      await withTenant(job.tenant_id,async tx=>{
        const context=(await tx.query(`SELECT l.owner_id,u.role,u.is_active,t.slug FROM leads l JOIN users u ON u.tenant_id=l.tenant_id AND u.id=$3 JOIN tenants t ON t.id=l.tenant_id WHERE l.tenant_id=$1 AND l.id=$2 AND l.deleted_at IS NULL`,[job.tenant_id,job.lead_id,job.sent_by])).rows[0];
        if(!context||!context.is_active||!['owner','admin','manager','agent'].includes(context.role)||(context.role==='agent'&&context.owner_id!==job.sent_by))throw new DeliveryError('Sender no longer has access to this enquiry. Review ownership before resending.',false);
        if(config.whatsapp.workspace&&context.slug!==config.whatsapp.workspace)throw new DeliveryError('WhatsApp delivery is not enabled for this workspace.',false);
        if(job.send_payload?.type==='text'&&!(await hasWhatsAppWindow(tx,job.tenant_id,job.lead_id)))throw new DeliveryError('The verified WhatsApp reply window closed before delivery. Use an approved template.',false);
      });
      const result=await transport(job.send_payload);
      await withTenant(job.tenant_id,async tx=>{
        await tx.query(`UPDATE messages SET status='sent',provider_id=$3,delivery_error=NULL WHERE tenant_id=$1 AND id=$2`,[job.tenant_id,job.id,result.providerId]);
        await applyMessageReceipt(tx,job.tenant_id,result.providerId);
        await markOutboundContact(tx,{id:job.sent_by,tenantId:job.tenant_id,role:'system'},job.lead_id);
        await tx.query(`INSERT INTO interactions(tenant_id,lead_id,user_id,type,direction,summary,external_id) VALUES($1,$2,$3,'whatsapp','outbound',$4,$5)`,[job.tenant_id,job.lead_id,job.sent_by,'WhatsApp delivery acknowledged: '+job.body,result.providerId]);
        await emit(tx,job.tenant_id,'message.sent',{lead_id:job.lead_id,message_id:job.id,status:'sent'});
        await audit(tx,job.tenant_id,job.sent_by,'message',job.id,'provider_acknowledged',{providerId:result.providerId});
      });
    }catch(error){
      const uncertain=!(error instanceof DeliveryError)||error.uncertain;
      await withTenant(job.tenant_id,async tx=>{
        await tx.query('UPDATE messages SET status=$3,delivery_error=$4 WHERE tenant_id=$1 AND id=$2',[job.tenant_id,job.id,uncertain?'delivery_unknown':'failed',error instanceof DeliveryError?error.message:'Delivery outcome needs review. Check provider records before resending.']);
        await emit(tx,job.tenant_id,'message.failed',{lead_id:job.lead_id,message_id:job.id,status:uncertain?'delivery_unknown':'failed'});
      });
    }
  }
  return {processed:jobs.length};
}
