import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import pg from 'pg';
import {io as client} from 'socket.io-client';
import crypto from 'node:crypto';
const enabled=!!process.env.TEST_DATABASE_URL&&!!process.env.TEST_MIGRATION_URL;
const suite=enabled?describe:describe.skip;
suite('listing delivery, ownership and company safeguards',()=>{
  let app:any,pool:any,withTenant:any,sign:any,sweep:any,base:string,tenant:string,secret:string;
  const token:Record<string,string>={},user:Record<string,string>={},lead:Record<string,any>={};
  const request=async(method:string,path:string,who='owner',body?:unknown,headers:Record<string,string>={})=>{
    const r=await app.inject({method,url:'/api/v1'+path,headers:{...(token[who]?{authorization:'Bearer '+token[who]}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},payload:body===undefined?undefined:JSON.stringify(body)});
    return {status:r.statusCode,body:r.body?JSON.parse(r.body):null,headers:r.headers};
  };
  async function mapping(ref:string,agent:string,source='bayut'){
    const r=await request('POST','/routing/listings','owner',{source,listingRef:ref,responsibleAgentId:user[agent],publisherAgentId:user.publisher});
    expect(r.status).toBe(201);return r.body;
  }
  async function deliver(ref:string|null,phone:string,eventId:string,source='bayut',name='Fictional buyer'){
    const body={contact:{name,phone},...(ref===null?{}:{listing:{reference:ref}})};
    const raw=JSON.stringify(body),timestamp=String(Math.floor(Date.now()/1000));
    const r=await app.inject({method:'POST',url:'/api/v1/intake/portal?source='+source,headers:{'content-type':'application/json','x-leadvolt-workspace':'routing-test','x-leadvolt-signature':sign(secret,raw,source,timestamp),'x-leadvolt-timestamp':timestamp,'x-leadvolt-event-id':eventId},payload:raw});
    return {status:r.statusCode,body:JSON.parse(r.body)};
  }
  const current=async(id:string,who='owner')=>(await request('GET','/leads/'+id,who)).body;
  beforeAll(async()=>{
    const workerUrl=new URL(process.env.TEST_MIGRATION_URL!);workerUrl.username='leadvolt_worker';workerUrl.password='leadvolt_worker';process.env.WORKER_DATABASE_URL=process.env.TEST_WORKER_DATABASE_URL??workerUrl.toString();
    process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;process.env.MIGRATION_DATABASE_URL=process.env.TEST_MIGRATION_URL;
    const owner=new pg.Client({connectionString:process.env.TEST_MIGRATION_URL});await owner.connect();await owner.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO leadvolt_app');await owner.end();
    const {migrate}=await import('../src/migrate.js');await migrate(process.env.TEST_MIGRATION_URL);
    ({pool,withTenant}=await import('../src/lib/db.js'));({signIntakeV2:sign}=await import('../src/services/intake.js'));({runSlaSweep:sweep}=await import('../src/workers.js'));
    const {buildApp}=await import('../src/app.js'),{attachRealtime}=await import('../src/realtime.js');
    app=await buildApp({logger:false});attachRealtime(app);await app.listen({port:0,host:'127.0.0.1'});base='http://127.0.0.1:'+app.server.address().port;
    const registered=await request('POST','/auth/register','none',{company:'Routing Test Realty',slug:'routing-test',name:'Company Owner',email:'owner@routing.test',password:'test-password-1234'});
    expect(registered.status).toBe(200);token.owner=registered.body.token;tenant=registered.body.tenant.id;
    user.owner=(await request('GET','/me')).body.id;
    for(const [key,name,role,brn] of [['publisher','Licensed Publisher','agent','BRN-123'],['b','Responsible Agent B','agent',null],['c','Responsible Agent C','agent',null],['viewer','Read Only','viewer',null],['revoke','Revocation Test','agent',null]]){
      const r=await request('POST','/users','owner',{name,email:key+'@routing.test',role,password:'test-password-1234',brokerRegistrationNumber:brn});expect(r.status).toBe(200);user[key!]=r.body.id;
      const login=await request('POST','/auth/login','none',{workspace:'routing-test',email:key+'@routing.test',password:'test-password-1234'});expect(login.status).toBe(200);token[key!]=login.body.token;
    }
    secret=(await request('POST','/settings/intake-secret/reveal','owner',{})).body.secret;
  });
  afterAll(async()=>{await app?.close();await pool?.end();});

  it('routes a publisher’s listing to the mapped agent without a BRN, even off shift',async()=>{
    await mapping('BAY-OWNER-B','b');
    const r=await deliver('BAY-OWNER-B','+971501000001','known-1');expect(r.status).toBe(201);expect(r.body.ownerId).toBe(user.b);expect(r.body.routingStatus).toBe('assigned');lead.known=await current(r.body.leadId);
    expect((await request('GET','/me','b')).body.is_clocked_in).toBe(false);
    expect((await request('GET','/leads/'+r.body.leadId,'publisher')).status).toBe(403);
    expect((await request('GET','/leads/'+r.body.leadId,'b')).status).toBe(200);
  });
  it('holds unknown references for administrators and prevents agents claiming them',async()=>{
    const r=await deliver('BAY-NEW','+971501000002','new-1');expect(r.status).toBe(201);expect(r.body.ownerId).toBeNull();expect(r.body.routingStatus).toBe('unmapped');lead.unknown=await current(r.body.leadId);
    const second=await deliver('BAY-NEW','+971501000003','new-2');lead.unknown2=await current(second.body.leadId);
    expect((await request('GET','/leads/'+r.body.leadId,'b')).status).toBe(403);
    expect((await request('GET','/leads?scope=unassigned&queue=all','b')).body.items).toHaveLength(0);
    expect((await request('POST','/leads/'+r.body.leadId+'/assign','b',{userId:user.b})).status).toBe(403);
    expect((await request('GET','/routing/exceptions','b')).status).toBe(403);
    const queue=await request('GET','/routing/exceptions');expect(queue.body.items.map((x:any)=>x.id)).toContain(r.body.leadId);
  });
  it('remembers a resolved listing owner, assigns every waiting enquiry and routes future enquiries',async()=>{
    const r=await request('POST','/leads/'+lead.unknown.id+'/resolve-routing','owner',{userId:user.b,saveMapping:true},{'if-match':'"'+lead.unknown.version+'"'});
    expect(r.status).toBe(200);expect(r.body.pendingAssigned).toBe(2);
    expect((await current(lead.unknown.id)).ownerId).toBe(user.b);expect((await current(lead.unknown2.id)).ownerId).toBe(user.b);
    const future=await deliver('BAY-NEW','+971501000004','new-3');expect(future.body.ownerId).toBe(user.b);
    expect((await request('GET','/routing/exceptions')).body.items.some((x:any)=>x.listingRef==='BAY-NEW')).toBe(false);
  });
  it('supports one-off assignment without changing future listing routing',async()=>{
    const first=await deliver('ONE-OFF','+971501000005','one-off-1'),l=await current(first.body.leadId);
    const r=await request('POST','/leads/'+l.id+'/resolve-routing','owner',{userId:user.b,saveMapping:false},{'if-match':'"'+l.version+'"'});expect(r.status).toBe(200);
    const future=await deliver('ONE-OFF','+971501000006','one-off-2');expect(future.body.ownerId).toBeNull();
    const repeat=await deliver('ONE-OFF','+971501000005','one-off-3');expect(repeat.body.ownerId).toBe(user.b);expect(repeat.body.reenquiry).toBe(true);
  });
  it('keeps a contact’s enquiries for different listings and portals under their respective owners',async()=>{
    await mapping('BAY-OWNER-C','c');await mapping('BAY-OWNER-B','c','property_finder');
    const a=await deliver('BAY-OWNER-B','+971501000007','multiple-a'),b=await deliver('BAY-OWNER-C','+971501000007','multiple-b'),c=await deliver('BAY-OWNER-B','+971501000007','multiple-c','property_finder');
    expect(new Set([a.body.leadId,b.body.leadId,c.body.leadId]).size).toBe(3);expect(a.body.ownerId).toBe(user.b);expect(b.body.ownerId).toBe(user.c);expect(c.body.ownerId).toBe(user.c);
    const repeat=await deliver('BAY-OWNER-B','+971501000007','multiple-a-again');expect(repeat.body.leadId).toBe(a.body.leadId);expect(repeat.body.reenquiry).toBe(true);
    expect((await current(a.body.leadId)).reenquiryCount).toBe(1);
  });
  it('acknowledges retried delivery IDs without creating duplicate enquiries and rejects changed content',async()=>{
    const a=await deliver('BAY-OWNER-B','+971501000008','retry-me');expect(a.status).toBe(201);
    const b=await deliver('BAY-OWNER-B','+971501000008','retry-me');expect(b.status).toBe(200);expect(b.body.duplicate).toBe(true);expect(b.body.leadId).toBe(a.body.leadId);
    expect((await current(a.body.leadId)).reenquiryCount).toBe(0);
    const mismatch=await deliver('BAY-OWNER-B','+971501000008','retry-me','bayut','Changed body');expect(mismatch.status).toBe(409);
  });
  it('serializes concurrent retries and genuine re-enquiries without losing them',async()=>{
    const retries=await Promise.all(Array.from({length:20},()=>deliver('BAY-OWNER-B','+971501000009','parallel-retry')));
    expect(retries.filter(r=>r.status===201)).toHaveLength(1);expect(retries.filter(r=>r.body.duplicate)).toHaveLength(19);expect(new Set(retries.map(r=>r.body.leadId)).size).toBe(1);
    const enquiries=await Promise.all(Array.from({length:30},(_,n)=>deliver('BAY-OWNER-B','+971501000010','genuine-'+n)));
    expect(enquiries.every(r=>[200,201].includes(r.status))).toBe(true);expect(new Set(enquiries.map(r=>r.body.leadId)).size).toBe(1);
    const final=await current(enquiries[0].body.leadId);expect(final.reenquiryCount).toBe(29);expect(final.ownerId).toBe(user.b);
  });
  it('holds missing references safely and can resolve them when the reference becomes known',async()=>{
    const r=await deliver(null,'+971501000011','missing-ref');expect(r.body.ownerId).toBeNull();expect(r.body.routingStatus).toBe('missing_reference');const l=await current(r.body.leadId);
    const bad=await request('POST','/leads/'+l.id+'/resolve-routing','owner',{userId:user.b,saveMapping:true},{'if-match':'"'+l.version+'"'});expect(bad.status).toBe(400);
    const ok=await request('POST','/leads/'+l.id+'/resolve-routing','owner',{userId:user.b,saveMapping:true,listingRef:'RECOVERED-REF'},{'if-match':'"'+l.version+'"'});expect(ok.status).toBe(200);expect(ok.body.lead.listingRef).toBe('RECOVERED-REF');
    expect((await deliver('RECOVERED-REF','+971501000012','recovered-future')).body.ownerId).toBe(user.b);
  });
  it('rejects stale mapping edits and does not silently reassign previously worked leads',async()=>{
    const map=await mapping('MAPPING-VERSION','b');const incoming=await deliver('MAPPING-VERSION','+971501000013','version-1');
    const body={source:'bayut',listingRef:'MAPPING-VERSION',responsibleAgentId:user.c,publisherAgentId:user.publisher};
    const save=await request('PUT','/routing/listings/'+map.id,'owner',body,{'if-match':'"'+map.version+'"'});expect(save.status).toBe(200);
    expect((await request('PUT','/routing/listings/'+map.id,'owner',body,{'if-match':'"'+map.version+'"'})).status).toBe(412);
    expect((await current(incoming.body.leadId)).ownerId).toBe(user.b);expect((await deliver('MAPPING-VERSION','+971501000014','version-2')).body.ownerId).toBe(user.c);
  });
  it('records receipt acknowledgement separately from a meaningful daily agent update',async()=>{
    const l=await current(lead.known.id);
    expect((await request('POST','/leads/'+l.id+'/acknowledge','c',{})).status).toBe(403);
    expect((await request('POST','/leads/'+l.id+'/acknowledge','b',{})).status).toBe(200);
    const acknowledged=await current(l.id);expect(acknowledged.acknowledgedAt).toBeTruthy();expect(acknowledged.lastAgentUpdateAt).toBeNull();
    await request('POST','/leads/'+l.id+'/notes','owner',{body:'Administrator reviewed delivery'});expect((await current(l.id)).lastAgentUpdateAt).toBeNull();
    await request('POST','/leads/'+l.id+'/notes','b',{body:'Spoke with the buyer; requested a viewing'});expect((await current(l.id)).lastAgentUpdateAt).toBeTruthy();
    const day=await request('GET','/leads?queue=needs_update','b');expect(day.status).toBe(200);expect(day.body.items.map((v:any)=>v.id)).not.toContain(l.id);
    expect((await request('GET','/operations/team')).body.find((u:any)=>u.id===user.b)).toBeTruthy();
  });
  it('does not redistribute listing-owned or unresolved enquiries after an SLA breach',async()=>{
    const owner=new pg.Client({connectionString:process.env.TEST_MIGRATION_URL});await owner.connect();
    await owner.query(`UPDATE tenants SET settings=settings||'{"sla_auto_reassign":true}' WHERE id=$1`,[tenant]);
    await owner.query(`UPDATE leads SET sla_due_at=now()-interval '1 minute',sla_breached_at=NULL WHERE tenant_id=$1 AND source='bayut' AND first_response_at IS NULL`,[tenant]);await owner.end();
    await sweep();expect((await current(lead.known.id)).ownerId).toBe(user.b);
    const pending=await request('GET','/routing/exceptions');expect(pending.body.items.find((l:any)=>l.listingRef==='ONE-OFF').ownerId).toBeNull();
  });
  it('creates only one active booking when a booked lead is saved again',async()=>{
    const l=await current(lead.known.id);const body={disposition:'booked',dealValue:2000000};
    const booked=await request('POST','/leads/'+l.id+'/disposition','b',body,{'if-match':'"'+l.version+'"'});expect(booked.status).toBe(200);
    const again=await request('POST','/leads/'+l.id+'/disposition','b',{...body,dealValue:2500000},{'if-match':'"'+booked.body.lead.version+'"'});expect(again.status).toBe(200);
    const deals=await withTenant(tenant,(tx:any)=>tx.query('SELECT * FROM deals WHERE tenant_id=$1 AND lead_id=$2 AND voided_at IS NULL',[tenant,l.id]));expect(deals.rows).toHaveLength(1);expect(Number(deals.rows[0].deal_value)).toBe(2500000);
  });
  it('enforces role restrictions for administration and read-only accounts',async()=>{
    for(const path of ['/routing/listings','/routing/exceptions','/operations/team','/operations/audit','/operations/integrations'])expect((await request('GET',path,'b')).status).toBe(403);
    expect((await request('POST','/settings/intake-secret/reveal','b',{})).status).toBe(403);
    expect((await request('POST','/tasks','viewer',{title:'Forbidden',type:'custom',dueAt:new Date(Date.now()+864e5).toISOString()})).status).toBe(403);
    expect((await request('POST','/leads','viewer',{name:'Forbidden',phone:'+971501000090',source:'other'})).status).toBe(403);
    expect((await request('GET','/settings')).body.intake_secret).toBeUndefined();
    expect((await request('PATCH','/users/'+user.owner,'owner',{isActive:false})).status).toBe(403);
  });
  it('protects cross-tenant references with database constraints and preserves an append-only audit log',async()=>{
    const other=await request('POST','/auth/register','none',{company:'Other Workspace',slug:'other-routing',name:'Other Owner',email:'other@routing.test',password:'test-password-1234'});expect(other.status).toBe(200);token.other=other.body.token;
    const otherUser=(await request('GET','/me','other')).body.id;
    const cross=await request('POST','/routing/listings','owner',{source:'bayut',listingRef:'FOREIGN',responsibleAgentId:otherUser});expect(cross.status).toBe(400);
    await expect(withTenant(tenant,(tx:any)=>tx.query(`INSERT INTO tasks(tenant_id,assignee_id,type,title,due_at) VALUES($1,$2,'custom','Forbidden cross tenant',now())`,[tenant,otherUser]))).rejects.toMatchObject({code:'23503'});
    await expect(withTenant(tenant,(tx:any)=>tx.query('DELETE FROM audit_log WHERE tenant_id=$1',[tenant]))).rejects.toMatchObject({code:'42501'});
    expect((await request('GET','/leads/'+lead.known.id,'other')).status).toBe(404);
  });
  it('removes old-owner websocket access immediately after reassignment',async()=>{
    const received=await deliver('BAY-OWNER-B','+971501000050','socket-routing'),id=received.body.leadId;
    const a=client(base,{path:'/ws',auth:{token:token.b},transports:['websocket']}),b=client(base,{path:'/ws',auth:{token:token.c},transports:['websocket']});
    try{
      await Promise.all([a,b].map(s=>new Promise<void>((resolve,reject)=>{s.once('connect',()=>resolve());s.once('connect_error',reject);})));
      const frames:any[]=[];a.on('event',e=>frames.push(e));
      const subscribed=await new Promise<any>(resolve=>a.emit('lead:subscribe',id,resolve));expect(subscribed.ok).toBe(true);
      const revoked=new Promise<any>(resolve=>a.on('event',e=>{if(e.type==='lead.access_revoked'&&e.data.lead_id===id)resolve(e);}));
      await request('POST','/leads/'+id+'/assign','owner',{userId:user.c});await revoked;
      const marker='Only new owner may receive '+crypto.randomUUID();
      const delivered=new Promise<any>(resolve=>b.on('event',e=>{if(e.type==='interaction.created'&&e.data.summary===marker)resolve(e);}));
      await request('POST','/leads/'+id+'/notes','c',{body:marker});await delivered;
      expect(frames.some(e=>e.data?.summary===marker)).toBe(false);
      expect((await request('GET','/leads/'+id,'b')).status).toBe(403);
    }finally{a.close();b.close();}
  });
  it('revokes existing sessions when an account is deactivated',async()=>{
    const socket=client(base,{path:'/ws',auth:{token:token.revoke},transports:['websocket']});
    try{
      await new Promise<void>((resolve,reject)=>{socket.once('connect',()=>resolve());socket.once('connect_error',reject);});
      const disconnected=new Promise<void>(resolve=>socket.once('disconnect',()=>resolve()));
      expect((await request('PATCH','/users/'+user.revoke,'owner',{isActive:false})).status).toBe(200);await disconnected;
      expect((await request('GET','/me','revoke')).status).toBe(401);
      expect((await request('POST','/auth/login','none',{workspace:'routing-test',email:'revoke@routing.test',password:'test-password-1234'})).status).toBe(401);
    }finally{socket.close();}
  });
  it('rejects cookie-authenticated writes without a CSRF header and revokes logout sessions',async()=>{
    const login=await request('POST','/auth/login','none',{workspace:'routing-test',email:'c@routing.test',password:'test-password-1234'});expect(login.status).toBe(200);
    const cookie=String(login.headers['set-cookie']).split(';')[0];expect(cookie).toContain('lv_session=');expect(login.headers['set-cookie']).toContain('HttpOnly');
    const denied=await app.inject({method:'POST',url:'/api/v1/attendance/clock-in',headers:{cookie},payload:{}});expect(denied.statusCode).toBe(403);
    const allowed=await app.inject({method:'POST',url:'/api/v1/attendance/clock-in',headers:{cookie,'x-leadvolt-csrf':'1'},payload:{}});expect(allowed.statusCode).toBe(200);
    const malicious=await app.inject({method:'POST',url:'/api/v1/attendance/clock-in',headers:{cookie,'x-leadvolt-csrf':'1',origin:'https://attacker.example'},payload:{}});expect(malicious.statusCode).toBe(403);
    expect((await request('POST','/auth/logout','c',{})).status).toBe(200);expect((await request('GET','/me','c')).status).toBe(401);
  });
  it('records delivery activity without exposing raw customer payloads or credentials',async()=>{
    const events=await request('GET','/operations/integrations');expect(events.status).toBe(200);
    expect(events.body.sources.find((s:any)=>s.source==='bayut').duplicates).toBeGreaterThan(0);
    expect(events.body.sources.find((s:any)=>s.source==='bayut').rejected).toBeGreaterThan(0);
    expect(JSON.stringify(events.body)).not.toContain(secret);
    expect(events.body.events.every((e:any)=>e.raw_payload===undefined)).toBe(true);
    expect((await request('GET','/readyz','none')).status).toBe(404); // readiness is deliberately outside /api/v1
    expect((await app.inject({method:'GET',url:'/readyz'})).statusCode).toBe(200);
  });
  it('rejects privileged owner connections for the production API runtime',async()=>{
    const {assertRuntimeDatabase}=await import('../src/lib/db.js');
    const privileged=new pg.Pool({connectionString:process.env.TEST_MIGRATION_URL});
    const worker=new pg.Pool({connectionString:process.env.TEST_WORKER_DATABASE_URL??process.env.WORKER_DATABASE_URL});
    try{await expect(assertRuntimeDatabase(true,privileged)).rejects.toThrow(/non-owner/);await expect(assertRuntimeDatabase(true,worker)).rejects.toThrow(/worker membership/);await expect(assertRuntimeDatabase(true,pool)).resolves.toBeUndefined();}finally{await privileged.end();await worker.end();}
  });
  it('keeps separate missing-reference events from the same contact for administrator review',async()=>{
    const a=await deliver(null,'+971501000070','missing-separate-a');
    const b=await deliver(null,'+971501000070','missing-separate-b');
    expect(a.status).toBe(201);expect(b.status).toBe(201);expect(a.body.leadId).not.toBe(b.body.leadId);
    expect((await deliver(null,'+971501000070','missing-separate-a')).body.leadId).toBe(a.body.leadId);
  });
  it('requires record versions and rejects one of two competing lead updates',async()=>{
    const incoming=await deliver('BAY-OWNER-B','+971501000071','optimistic-race'),l=await current(incoming.body.leadId);
    const body={disposition:'callback',nextActionAt:new Date(Date.now()+864e5).toISOString()};
    expect((await request('POST','/leads/'+l.id+'/disposition','b',body)).status).toBe(428);
    const results=await Promise.all([1,2].map(()=>request('POST','/leads/'+l.id+'/disposition','b',body,{'if-match':'"'+l.version+'"'})));
    expect(results.map(r=>r.status).sort()).toEqual([200,412]);
    expect((await request('POST','/leads','owner',{name:'Bad budget',phone:'+971501000072',source:'other',requirements:{budgetMin:200,budgetMax:100}})).status).toBe(400);
  });
  it('requires a fresh daily update and receipt acknowledgement after reassignment',async()=>{
    const incoming=await deliver('BAY-OWNER-B','+971501000073','reset-day'),id=incoming.body.leadId;
    await request('POST','/leads/'+id+'/notes','b',{body:'Previous owner updated this lead'});
    expect((await current(id)).lastAgentUpdateAt).toBeTruthy();
    await request('POST','/leads/'+id+'/assign','owner',{userId:user.publisher});
    const moved=await current(id);expect(moved.lastAgentUpdateAt).toBeNull();expect(moved.acknowledgedAt).toBeNull();
    expect((await request('GET','/leads?queue=needs_update','publisher')).body.items.map((l:any)=>l.id)).toContain(id);
  });
  it('protects inventory from stale edits and excludes internal notes from public property shares',async()=>{
    const input={projectName:'Fictional Inventory',community:'Test community',offeringType:'ready',propertyType:'apartment',beds:1,price:1200000,notes:'PRIVATE COMMISSION DETAIL'};
    const property=await request('POST','/properties','owner',input);expect(property.status).toBe(201);
    const saved=await request('PUT','/properties/'+property.body.id,'owner',{...input,price:1300000},{'if-match':'"'+property.body.version+'"'});expect(saved.status).toBe(200);
    expect((await request('PUT','/properties/'+property.body.id,'owner',input,{'if-match':'"'+property.body.version+'"'})).status).toBe(412);
    const incoming=await deliver('BAY-OWNER-B','+971501000074','share-privacy');
    const share=await request('POST','/leads/'+incoming.body.leadId+'/share','owner',{propertyIds:[property.body.id]});expect(share.status).toBe(201);
    const page=await app.inject({method:'GET',url:'/api/v1/s/'+share.body.code});expect(page.statusCode).toBe(200);expect(page.body).toContain('Fictional Inventory');expect(page.body).not.toContain('PRIVATE COMMISSION DETAIL');
  });
  it('allows read-only users to log out and revokes that session',async()=>{
    expect((await request('POST','/auth/logout','viewer',{})).status).toBe(200);
    expect((await request('GET','/me','viewer')).status).toBe(401);
  });
  it('uses a signed payload event ID even when an unsigned header changes',async()=>{
    const raw=JSON.stringify({event_id:'body-bound-event',contact:{name:'Signed event fixture',phone:'+971501000080'},listing:{reference:'BAY-OWNER-B'}}),timestamp=String(Math.floor(Date.now()/1000));
    const send=(header:string)=>app.inject({method:'POST',url:'/api/v1/intake/portal?source=bayut',headers:{'content-type':'application/json','x-leadvolt-workspace':'routing-test','x-leadvolt-signature':sign(secret,raw,'bayut',timestamp),'x-leadvolt-timestamp':timestamp,'x-leadvolt-event-id':header},payload:raw});
    const first=await send('untrusted-header-a'),retry=await send('untrusted-header-b');
    expect(first.statusCode).toBe(201);expect(retry.statusCode).toBe(200);expect(JSON.parse(retry.body).duplicate).toBe(true);expect(JSON.parse(retry.body).leadId).toBe(JSON.parse(first.body).leadId);
  });
  it('returns open leads for review when their owner changes to a role that cannot receive enquiries',async()=>{
    await mapping('ROLE-CHANGE','publisher');const received=await deliver('ROLE-CHANGE','+971501000081','role-before');expect(received.body.ownerId).toBe(user.publisher);
    expect((await request('PATCH','/users/'+user.publisher,'owner',{role:'viewer'})).status).toBe(200);
    const held=await current(received.body.leadId);expect(held.ownerId).toBeNull();expect(held.routingStatus).toBe('agent_unavailable');
    const future=await deliver('ROLE-CHANGE','+971501000082','role-after');expect(future.body.ownerId).toBeNull();expect(future.body.routingStatus).toBe('agent_unavailable');
    expect((await request('GET','/me','publisher')).status).toBe(401);
  });
  it('rate-limits repeated login attempts',async()=>{
    const statuses=[];
    for(let i=0;i<12;i++) statuses.push((await request('POST','/auth/login','none',{workspace:'routing-test',email:'missing@routing.test',password:'bad-password'})).status);
    expect(statuses).toContain(429);
  });
});
