import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { badRequest, forbidden } from './errors.js';
import { withTenant } from './db.js';
import { config } from './config.js';
import type { Actor } from '../services/leads.js';

export interface JwtUser { sub: string; tid: string; role: string; name?: string; ver?: number; exp?:number }

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

export async function validateIdentity(user:JwtUser) {
  return withTenant(user.tid,async tx=>{
    const current=(await tx.query(`SELECT id,role,is_active,auth_version FROM users WHERE tenant_id=$1 AND id=$2`,[user.tid,user.sub])).rows[0];
    return !!current && current.is_active && current.role===user.role && current.auth_version===(user.ver??0);
  });
}
export function validateOrigin(req:FastifyRequest) {
  const origin=req.headers.origin;
  if(origin && ![...config.corsOrigin,new URL(config.publicBaseUrl).origin].includes(origin)) throw forbidden('This origin is not allowed.');
}
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try { await req.jwtVerify(); }
  catch { return reply.code(401).send({error:'unauthorized',message:'Sign in to continue.'}); }
  if (!(await validateIdentity(req.user))) return reply.code(401).send({error:'session_revoked',message:'Your session has ended. Sign in again.'});
  if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
    if(req.user.role==='viewer'&&!req.url.split('?')[0].endsWith('/auth/logout'))throw forbidden('This account has read-only access.');
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
