import crypto from 'node:crypto';
import * as OTPAuth from 'otpauth';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {config} from '../lib/config.js';
import {withTenant,type Tx} from '../lib/db.js';
import {audit,emit} from '../lib/events.js';

export const digest=(value:string)=>crypto.createHash('sha256').update(value).digest('hex');
const encryptionKey=()=>Buffer.from(config.authEncryptionKey,'base64');
export function encryptMfa(secret:string){
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey(),iv);
 const body=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
 return ['v1',iv.toString('base64'),cipher.getAuthTag().toString('base64'),body.toString('base64')].join('.');
}
export function decryptMfa(value:string){
 const [version,iv,tag,body]=value.split('.');if(version!=='v1')throw Error('Unsupported encrypted credential version');
 const cipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv,'base64'));cipher.setAuthTag(Buffer.from(tag,'base64'));
 return Buffer.concat([cipher.update(Buffer.from(body,'base64')),cipher.final()]).toString('utf8');
}
export const makeTotp=(secret:string,label='LeadVolt')=>new OTPAuth.TOTP({issuer:'LeadVolt',label,algorithm:'SHA1',digits:6,period:30,secret:OTPAuth.Secret.fromBase32(secret)});
export function totpStep(secret:string,code:string,now=Date.now()){
 if(!/^\d{6}$/.test(code))return null;
 const delta=makeTotp(secret).validate({token:code,timestamp:now,window:1});
 return delta===null?null:Math.floor(now/30000)+delta;
}
export const normalizeRecovery=(code:string)=>code.replace(/[-\s]/g,'').toLowerCase();
export async function consumeSecondFactor(tx:Tx,user:any,code:string){
 if(!user.mfa_enabled||!user.mfa_secret)return false;
 const step=totpStep(decryptMfa(user.mfa_secret),code);
 if(step!==null&&step>Number(user.mfa_last_step)){
  await tx.query('UPDATE users SET mfa_last_step=$3 WHERE tenant_id=$1 AND id=$2',[user.tenant_id,user.id,step]);return true;
 }
 const hash=digest(normalizeRecovery(code));
 if(!user.mfa_recovery_hashes.includes(hash))return false;
 await tx.query('UPDATE users SET mfa_recovery_hashes=array_remove(mfa_recovery_hashes,$3) WHERE tenant_id=$1 AND id=$2',[user.tenant_id,user.id,hash]);
 await audit(tx,user.tenant_id,user.id,'user',user.id,'mfa.recovery_code_used');return true;
}
export async function revokeUserSessions(tx:Tx,tenantId:string,userId:string){
 await tx.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE tenant_id=$1 AND user_id=$2 AND revoked_at IS NULL',[tenantId,userId]);
 await tx.query('UPDATE users SET auth_version=auth_version+1 WHERE tenant_id=$1 AND id=$2',[tenantId,userId]);
 await emit(tx,tenantId,'auth.revoked',{user_ids:[userId]});
}
export async function issueSession(app:FastifyInstance,u:any,reply:FastifyReply,req:FastifyRequest,mfaVerified=false){
 const id=crypto.randomUUID(),expires=new Date(Date.now()+config.sessionHours*3600000);
 await withTenant(u.tenant_id,async tx=>{
  await tx.query(`INSERT INTO auth_sessions(id,tenant_id,user_id,user_agent,ip_address,mfa_verified,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,u.tenant_id,u.id,String(req.headers['user-agent']??'').slice(0,300),req.ip.slice(0,100),mfaVerified,expires]);
  await audit(tx,u.tenant_id,u.id,'user',u.id,'login',{sessionId:id,mfaVerified});
 });
 const token=app.jwt.sign({sub:u.id,tid:u.tenant_id,role:u.role,name:u.full_name,ver:u.auth_version,sid:id},{expiresIn:`${config.sessionHours}h`});
 reply.setCookie('lv_session',token,{httpOnly:true,secure:config.production,sameSite:'lax',path:'/',maxAge:config.sessionHours*3600});
 return token;
}
export async function createChallenge(user:any){
 const token=crypto.randomBytes(32).toString('base64url');
 await withTenant(user.tenant_id,async tx=>{
  await tx.query(`INSERT INTO auth_challenges(tenant_id,user_id,token_hash,auth_version,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')`,[user.tenant_id,user.id,digest(token),user.auth_version]);
 });
 return user.tenant_id+'.'+token;
}
export function recoveryCodes(){return Array.from({length:10},()=>crypto.randomBytes(12).toString('hex').match(/.{1,6}/g)!.join('-'));}
