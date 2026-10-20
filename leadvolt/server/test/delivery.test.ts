import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
const run=!!process.env.TEST_DATABASE_URL&&!!process.env.TEST_MIGRATION_URL;
(run?describe:describe.skip)('durable WhatsApp delivery safeguards',()=>{
  let app:any,pool:any,txTenant:any,recordInbound:any,dispatch:any,DeliveryError:any,token:string,tenant:string,ownerId:string;
  let verifiedPhoneId='fixture-phone-id';
  const call=async(method:string,path:string,body?:unknown,bearer=token)=>{
    const r=await app.inject({method,url:'/api/v1'+path,headers:{...(bearer?{authorization:'Bearer '+bearer}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},payload:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.statusCode,body:r.body?JSON.parse(r.body):null};
  };
  let sequence=100;
  async function lead(){const r=await call('POST','/leads',{name:'Fictional WhatsApp recipient',phone:'+97150200'+String(sequence++).padStart(4,'0'),source:'other',ownerId:ownerId});expect(r.status).toBe(201);return r.body.lead;}
  async function message(id:string,options:any={}){return call('POST','/leads/'+id+'/messages',{body:'A fictional delivery test',mode:'send',clientRequestId:crypto.randomUUID(),template:{name:'fixture_approved_template',lang:'en',vars:[]},...options});}
  const all=async(id:string)=>(await call('GET','/leads/'+id+'/messages')).body;
  beforeAll(async()=>{
    const workerUrl=new URL(process.env.TEST_MIGRATION_URL!);workerUrl.username='leadvolt_worker';workerUrl.password='leadvolt_worker';process.env.WORKER_DATABASE_URL=process.env.TEST_WORKER_DATABASE_URL??workerUrl.toString();
    process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;process.env.MIGRATION_DATABASE_URL=process.env.TEST_MIGRATION_URL;
    process.env.WA_ACCESS_TOKEN='fixture-token-not-a-real-credential';process.env.WA_PHONE_NUMBER_ID=verifiedPhoneId;process.env.WA_WORKSPACE='delivery-test';process.env.WA_APP_SECRET='fixture-signing-secret';
    const admin=new pg.Client({connectionString:process.env.TEST_MIGRATION_URL});await admin.connect();await admin.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO leadvolt_app');await admin.end();
    await (await import('../src/migrate.js')).migrate(process.env.TEST_MIGRATION_URL);
    ({pool,withTenant:txTenant}=await import('../src/lib/db.js'));({recordInbound}=await import('../src/services/messages.js'));({dispatchQueuedMessages:dispatch,DeliveryError}=await import('../src/services/delivery.js'));
    app=await (await import('../src/app.js')).buildApp({logger:false});
    const r=await call('POST','/auth/register',{company:'Delivery Test',slug:'delivery-test',name:'Delivery Owner',email:'owner@delivery.test',password:'delivery-password-123'},'');expect(r.status).toBe(200);token=r.body.token;tenant=r.body.tenant.id;ownerId=(await call('GET','/me')).body.id;
    await call('PATCH','/settings',{wa_phone_number_id:verifiedPhoneId});
  });
  afterAll(async()=>{await app?.close();await pool?.end();delete process.env.WA_ACCESS_TOKEN;delete process.env.WA_PHONE_NUMBER_ID;delete process.env.WA_WORKSPACE;delete process.env.WA_APP_SECRET;});
  it('does not treat portal activity or manually logged replies as an open WhatsApp service window',async()=>{
    const l=await lead();
    await txTenant(tenant,(tx:any)=>tx.query('UPDATE leads SET last_inbound_at=now() WHERE tenant_id=$1 AND id=$2',[tenant,l.id]));
    expect((await message(l.id,{template:undefined})).status).toBe(400);
    expect((await call('POST','/leads/'+l.id+'/messages',{direction:'inbound',mode:'log',body:'Manually logged reply'})).status).toBe(201);
    expect((await message(l.id,{template:undefined})).status).toBe(400);
  });
  it('accepts a signed provider message, opens the verified reply window and ignores its retries',async()=>{
    const l=await lead();
    const payload={entry:[{changes:[{value:{metadata:{phone_number_id:verifiedPhoneId},contacts:[{wa_id:l.phone.slice(1),profile:{name:'Fictional Contact'}}],messages:[{id:'verified-inbound-1',from:l.phone.slice(1),type:'text',text:{body:'Verified fixture message'}}]}}]}]};
    const raw=JSON.stringify(payload),signature='sha256='+crypto.createHmac('sha256','fixture-signing-secret').update(raw).digest('hex');
    const receive=()=>app.inject({method:'POST',url:'/api/v1/webhooks/whatsapp',headers:{'content-type':'application/json','x-hub-signature-256':signature},payload:raw});
    expect((await receive()).statusCode).toBe(200);expect((await receive()).statusCode).toBe(200);
    expect((await all(l.id)).filter((m:any)=>m.direction==='inbound')).toHaveLength(1);
    expect((await call('GET','/leads/'+l.id)).body.reenquiryCount).toBe(0);
    expect((await message(l.id,{template:undefined})).status).toBe(201);
  });
  it('queues a message transactionally and uses client request IDs to prevent duplicate sends',async()=>{
    const l=await lead(),id=crypto.randomUUID(),first=await message(l.id,{clientRequestId:id});expect(first.status).toBe(201);expect(first.body.status).toBe('queued');
    expect((await call('GET','/leads/'+l.id)).body.firstResponseAt).toBeNull();
    const second=await message(l.id,{clientRequestId:id});expect(second.body.id).toBe(first.body.id);expect((await all(l.id))).toHaveLength(1);
    let sent=0;await dispatch(async()=>({providerId:'acknowledged-'+(++sent)}));
    const sentMessage=(await all(l.id))[0];expect(sentMessage.status).toBe('sent');expect(sentMessage.provider_id).toBeTruthy();
    const updated=(await call('GET','/leads/'+l.id)).body;expect(updated.firstResponseAt).toBeTruthy();expect(updated.nextActionAt).toBeTruthy();
    const before=sent;await dispatch(async()=>({providerId:'should-not-send-'+(++sent)}));expect(sent).toBe(before);
  });
  it('does not automatically retry a delivery whose provider acknowledgement is uncertain',async()=>{
    const l=await lead();await message(l.id);let sent=0;
    await dispatch(async()=>{sent++;throw new DeliveryError('Fixture timeout; verify delivery',true);});
    expect((await all(l.id))[0].status).toBe('delivery_unknown');expect((await call('GET','/leads/'+l.id)).body.firstResponseAt).toBeNull();
    await dispatch(async()=>{sent++;return {providerId:'must-not-retry'};});expect(sent).toBe(1);
  });
  it('records a definite provider rejection as failed without claiming a response to the customer',async()=>{
    const l=await lead();await message(l.id);await dispatch(async()=>{throw new DeliveryError('Template rejected by provider',false);});
    expect((await all(l.id))[0].status).toBe('failed');expect((await call('GET','/leads/'+l.id)).body.firstResponseAt).toBeNull();
  });
  it('marks an interrupted worker outcome for review rather than sending twice',async()=>{
    const l=await lead(),queued=await message(l.id);
    await txTenant(tenant,(tx:any)=>tx.query(`UPDATE messages SET status='processing',send_attempted_at=now()-interval '6 minutes' WHERE tenant_id=$1 AND id=$2`,[tenant,queued.body.id]));
    let sent=0;await dispatch(async()=>{sent++;return {providerId:'must-not-send'};});expect(sent).toBe(0);expect((await all(l.id))[0].status).toBe('delivery_unknown');
  });
  it('rechecks reply-window expiry before sending a queued free-form reply',async()=>{
    const l=await lead();await txTenant(tenant,(tx:any)=>recordInbound(tx,{id:null,tenantId:tenant,role:'system'},{phone:l.phone,body:'Verified fixture',providerId:'expiry-inbound',leadId:l.id}));
    expect((await message(l.id,{template:undefined})).status).toBe(201);
    await txTenant(tenant,(tx:any)=>tx.query(`UPDATE messages SET created_at=now()-interval '25 hours' WHERE tenant_id=$1 AND provider_id='expiry-inbound'`,[tenant]));
    let sent=0;await dispatch(async()=>{sent++;return {providerId:'should-not-send'};});expect(sent).toBe(0);expect((await all(l.id)).find((m:any)=>m.direction==='outbound').status).toBe('failed');
  });
  it('keeps delivery status monotonic and saves callbacks arriving before send acknowledgement',async()=>{
    const {recordMessageReceipt}=await import('../src/services/receipts.js');
    const l=await lead();await message(l.id);
    const providerId='early-read-receipt';
    await dispatch(async()=>{
      await txTenant(tenant,(tx:any)=>recordMessageReceipt(tx,tenant,{id:providerId,status:'read',timestamp:String(Math.floor(Date.now()/1000))}));
      return {providerId};
    });
    expect((await all(l.id))[0].status).toBe('read');
    for(const status of ['sent','failed','delivered','read'])await txTenant(tenant,(tx:any)=>recordMessageReceipt(tx,tenant,{id:providerId,status,timestamp:String(Math.floor(Date.now()/1000))}));
    expect((await all(l.id))[0].status).toBe('read');
  });
  it('leaves ambiguous inbound conversations for administrator review instead of choosing another listing’s owner',async()=>{
    const phone='+971502009999';
    for(const ref of ['WA-LISTING-A','WA-LISTING-B'])expect((await call('POST','/leads',{name:'Two-listing contact',phone,source:'bayut',listingRef:ref})).status).toBe(201);
    const received=await txTenant(tenant,(tx:any)=>recordInbound(tx,{id:null,tenantId:tenant,role:'system'},{phone,body:'Which property was this?',providerId:'ambiguous-inbound'}));
    const l=(await call('GET','/leads/'+received.lead_id)).body;expect(l.ownerId).toBeNull();expect(l.source).toBe('whatsapp');expect(l.routingStatus).toBe('missing_reference');
  });
});
