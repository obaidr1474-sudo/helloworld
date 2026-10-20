import type {Tx} from '../lib/db.js';
import {emit} from '../lib/events.js';

const rank:Record<string,number>={sent:1,failed:2,delivered:3,read:4};
const lock=(tx:Tx,tenantId:string,providerId:string)=>tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['receipt:'+tenantId+':'+providerId]);

/** Signed callbacks can arrive before the HTTP send result, more than once, or out of order. */
export async function recordMessageReceipt(tx:Tx,tenantId:string,input:{id?:unknown;status?:unknown;timestamp?:unknown}) {
  if(typeof input.id!=='string'||!input.id||input.id.length>512||typeof input.status!=='string'||!rank[input.status])return;
  const seconds=Number(input.timestamp);
  if(!Number.isFinite(seconds)||seconds<1||seconds>Date.now()/1000+300)return;
  const at=new Date(seconds*1000);
  await lock(tx,tenantId,input.id);
  const previous=(await tx.query('SELECT status FROM message_receipts WHERE tenant_id=$1 AND provider_id=$2',[tenantId,input.id])).rows[0];
  if(!previous||rank[input.status]>rank[previous.status]){
    await tx.query(`INSERT INTO message_receipts(tenant_id,provider_id,status,provider_at) VALUES($1,$2,$3,$4)
      ON CONFLICT(tenant_id,provider_id) DO UPDATE SET status=excluded.status,provider_at=excluded.provider_at,received_at=now()`,[tenantId,input.id,input.status,at]);
  }
  await apply(tx,tenantId,input.id);
}

export async function applyMessageReceipt(tx:Tx,tenantId:string,providerId:string){
  await lock(tx,tenantId,providerId);
  await apply(tx,tenantId,providerId);
}
async function apply(tx:Tx,tenantId:string,providerId:string){
  const receipt=(await tx.query('SELECT status,provider_at FROM message_receipts WHERE tenant_id=$1 AND provider_id=$2',[tenantId,providerId])).rows[0];
  if(!receipt)return;
  const message=(await tx.query(`SELECT id,lead_id,status FROM messages WHERE tenant_id=$1 AND provider_id=$2 AND direction='outbound' FOR UPDATE`,[tenantId,providerId])).rows[0];
  if(!message||rank[receipt.status]<=(rank[message.status]??0))return;
  await tx.query(`UPDATE messages SET status=$3,provider_status_at=$4,delivery_error=CASE WHEN $3='failed' THEN 'Provider reported delivery failure. Review provider records before resending.' ELSE NULL END WHERE tenant_id=$1 AND id=$2`,[tenantId,message.id,receipt.status,receipt.provider_at]);
  await emit(tx,tenantId,'message.updated',{lead_id:message.lead_id,message_id:message.id,status:receipt.status});
}
