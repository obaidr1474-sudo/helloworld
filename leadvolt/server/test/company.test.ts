import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import pg from 'pg';
import crypto from 'node:crypto';
import * as OTPAuth from 'otpauth';
const enabled=!!process.env.TEST_DATABASE_URL&&!!process.env.TEST_MIGRATION_URL;
(enabled?describe:describe.skip)('company controls and operational completeness',()=>{
 let app:any,pool:any,withTenant:any,tenant:string,secret:string,ownerMfa:string,confirmedCode:string,backup:string[],reportLead:string;
 const tokens:Record<string,string>={},users:Record<string,string>={};let requests=0;
 const password='company-fixture-password-123';
 const call=async(method:string,path:string,body?:any,who='owner',headers:any={})=>{
  const r=await app.inject({method,url:'/api/v1'+path,remoteAddress:'192.0.2.'+(1+Math.floor(requests++/6)%200),headers:{...(tokens[who]?{authorization:'Bearer '+tokens[who]}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},payload:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.statusCode,body:r.body?JSON.parse(r.body):null,headers:r.headers};
 };
 const login=(who='owner')=>call('POST','/auth/login',{workspace:'company-controls',email:who+'@company.test',password},'none');
 const code=(key:string,timestamp=Date.now())=>new OTPAuth.TOTP({secret:OTPAuth.Secret.fromBase32(key),period:30,digits:6,algorithm:'SHA1'}).generate({timestamp});
 const version=(n:number)=>({'if-match':'"'+n+'"'});
 async function deliver(id:string,phone:string,source='bayut',valid=true){
  const payload={event_id:id,contact:{name:'Fictional company buyer',phone:valid?phone:'invalid'},listing:{reference:'COMPANY-LISTING'}};
  const raw=JSON.stringify(payload),timestamp=String(Math.floor(Date.now()/1000)),signature='sha256='+crypto.createHmac('sha256',secret).update(timestamp+'.'+source+'.'+raw).digest('hex');
  const r=await app.inject({method:'POST',url:'/api/v1/intake/portal?source='+source,headers:{'content-type':'application/json','x-leadvolt-workspace':'company-controls','x-leadvolt-timestamp':timestamp,'x-leadvolt-signature':signature},payload:raw});
  return {status:r.statusCode,body:JSON.parse(r.body)};
 }
 beforeAll(async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;process.env.MIGRATION_DATABASE_URL=process.env.TEST_MIGRATION_URL;
  const worker=new URL(process.env.TEST_MIGRATION_URL!);worker.username='leadvolt_worker';worker.password='leadvolt_worker';process.env.WORKER_DATABASE_URL=process.env.TEST_WORKER_DATABASE_URL??worker.toString();
  const owner=new pg.Client({connectionString:process.env.TEST_MIGRATION_URL});await owner.connect();await owner.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO leadvolt_app');await owner.end();
  await (await import('../src/migrate.js')).migrate(process.env.TEST_MIGRATION_URL);
  ({pool,withTenant}=await import('../src/lib/db.js'));app=await (await import('../src/app.js')).buildApp({logger:false});
  const registered=await call('POST','/auth/register',{company:'Company Controls (fictional)',slug:'company-controls',name:'Company Owner',email:'owner@company.test',password},'none');expect(registered.status).toBe(200);tokens.owner=registered.body.token;tenant=registered.body.tenant.id;users.owner=(await call('GET','/me')).body.id;
  for(const [key,role] of [['agent','agent'],['viewer','viewer'],['manager','manager'],['admin','admin']]){
   const u=await call('POST','/users',{name:key+' fixture',email:key+'@company.test',password,role});expect(u.status).toBe(200);users[key]=u.body.id;
   const signed=await login(key);expect(signed.status).toBe(200);tokens[key]=signed.body.token;
  }
  secret=(await call('POST','/settings/intake-secret/reveal',{})).body.secret;
 });
 afterAll(async()=>{await app?.close();await pool?.end();});
 it('records distinct sessions and revokes one device without ending another',async()=>{
  const first=tokens.agent,second=await login('agent');expect(second.status).toBe(200);tokens.agent=second.body.token;
  const sessions=await call('GET','/security/sessions',undefined,'agent');expect(sessions.body).toHaveLength(2);
  const old=sessions.body.find((s:any)=>!s.current);expect((await call('DELETE','/security/sessions/'+old.id,undefined,'agent')).status).toBe(200);
  expect((await call('GET','/me',undefined,'none',{authorization:'Bearer '+first})).status).toBe(401);
  expect((await call('GET','/me',undefined,'agent')).status).toBe(200);
  expect((await call('DELETE','/security/sessions/'+sessions.body.find((s:any)=>s.current).id,undefined,'viewer')).status).toBe(404);
 });
 it('requires password proof for enrollment and stores only encrypted authenticator secrets',async()=>{
  expect((await call('POST','/security/mfa/setup',{password:'wrong'})).status).toBe(403);
  const setup=await call('POST','/security/mfa/setup',{password});expect(setup.status).toBe(200);ownerMfa=setup.body.secret;expect(setup.body.qrDataUrl).toMatch(/^data:image\/png/);
  expect((await call('POST','/security/mfa/confirm',{code:'wrong-code'})).status).toBe(401);
  confirmedCode=code(ownerMfa);const previous=tokens.owner,confirm=await call('POST','/security/mfa/confirm',{code:confirmedCode});expect(confirm.status).toBe(200);backup=confirm.body.recoveryCodes;expect(backup).toHaveLength(10);tokens.owner=confirm.body.token;
  expect((await call('GET','/me',undefined,'none',{authorization:'Bearer '+previous})).status).toBe(401);
  const row=(await withTenant(tenant,(tx:any)=>tx.query('SELECT mfa_secret,mfa_pending_secret,mfa_recovery_hashes FROM users WHERE tenant_id=$1 AND id=$2',[tenant,users.owner]))).rows[0];
  expect(row.mfa_secret).not.toContain(ownerMfa);expect(row.mfa_pending_secret).toBeNull();expect(row.mfa_recovery_hashes).not.toContain(backup[0]);expect(JSON.stringify((await call('GET','/security/account')).body)).not.toContain(ownerMfa);
 });
 it('requires a second factor before issuing a login token and consumes recovery codes once',async()=>{
  const challenge=await login();expect(challenge.body.token).toBeUndefined();expect(challenge.headers['set-cookie']).toBeUndefined();expect(challenge.body.mfaRequired).toBe(true);
  const verify=await call('POST','/auth/mfa/verify',{challenge:challenge.body.challenge,code:backup[0]},'none');expect(verify.status).toBe(200);expect(verify.body.token).toBeTruthy();
  expect((await call('POST','/auth/mfa/verify',{challenge:challenge.body.challenge,code:backup[1]},'none')).status).toBe(401);
  const again=await login();expect((await call('POST','/auth/mfa/verify',{challenge:again.body.challenge,code:backup[0]},'none')).status).toBe(401);
  expect((await call('POST','/auth/mfa/verify',{challenge:again.body.challenge,code:backup[1]},'none')).status).toBe(200);
 });
 it('rejects repeated authenticator time steps and limits attempts on an individual challenge',async()=>{
  const attempt=await login();expect((await call('POST','/auth/mfa/verify',{challenge:attempt.body.challenge,code:confirmedCode},'none')).status).toBe(401);
  const exhausted=await login();
  for(let n=0;n<5;n++)expect((await call('POST','/auth/mfa/verify',{challenge:exhausted.body.challenge,code:'badcode'},'none')).status).toBe(401);
  expect((await call('POST','/auth/mfa/verify',{challenge:exhausted.body.challenge,code:backup[2]},'none')).status).toBe(401);
 });
 it('allows read-only users to secure their account but blocks workspace security changes',async()=>{
  expect((await call('GET','/security/account',undefined,'viewer')).status).toBe(200);
  expect((await call('POST','/security/mfa/setup',{password},'viewer')).status).toBe(200);
  expect((await call('GET','/security/team',undefined,'viewer')).status).toBe(403);
  expect((await call('PUT','/security/policy',{version:1,requiredRoles:[],password,code:'000000'},'agent')).status).toBe(403);
 });
 it('protects private saved views and shared views retain agent ownership restrictions',async()=>{
  const privateView=await call('POST','/saved-views',{name:'Private owner pipeline',query:{queue:'all',scope:'all'}});expect(privateView.status).toBe(201);
  expect((await call('GET','/saved-views',undefined,'agent')).body).toHaveLength(0);
  expect((await call('DELETE','/saved-views/'+privateView.body.id,undefined,'manager',version(1))).status).toBe(404);
  expect((await call('POST','/saved-views',{name:'Agent cannot publish',query:{queue:'all'},isShared:true},'agent')).status).toBe(403);
  const shared=await call('POST','/saved-views',{name:'Company pipeline',query:{queue:'all',scope:'all'},isShared:true});expect(shared.status).toBe(201);
  expect((await call('GET','/saved-views',undefined,'agent')).body).toHaveLength(1);
  expect((await call('PUT','/saved-views/'+shared.body.id,{name:'Tampered',query:{},isShared:true},'agent',version(1))).status).toBe(403);
  const other=await call('POST','/leads',{name:'Private company lead',phone:'+971505001001',source:'other',ownerId:users.owner});expect(other.status).toBe(201);
  expect((await call('GET','/leads?queue=all&scope=all',undefined,'agent')).body.items).toHaveLength(0);
  const saved=await call('PUT','/saved-views/'+shared.body.id,{name:'Shared edited',query:{queue:'overdue'},isShared:true},'owner',version(1));expect(saved.status).toBe(200);
  expect((await call('PUT','/saved-views/'+shared.body.id,{name:'Stale',query:{},isShared:true},'owner',version(1))).status).toBe(412);
  expect((await call('POST','/saved-views',{name:'Invalid filters',query:{sql:'anything'}})).status).toBe(400);
 });
 it('reconciles missing, rejected, accepted and repeated exported portal enquiry IDs',async()=>{
  expect((await deliver('company-received','+971505001010')).status).toBe(201);
  expect((await deliver('company-rejected','+971505001011','bayut',false)).status).toBe(400);
  const r=await call('POST','/reconciliation',{source:'bayut',eventIds:['company-received','company-rejected','never-delivered','company-received']});expect(r.status).toBe(201);
  expect(r.body).toMatchObject({provider_count:3,received_count:1,missing_count:1,rejected_count:1,duplicate_rows:1});
  expect(r.body.items.find((i:any)=>i.provider_event_id==='never-delivered').status).toBe('missing');
  expect((await call('GET','/reconciliation/'+r.body.id)).body.items).toHaveLength(3);
  expect((await call('GET','/reconciliation',undefined,'agent')).status).toBe(403);
  expect((await call('POST','/reconciliation',{source:'property_finder',eventIds:['company-received']})).body.missing_count).toBe(1);
  expect((await call('POST','/reconciliation',{source:'bayut',eventIds:[]})).status).toBe(400);
 });
 it('holds manual portal leads without a reference instead of assigning them through general rules',async()=>{
  const r=await call('POST','/leads',{name:'Unidentified portal enquiry',phone:'+971505001012',source:'bayut',ownerId:'auto'});expect(r.status).toBe(201);expect(r.body.lead.ownerId).toBeNull();expect(r.body.lead.routingStatus).toBe('missing_reference');
 });
 it('keeps reconciliation as a snapshot and accepted retries override past rejection diagnostics',async()=>{
  expect((await deliver('company-rejected','+971505001011')).status).toBe(201);
  const result=await call('POST','/reconciliation',{source:'bayut',eventIds:['company-rejected']});expect(result.body).toMatchObject({received_count:1,rejected_count:0,missing_count:0});
  const history=(await call('GET','/reconciliation')).body;expect(history.find((r:any)=>r.provider_count===3).rejected_count).toBe(1);
 });
 it('reports activity by period and actor instead of confusing it with lead creation or ownership',async()=>{
  const r=await call('POST','/leads',{name:'Reporting fixture',phone:'+971505001020',source:'website',ownerId:users.agent});expect(r.status).toBe(201);reportLead=r.body.lead.id;
  await call('POST','/leads/'+reportLead+'/calls',{direction:'outbound',outcome:'connected',durationSec:120},'agent');
  const admin=new pg.Client({connectionString:process.env.TEST_MIGRATION_URL});await admin.connect();await admin.query("UPDATE leads SET created_at=now()-interval '40 days' WHERE id=$1",[reportLead]);await admin.end();
  const from=new Date(Date.now()-86400000).toISOString(),to=new Date(Date.now()+86400000).toISOString();
  const result=await call('GET','/reports/management?'+new URLSearchParams({from,to,agentId:users.agent,source:'website'}));expect(result.status).toBe(200);
  expect(result.body.totals.leads_created).toBe(0);expect(result.body.calls.find((u:any)=>u.id===users.agent)).toMatchObject({total_calls:1,connected:1,duration_sec:120});
  expect(result.body.stages.find((s:any)=>s.stage==='contacted').leads).toBe(1);
  expect((await call('GET','/reports/management?'+new URLSearchParams({from,to}),undefined,'agent')).status).toBe(403);
  expect((await call('GET','/reports/management?'+new URLSearchParams({from:to,to:from}))).status).toBe(400);
 });
 it('tracks stage age independently from ordinary notes and marks actual stage transitions',async()=>{
  const before=(await withTenant(tenant,(tx:any)=>tx.query('SELECT stage_entered_at FROM leads WHERE id=$1',[reportLead]))).rows[0].stage_entered_at;
  await call('POST','/leads/'+reportLead+'/notes',{body:'A note must not reset stage age'},'agent');
  const after=(await withTenant(tenant,(tx:any)=>tx.query('SELECT stage_entered_at,stage_age_estimated FROM leads WHERE id=$1',[reportLead]))).rows[0];expect(after.stage_entered_at).toEqual(before);expect(after.stage_age_estimated).toBe(false);
 });
 it('protects approved bookings and tracks finance references in order',async()=>{
  const l=await call('POST','/leads',{name:'Finance fixture',phone:'+971505001090',source:'other',ownerId:users.agent});expect(l.status).toBe(201);
  const booked=await call('POST','/leads/'+l.body.lead.id+'/disposition',{disposition:'booked',dealValue:400000},'agent',version(l.body.lead.version));expect(booked.status).toBe(200);
  let deal=(await call('GET','/deals')).body.find((d:any)=>d.lead_id===l.body.lead.id);expect(deal.status).toBe('pending_approval');
  expect((await call('POST','/deals/'+deal.id+'/transition',{status:'approved'},'agent',version(deal.version))).status).toBe(403);
  const commission=await call('PATCH','/deals/'+deal.id,{commissionPct:3},'owner',version(deal.version));expect(commission.status).toBe(200);deal=commission.body;
  const approved=await call('POST','/deals/'+deal.id+'/transition',{status:'approved'},'manager',version(deal.version));expect(approved.status).toBe(200);deal=approved.body;
  expect((await call('POST','/leads/'+l.body.lead.id+'/disposition',{disposition:'booked',dealValue:500000},'agent',version(booked.body.lead.version))).status).toBe(409);
  expect((await call('POST','/deals/'+deal.id+'/transition',{status:'paid',paymentRef:'bank-fixture'},'owner',version(deal.version))).status).toBe(400);
  const invoice=await call('POST','/deals/'+deal.id+'/transition',{status:'invoiced',invoiceRef:'INV-FIXTURE-001'},'owner',version(deal.version));expect(invoice.status).toBe(200);deal=invoice.body;
  const paid=await call('POST','/deals/'+deal.id+'/transition',{status:'paid',paymentRef:'BANK-FIXTURE-001'},'owner',version(deal.version));expect(paid.status).toBe(200);expect(Number(paid.body.brokerage_amount)).toBe(12000);
  expect((await call('POST','/deals/'+deal.id+'/transition',{status:'cancelled',note:'Do not erase paid bookings'},'owner',version(paid.body.version))).status).toBe(400);
 });
 it('requires MFA policy enrollment while preserving access to enrollment and current-password controls',async()=>{
  const p=(await call('GET','/security/policy')).body;
  const r=await call('PUT','/security/policy',{version:p.version,requiredRoles:['owner','agent'],password,code:backup[3]});expect(r.status).toBe(200);
  expect((await call('GET','/me',undefined,'agent')).status).toBe(401);
  tokens.agent=(await login('agent')).body.token;
  const blocked=await call('GET','/leads',undefined,'agent');expect(blocked.status).toBe(403);expect(blocked.body.error).toBe('mfa_enrollment_required');
  expect((await call('GET','/security/account',undefined,'agent')).status).toBe(200);
  expect((await call('GET','/me',undefined,'agent')).body.mfa_required).toBe(true);
  expect((await call('POST','/security/mfa/disable',{password,code:backup[4]})).status).toBe(403);
  expect((await call('PUT','/security/policy',{version:p.version,requiredRoles:[],password,code:backup[4]})).status).toBe(412);
 });
 it('replaces recovery codes and invalidates every previous code',async()=>{
  const replacement=await call('POST','/security/mfa/recovery-codes',{password,code:backup[5]});expect(replacement.status).toBe(200);
  const challenge=await login();expect((await call('POST','/auth/mfa/verify',{challenge:challenge.body.challenge,code:backup[6]},'none')).status).toBe(401);
  backup=replacement.body.recoveryCodes;expect((await call('POST','/auth/mfa/verify',{challenge:challenge.body.challenge,code:backup[0]},'none')).status).toBe(200);
 });
 it('changes a personal password and revokes the prior sessions',async()=>{
  const old=tokens.viewer,newPassword='new-viewer-password-456';
  expect((await call('POST','/security/password',{currentPassword:'wrong',newPassword},'viewer')).status).toBe(403);
  const change=await call('POST','/security/password',{currentPassword:password,newPassword},'viewer');expect(change.status).toBe(200);tokens.viewer=change.body.token;
  expect((await call('GET','/me',undefined,'none',{authorization:'Bearer '+old})).status).toBe(401);
  expect((await login('viewer')).status).toBe(401);
  expect((await call('POST','/auth/login',{workspace:'company-controls',email:'viewer@company.test',password:newPassword},'none')).status).toBe(200);
 });
 it('requires a second factor to disable MFA and clears stored credentials after explicit disable',async()=>{
  const setup=await call('POST','/security/mfa/setup',{password},'admin');expect(setup.status).toBe(200);
  const enabled=await call('POST','/security/mfa/confirm',{code:code(setup.body.secret)},'admin');expect(enabled.status).toBe(200);tokens.admin=enabled.body.token;
  expect((await call('POST','/security/mfa/disable',{password,code:'wrong-code'},'admin')).status).toBe(401);
  const disabled=await call('POST','/security/mfa/disable',{password,code:enabled.body.recoveryCodes[0]},'admin');expect(disabled.status).toBe(200);tokens.admin=disabled.body.token;
  expect((await call('GET','/security/account',undefined,'admin')).body.mfa_enabled).toBe(false);
  expect((await login('admin')).body.mfaRequired).toBeUndefined();
 });
 it('allows administrators to revoke staff sessions without exposing secrets',async()=>{
  expect((await call('POST','/security/team/'+users.manager+'/revoke',{})).status).toBe(200);
  expect((await call('GET','/me',undefined,'manager')).status).toBe(401);
  expect((await call('POST','/security/team/'+users.owner+'/revoke',{},'admin')).status).toBe(403);
  const team=await call('GET','/security/team');expect(team.status).toBe(200);expect(JSON.stringify(team.body)).not.toContain(ownerMfa);expect(team.body.find((u:any)=>u.id===users.owner).mfa_enabled).toBe(true);
 });
});
