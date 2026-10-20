import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { badRequest, forbidden } from './errors.js';
import { withTenant } from './db.js';
import { config } from './config.js';
import type { Actor } from '../services/leads.js';

export interface JwtUser { sub: string; tid: string; role: string; name?: string; ver?: number; exp?:number;sid?:string }

declare module '@fastify/jwt' {
  interface FastifyJWT { payload: JwtUser; user: JwtUser }
}
declare module 'fastify' {
  interface FastifyRequest { rawBody?: Buffer }
}

export const actorOf = (req: FastifyRequest): Actor => ({ id: req.user.sub, tenantId: req.user.tid, role: req.user.role });

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data);
  } catch (e) {
    if (e instanceof ZodError) throw badRequest('Some fields are missing or invalid.', e.flatten());
    throw e;
  }
}

async function identity(user:JwtUser) {
  return withTenant(user.tid,async tx=>{
    const current=(await tx.query(`SELECT u.id,u.role,u.is_active,u.auth_version,u.mfa_enabled,s.mfa_verified,s.last_seen_at,
      t.settings->'mfa_required_roles' AS required_roles FROM users u JOIN tenants t ON t.id=u.tenant_id
      JOIN auth_sessions s ON s.tenant_id=u.tenant_id AND s.user_id=u.id AND s.id=$3 AND s.revoked_at IS NULL AND s.expires_at>now()
      WHERE u.tenant_id=$1 AND u.id=$2`,[user.tid,user.sub,user.sid??null])).rows[0];
    if(!current||!current.is_active||current.role!==user.role||current.auth_version!==(user.ver??0)||(current.mfa_enabled&&!current.mfa_verified))return null;
    if(new Date(current.last_seen_at).getTime()<Date.now()-300000)await tx.query('UPDATE auth_sessions SET last_seen_at=now() WHERE tenant_id=$1 AND id=$2',[user.tid,user.sid]);
    return current;
  });
}
export async function validateIdentity(user:JwtUser){const u=await identity(user);return !!u&&(u.mfa_enabled||!u.required_roles?.includes(u.role));}
export function validateOrigin(req:FastifyRequest) {
  const origin=req.headers.origin;
  if(origin && ![...config.corsOrigin,new URL(config.publicBaseUrl).origin].includes(origin)) throw forbidden('This origin is not allowed.');
}
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try { await req.jwtVerify(); }
  catch { return reply.code(401).send({error:'unauthorized',message:'Sign in to continue.'}); }
  const current=await identity(req.user);
  if (!current) return reply.code(401).send({error:'session_revoked',message:'Your session has ended. Sign in again.'});
  const path=req.url.split('?')[0];
  const securityPath=path.startsWith('/api/v1/security/')||path==='/api/v1/me'||path==='/api/v1/auth/logout';
  if(!securityPath&&!current.mfa_enabled&&current.required_roles?.includes(current.role))return reply.code(403).send({error:'mfa_enrollment_required',message:'Set up two-factor authentication in Account security to access this workspace.'});
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    if(req.user.role==='viewer'&&!securityPath)throw forbidden('This account has read-only access.');
    validateOrigin(req);
    if (!req.headers.authorization && req.headers['x-leadvolt-csrf']!=='1') throw forbidden('A same-origin request header is required.');
  }
}

export const requireRole = (...roles: string[]) => async (req: FastifyRequest) => {
  if (!roles.includes(req.user.role)) throw forbidden();
};

export const ifMatch = (req: FastifyRequest): number | undefined => {
  const h = req.headers['if-match'];
  if (!h) return undefined;
  const n = Number(String(h).replace(/W\/|"/g, ''));
  if (!Number.isInteger(n)||n<1) throw badRequest('If-Match must contain the current record version.');
  return n;
};
