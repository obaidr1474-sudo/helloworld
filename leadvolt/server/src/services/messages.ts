import crypto from 'node:crypto';
import type { Tx } from '../lib/db.js';
import { config } from '../lib/config.js';
import { emit } from '../lib/events.js';
import { badRequest,conflict } from '../lib/errors.js';
import { waDigits } from '../lib/phone.js';
import { addInteraction, assertCanRead, assertCanWrite, createOrReenquire, loadLead,rescore,type Actor } from './leads.js';

const WINDOW_MS = 24 * 3600 * 1000;

export async function listMessages(tx: Tx, actor: Actor, leadId: string) {
  assertCanRead(actor, await loadLead(tx, actor.tenantId, leadId));
  const { rows } = await tx.query(
    `SELECT m.*, u.full_name AS sent_by_name FROM messages m LEFT JOIN users u ON u.id = m.sent_by
      WHERE m.tenant_id = $1 AND m.lead_id = $2 ORDER BY m.created_at ASC LIMIT 500`, [actor.tenantId, leadId]);
  return rows;
}

export async function inbox(tx: Tx, actor: Actor, filter: 'all' | 'mine' | 'waiting') {
  const vals: unknown[] = [actor.tenantId]; const where: string[] = [];
  if (!['owner', 'admin', 'manager', 'viewer'].includes(actor.role) || filter === 'mine') { vals.push(actor.id); where.push(`l.owner_id = $${vals.length}`); }
  if (filter === 'waiting') where.push(`last.direction = 'inbound'`);
  const { rows } = await tx.query(
    `SELECT l.id AS lead_id, l.full_name, l.owner_id,l.phone_e164,l.stage,last.body, last.direction, last.created_at
       FROM leads l
       JOIN LATERAL (SELECT body, direction, created_at FROM messages m WHERE m.tenant_id = l.tenant_id AND m.lead_id = l.id
                      ORDER BY created_at DESC LIMIT 1) last ON true
      WHERE l.tenant_id = $1 AND l.deleted_at IS NULL ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY last.created_at DESC LIMIT 200`, vals);
  return rows;
}

/**
 * Send (when WhatsApp Cloud API is configured and the 24h service window is open, or a template is used)
 * or just log an outbound message that the agent sent from their own WhatsApp.
 */
async function markOutboundContact(tx:Tx,actor:Actor,leadId:string) {
  const lead=await loadLead(tx,actor.tenantId,leadId,true);
  let next=lead.next_action_at;
  if(!next&&!['booked','lost'].includes(lead.stage)){
    next=new Date(Date.now()+86400000);
    await tx.query(`INSERT INTO tasks(tenant_id,lead_id,assignee_id,created_by,type,title,due_at) VALUES($1,$2,$3,$4,'follow_up','Follow up after WhatsApp message',$5)`,[actor.tenantId,leadId,lead.owner_id??actor.id,actor.id,next]);
  }
  await tx.query(`UPDATE leads SET last_contacted_at=now(),first_response_at=COALESCE(first_response_at,now()),next_action_at=$3,
    last_agent_update_at=CASE WHEN owner_id=$4 THEN now() ELSE last_agent_update_at END,
    acknowledged_at=CASE WHEN owner_id=$4 THEN COALESCE(acknowledged_at,now()) ELSE acknowledged_at END,
    stage=CASE WHEN stage='new' THEN 'contacted' ELSE stage END,sub_status=CASE WHEN stage='new' THEN 'WhatsApp sent' ELSE sub_status END,
    updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2`,[actor.tenantId,leadId,next,actor.id]);
  await rescore(tx,actor.tenantId,await loadLead(tx,actor.tenantId,leadId));
}
export async function hasWhatsAppWindow(tx:Tx,tenantId:string,leadId:string){
  // Portal enquiries, brochure opens and manually logged replies do not open Meta's service window.
  return !!(await tx.query(`SELECT 1 FROM messages WHERE tenant_id=$1 AND lead_id=$2 AND channel='whatsapp' AND direction='inbound'
    AND provider_id IS NOT NULL AND created_at>now()-interval '24 hours' LIMIT 1`,[tenantId,leadId])).rowCount;
}
export async function sendOrLog(tx:Tx,actor:Actor,leadId:string,body:string,opts:{mode:'send'|'log';template?:{name:string;lang:string;vars:string[]};clientRequestId?:string}){
  const lead=await loadLead(tx,actor.tenantId,leadId,true);assertCanWrite(actor,lead);
  if(!body.trim()&&!opts.template)throw badRequest('Type a message first.');
  if(opts.clientRequestId){
    const old=(await tx.query('SELECT * FROM messages WHERE tenant_id=$1 AND client_request_id=$2',[actor.tenantId,opts.clientRequestId])).rows[0];
    if(old){if(old.lead_id!==leadId||old.sent_by!==actor.id||old.body!==body)throw conflict('This message request ID was already used for different content.');return old;}
  }
  let payload:unknown=null;
  if(opts.mode==='send'){
    if(!opts.clientRequestId)throw badRequest('A unique clientRequestId is required for reliable sending.');
    if(!config.whatsapp.accessToken||!config.whatsapp.phoneNumberId)throw badRequest('WhatsApp delivery is not configured. You can log an externally sent message.');
    const tenant=(await tx.query('SELECT slug FROM tenants WHERE id=$1',[actor.tenantId])).rows[0];
    if(config.whatsapp.workspace&&tenant.slug!==config.whatsapp.workspace)throw badRequest('WhatsApp delivery is not enabled for this workspace.');
    if(!lead.phone_e164)throw badRequest('A valid phone number is required for WhatsApp delivery.');
    if(!opts.template&&!(await hasWhatsAppWindow(tx,actor.tenantId,leadId)))throw badRequest('The verified 24-hour WhatsApp reply window is closed. Use an approved template.');
    payload=opts.template?{messaging_product:'whatsapp',to:waDigits(lead.phone_e164),type:'template',template:{name:opts.template.name,language:{code:opts.template.lang},...(opts.template.vars.length?{components:[{type:'body',parameters:opts.template.vars.map(text=>({type:'text',text}))}]}:{})}}:{messaging_product:'whatsapp',to:waDigits(lead.phone_e164),type:'text',text:{body}};
  }
  const status=opts.mode==='send'?'queued':'logged';
  const msg=(await tx.query(`INSERT INTO messages(tenant_id,lead_id,direction,body,template_name,status,sent_by,client_request_id,send_payload)
    VALUES($1,$2,'outbound',$3,$4,$5,$6,$7,$8) RETURNING *`,[actor.tenantId,leadId,body,opts.template?.name??null,status,actor.id,opts.clientRequestId??null,payload])).rows[0];
  if(status==='logged'){
    await addInteraction(tx,actor.tenantId,leadId,actor.id,'whatsapp','WhatsApp logged by agent: '+body,{direction:'outbound'});
    await markOutboundContact(tx,actor,leadId);
  }
  await emit(tx,actor.tenantId,status==='queued'?'message.queued':'message.sent',{lead_id:leadId,owner_id:lead.owner_id,message_id:msg.id});
  return msg;
}
export {markOutboundContact};

export async function recordInbound(tx:Tx,actor:Actor,input:{phone:string;name?:string;body:string;providerId?:string;leadId?:string}){
  if(input.providerId){
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[actor.tenantId+':wa:'+input.providerId]);
    if((await tx.query('SELECT 1 FROM messages WHERE tenant_id=$1 AND provider_id=$2',[actor.tenantId,input.providerId])).rowCount)return null;
  }
  let leadId=input.leadId;
  if(!leadId){
    const candidates=(await tx.query(`SELECT id FROM leads WHERE tenant_id=$1 AND phone_e164=$2 AND deleted_at IS NULL AND stage NOT IN ('lost','booked') ORDER BY created_at,id LIMIT 2`,[actor.tenantId,input.phone])).rows;
    if(candidates.length===1)leadId=candidates[0].id;
    else{
      const r=await createOrReenquire(tx,actor,{name:input.name||input.phone,phone:input.phone,source:'whatsapp',subSource:'Inbound WhatsApp',ownerId:null,
        opportunityKey:'whatsapp:conversation',routingMode:'listing',note:candidates.length?'Multiple property enquiries match this number; administrator ownership review required.':'WhatsApp enquiry received without a listing reference.'});leadId=r.lead.id;
    }
  }
  const lead=await loadLead(tx,actor.tenantId,leadId!);
  if(actor.role!=='system')assertCanWrite(actor,lead);
  const msg=(await tx.query(`INSERT INTO messages(tenant_id,lead_id,direction,body,provider_id,status,sent_by) VALUES($1,$2,'inbound',$3,$4,'received',$5) RETURNING *`,[actor.tenantId,leadId,input.body,input.providerId??null,actor.id])).rows[0];
  await addInteraction(tx,actor.tenantId,leadId!,actor.id,'whatsapp',(input.providerId?'WhatsApp received: ':'Inbound WhatsApp logged by agent: ')+input.body,{direction:'inbound'});
  await tx.query('UPDATE leads SET last_inbound_at=now(),inbound_count=inbound_count+1,updated_at=now(),version=version+1 WHERE tenant_id=$1 AND id=$2',[actor.tenantId,leadId]);
  await emit(tx,actor.tenantId,'message.received',{lead_id:leadId,owner_id:lead.owner_id,message_id:msg.id,preview:input.body.slice(0,120)});return msg;
}

export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string) {
  if (!appSecret) return false;
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
