import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import {Secret} from 'otpauth';
import {withTenant} from '../lib/db.js';
import {actorOf,authenticate,parse,requireRole,validateOrigin} from '../lib/http.js';
import {badRequest,forbidden,HttpError,notFound,preconditionFailed} from '../lib/errors.js';
import {audit,emit} from '../lib/events.js';
import {consumeSecondFactor,decryptMfa,digest,encryptMfa,issueSession,makeTotp,normalizeRecovery,recoveryCodes,revokeUserSessions,totpStep} from '../services/security.js';
const limited={config:{rateLimit:{max:8,timeWindow:'1 minute'}}};
const codeSchema=z.string().trim().min(6).max(80);
const failure=()=>new HttpError(401,'invalid_second_factor','The code is invalid, expired or already used. Try the next authenticator code or an unused recovery code.');
const userForUpdate=async(tx:any,tenant:string,id:string)=>(await tx.query('SELECT * FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[tenant,id])).rows[0];
export async function securityRoutes(app:FastifyInstance){
 app.post('/auth/mfa/verify',limited,async(req,reply)=>{
  validateOrigin(req);
  const b=parse(z.object({challenge:z.string().regex(/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/),code:codeSchema}),req.body);
  const [tenant,token]=b.challenge.split('.');parse(z.string().uuid(),tenant);
  const user=await withTenant(tenant,async tx=>{
   const challenge=(await tx.query('SELECT * FROM auth_challenges WHERE tenant_id=$1 AND token_hash=$2 FOR UPDATE',[tenant,digest(token)])).rows[0];
   if(!challenge||challenge.consumed_at||challenge.attempts>=5||new Date(challenge.expires_at).getTime()<=Date.now())return null;
   await tx.query('UPDATE auth_challenges SET attempts=attempts+1 WHERE id=$1',[challenge.id]);
   const u=await userForUpdate(tx,tenant,challenge.user_id);
   if(!u||!u.is_active||u.auth_version!==challenge.auth_version||!(await consumeSecondFactor(tx,u,b.code)))return null;
   await tx.query('UPDATE auth_challenges SET consumed_at=now() WHERE id=$1',[challenge.id]);return u;
  });
  if(!user)throw failure();
  return {token:await issueSession(app,user,reply,req,true)};
 });
 app.register(async r=>{
  r.addHook('preHandler',authenticate);
  r.get('/security/account',async req=>{
   const a=actorOf(req);return withTenant(a.tenantId,async tx=>{
    const u=(await tx.query('SELECT mfa_enabled,cardinality(mfa_recovery_hashes) AS recovery_codes_remaining FROM users WHERE tenant_id=$1 AND id=$2',[a.tenantId,a.id])).rows[0];
    return {...u};
   });
  });
  r.post('/security/mfa/setup',limited,async req=>{
   const a=actorOf(req),b=parse(z.object({password:z.string().max(256)}),req.body);
   const secret=new Secret({size:20}).base32;
   const label=await withTenant(a.tenantId,async tx=>{
    const u=await userForUpdate(tx,a.tenantId,a.id!);
    if(!await bcrypt.compare(b.password,u.password_hash))throw forbidden('Your current password is not correct.');
    if(u.mfa_enabled)throw badRequest('Two-factor authentication is already enabled.');
    await tx.query("UPDATE users SET mfa_pending_secret=$3,mfa_pending_expires_at=now()+interval '10 minutes' WHERE tenant_id=$1 AND id=$2",[a.tenantId,a.id,encryptMfa(secret)]);
    await audit(tx,a.tenantId,a.id,'user',a.id,'mfa.setup_started');return u.email;
   });
   const uri=makeTotp(secret,label).toString();return {secret,uri,qrDataUrl:await QRCode.toDataURL(uri,{width:240,margin:1})};
  });
  r.post('/security/mfa/confirm',limited,async(req,reply)=>{
   const a=actorOf(req),b=parse(z.object({code:codeSchema}),req.body),codes=recoveryCodes();
   const u=await withTenant(a.tenantId,async tx=>{
    const user=await userForUpdate(tx,a.tenantId,a.id!);
    if(user.mfa_enabled||!user.mfa_pending_secret||new Date(user.mfa_pending_expires_at).getTime()<=Date.now())throw badRequest('Start two-factor setup again.');
    const step=totpStep(decryptMfa(user.mfa_pending_secret),b.code);if(step===null)throw failure();
    await tx.query(`UPDATE users SET mfa_secret=mfa_pending_secret,mfa_pending_secret=NULL,mfa_pending_expires_at=NULL,mfa_enabled=true,mfa_last_step=$3,mfa_recovery_hashes=$4 WHERE tenant_id=$1 AND id=$2`,[a.tenantId,a.id,step,codes.map(c=>digest(normalizeRecovery(c)))]);
    await revokeUserSessions(tx,a.tenantId,a.id!);await audit(tx,a.tenantId,a.id,'user',a.id,'mfa.enabled');
    return userForUpdate(tx,a.tenantId,a.id!);
   });
   return {token:await issueSession(app,u,reply,req,true),recoveryCodes:codes};
  });
  r.post('/security/mfa/disable',limited,async(req,reply)=>{
   const a=actorOf(req),b=parse(z.object({password:z.string().max(256),code:codeSchema}),req.body);
   const u=await withTenant(a.tenantId,async tx=>{
    const user=await userForUpdate(tx,a.tenantId,a.id!);
    const t=(await tx.query("SELECT settings->'mfa_required_roles' AS roles FROM tenants WHERE id=$1 FOR SHARE",[a.tenantId])).rows[0];
    if(t.roles?.includes(user.role))throw forbidden('Your workspace policy requires two-factor authentication.');
    if(!await bcrypt.compare(b.password,user.password_hash)||!await consumeSecondFactor(tx,user,b.code))throw failure();
    await tx.query('UPDATE users SET mfa_secret=NULL,mfa_enabled=false,mfa_last_step=-1,mfa_recovery_hashes=\'{}\' WHERE tenant_id=$1 AND id=$2',[a.tenantId,a.id]);
    await revokeUserSessions(tx,a.tenantId,a.id!);await audit(tx,a.tenantId,a.id,'user',a.id,'mfa.disabled');return userForUpdate(tx,a.tenantId,a.id!);
   });
   return {token:await issueSession(app,u,reply,req)};
  });
  r.post('/security/mfa/recovery-codes',limited,async req=>{
   const a=actorOf(req),b=parse(z.object({password:z.string().max(256),code:codeSchema}),req.body),codes=recoveryCodes();
   await withTenant(a.tenantId,async tx=>{
    const u=await userForUpdate(tx,a.tenantId,a.id!);
    if(!await bcrypt.compare(b.password,u.password_hash)||!await consumeSecondFactor(tx,u,b.code))throw failure();
    await tx.query('UPDATE users SET mfa_recovery_hashes=$3 WHERE tenant_id=$1 AND id=$2',[a.tenantId,a.id,codes.map(c=>digest(normalizeRecovery(c)))]);
    await audit(tx,a.tenantId,a.id,'user',a.id,'mfa.recovery_codes_regenerated');
   });return {recoveryCodes:codes};
  });
  r.get('/security/sessions',async req=>{
   const a=actorOf(req);return withTenant(a.tenantId,async tx=>(await tx.query(`SELECT id,user_agent,ip_address,created_at,last_seen_at,expires_at,mfa_verified,id=$3 AS current FROM auth_sessions WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC LIMIT 100`,[a.tenantId,a.id,req.user.sid])).rows);
  });
  r.delete('/security/sessions/:id',async(req,reply)=>{
   const a=actorOf(req),id=parse(z.string().uuid(),(req.params as any).id);
   await withTenant(a.tenantId,async tx=>{
    const row=await tx.query('UPDATE auth_sessions SET revoked_at=now() WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND revoked_at IS NULL RETURNING id',[a.tenantId,a.id,id]);
    if(!row.rowCount)throw notFound('Session');await emit(tx,a.tenantId,'auth.session_revoked',{session_id:id});await audit(tx,a.tenantId,a.id,'user',a.id,'session.revoked',{sessionId:id});
   });
   if(id===req.user.sid)reply.clearCookie('lv_session',{path:'/'});return {ok:true};
  });
  r.post('/security/password',limited,async(req,reply)=>{
   const a=actorOf(req),b=parse(z.object({currentPassword:z.string().max(256),newPassword:z.string().min(12).refine(v=>Buffer.byteLength(v)<=72),code:codeSchema.optional()}),req.body);
   const hash=await bcrypt.hash(b.newPassword,12);
   const u=await withTenant(a.tenantId,async tx=>{
    const user=await userForUpdate(tx,a.tenantId,a.id!);
    if(!await bcrypt.compare(b.currentPassword,user.password_hash))throw forbidden('Your current password is not correct.');
    if(user.mfa_enabled&&(!b.code||!await consumeSecondFactor(tx,user,b.code)))throw failure();
    await tx.query('UPDATE users SET password_hash=$3 WHERE tenant_id=$1 AND id=$2',[a.tenantId,a.id,hash]);
    await revokeUserSessions(tx,a.tenantId,a.id!);await audit(tx,a.tenantId,a.id,'user',a.id,'password.changed');return userForUpdate(tx,a.tenantId,a.id!);
   });return {token:await issueSession(app,u,reply,req,u.mfa_enabled)};
  });
  r.get('/security/policy',{preHandler:requireRole('owner','admin')},async req=>{
   const a=actorOf(req);return withTenant(a.tenantId,async tx=>(await tx.query("SELECT COALESCE(settings->'mfa_required_roles','[]'::jsonb) AS required_roles,security_policy_version AS version FROM tenants WHERE id=$1",[a.tenantId])).rows[0]);
  });
  r.put('/security/policy',{preHandler:requireRole('owner','admin'),...limited},async req=>{
   const a=actorOf(req),b=parse(z.object({version:z.number().int().positive(),requiredRoles:z.array(z.enum(['owner','admin','manager','agent','listing_manager','viewer'])).max(6),password:z.string().max(256),code:codeSchema}),req.body);
   return withTenant(a.tenantId,async tx=>{
    const t=(await tx.query('SELECT security_policy_version FROM tenants WHERE id=$1 FOR UPDATE',[a.tenantId])).rows[0];
    if(t.security_policy_version!==b.version)throw preconditionFailed('The security policy changed. Reload before saving.');
    const u=await userForUpdate(tx,a.tenantId,a.id!);
    if(!u.mfa_enabled)throw forbidden('Enable your own two-factor authentication before changing the workspace policy.');
    if(!await bcrypt.compare(b.password,u.password_hash)||!await consumeSecondFactor(tx,u,b.code))throw failure();
    await tx.query("UPDATE tenants SET settings=jsonb_set(settings,'{mfa_required_roles}',$2::jsonb),security_policy_version=security_policy_version+1 WHERE id=$1",[a.tenantId,JSON.stringify([...new Set(b.requiredRoles)])]);
    const unenrolled=(await tx.query('SELECT id FROM users WHERE tenant_id=$1 AND NOT mfa_enabled AND role::text=ANY($2::text[]) ORDER BY id FOR UPDATE',[a.tenantId,b.requiredRoles])).rows;
    for(const staff of unenrolled)await revokeUserSessions(tx,a.tenantId,staff.id);
    await audit(tx,a.tenantId,a.id,'tenant',a.tenantId,'security.policy_changed',{requiredRoles:b.requiredRoles});return {ok:true};
   });
  });
  r.get('/security/team',{preHandler:requireRole('owner','admin')},async req=>{
   const a=actorOf(req);return withTenant(a.tenantId,async tx=>(await tx.query(`SELECT u.id,u.full_name,u.email,u.role,u.is_active,u.mfa_enabled,count(s.id)::int AS active_sessions FROM users u LEFT JOIN auth_sessions s ON s.tenant_id=u.tenant_id AND s.user_id=u.id AND s.revoked_at IS NULL AND s.expires_at>now() WHERE u.tenant_id=$1 GROUP BY u.id ORDER BY u.full_name`,[a.tenantId])).rows);
  });
  r.post('/security/team/:id/revoke',{preHandler:requireRole('owner','admin')},async req=>{
   const a=actorOf(req),id=parse(z.string().uuid(),(req.params as any).id);
   await withTenant(a.tenantId,async tx=>{
    const user=await userForUpdate(tx,a.tenantId,id);if(!user)throw notFound('Teammate');
    if(user.role==='owner'&&a.role!=='owner')throw forbidden('Only the owner can revoke the owner’s sessions.');
    await revokeUserSessions(tx,a.tenantId,id);await audit(tx,a.tenantId,a.id,'user',id,'sessions.admin_revoked');
   });return {ok:true};
  });
 });
}
