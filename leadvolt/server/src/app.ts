import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { pool } from './lib/db.js';
import { operationRoutes } from './routes/operations.js';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { ZodError } from 'zod';
import { config } from './lib/config.js';
import { HttpError } from './lib/errors.js';
import {dealRoutes} from './routes/deals.js';
import {workspaceRoutes} from './routes/workspace.js';
import {securityRoutes} from './routes/security.js';
import { authRoutes } from './routes/auth.js';
import { leadRoutes } from './routes/leads.js';
import { appRoutes } from './routes/misc.js';
import './lib/http.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger===false?false:{redact:['req.headers.authorization','req.headers.cookie','res.headers[\"set-cookie\"]']}, bodyLimit:1_048_576,trustProxy:config.trustProxy });

  // keep the raw body for HMAC verification (intake + WhatsApp webhooks)
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, undefined);
    try { done(null, JSON.parse(body.toString('utf8'))); } catch (e) { (e as any).statusCode = 400; done(e as Error, undefined); }
  });

  await app.register(cors, { origin: config.corsOrigin, credentials: true, exposedHeaders: ['etag'] });
  await app.register(cookie);
  await app.register(jwt,{secret:config.jwtSecret,cookie:{cookieName:'lv_session',signed:false}});
  await app.register(rateLimit,{keyGenerator:req=>{try{const t=req.headers.authorization?.replace(/^Bearer /i,'')??req.cookies?.lv_session;if(t){const u=app.jwt.verify<{sub:string;tid:string}>(t);return `user:${u.tid}:${u.sub}`;}}catch{}return `ip:${req.ip}`;},max:600,timeWindow:'1 minute',errorResponseBuilder:()=>new HttpError(429,'rate_limited','Too many requests. Please wait a minute before trying again.')});
  app.addHook('onSend',async(req,reply,payload)=>{reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','same-origin').header('X-Frame-Options','DENY');if(req.url.startsWith('/api/')) reply.header('Cache-Control','no-store');return payload;});

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request', message: 'Some fields are missing or invalid.', details: err.flatten() });
    if ((err as any).code === '23505') return reply.code(409).send({ error: 'conflict', message: 'That record already exists.' });
    if ((err as any).code === '23503') return reply.code(400).send({error:'bad_request',message:'The related record is unavailable in this workspace.'});
    if ((err as any).code==='40P01'||(err as any).code==='40001') return reply.code(409).send({error:'retry_conflict',message:'Another update is in progress. Reload and try again.'});
    if ((err as any).code === '22P02') return reply.code(400).send({ error: 'bad_request', message: 'An id in the request is not valid.' });
    const failure=err as {statusCode?:number;message?:string};
    if (failure.statusCode && failure.statusCode<500) return reply.code(failure.statusCode).send({error:failure.statusCode===429?'rate_limited':'bad_request',message:failure.message});
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on our side. Try again in a moment.' });
  });

  app.get('/healthz',async()=>({ok:true}));
  app.get('/readyz',async(_req,reply)=>{try{await pool.query('SELECT 1');return {ok:true,database:'connected'};}catch{return reply.code(503).send({ok:false,database:'unavailable'});}});
  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(securityRoutes);
    await api.register(workspaceRoutes);
    await api.register(dealRoutes);
    await api.register(leadRoutes);
    await api.register(appRoutes);
    await api.register(operationRoutes);
  }, { prefix: '/api/v1' });
  // public share pages live at the root for short URLs
  app.get('/s/:code', async (req, reply) => reply.redirect(`/api/v1/s/${(req.params as { code: string }).code}`));
  return app;
}
