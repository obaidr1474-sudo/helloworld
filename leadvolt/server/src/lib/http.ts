import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError, type ZodTypeAny } from 'zod';
import { badRequest, forbidden } from './errors.js';
import type { Actor } from '../services/leads.js';

export interface JwtUser { sub: string; tid: string; role: string; name?: string }

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

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'unauthorized', message: 'Sign in to continue.' });
  }
}

export const requireRole = (...roles: string[]) => async (req: FastifyRequest) => {
  if (!roles.includes(req.user.role)) throw forbidden();
};

export const ifMatch = (req: FastifyRequest): number | undefined => {
  const h = req.headers['if-match'];
  if (!h) return undefined;
  const n = Number(String(h).replace(/W\/|"/g, ''));
  return Number.isFinite(n) ? n : undefined;
};
