import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { ZodError } from 'zod';
import { config } from './lib/config.js';
import { HttpError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { leadRoutes } from './routes/leads.js';
import { appRoutes } from './routes/misc.js';
import './lib/http.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? true, bodyLimit: 1_048_576, trustProxy: true });

  // keep the raw body for HMAC verification (intake + WhatsApp webhooks)
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, undefined);
    try { done(null, JSON.parse(body.toString('utf8'))); } catch (e) { (e as any).statusCode = 400; done(e as Error, undefined); }
  });

  await app.register(cors, { origin: config.corsOrigin, credentials: true, exposedHeaders: ['etag'] });
  await app.register(jwt, { secret: config.jwtSecret });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err instanceof ZodError) return reply.code(400).send({ error: 'bad_request', message: 'Some fields are missing or invalid.', details: err.flatten() });
    if ((err as any).code === '23505') return reply.code(409).send({ error: 'conflict', message: 'That record already exists.' });
    if ((err as any).code === '22P02') return reply.code(400).send({ error: 'bad_request', message: 'An id in the request is not valid.' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal', message: 'Something went wrong on our side. Try again in a moment.' });
  });

  app.get('/healthz', async () => ({ ok: true }));
  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(leadRoutes);
    await api.register(appRoutes);
  }, { prefix: '/api/v1' });
  // public share pages live at the root for short URLs
  app.get('/s/:code', async (req, reply) => reply.redirect(`/api/v1/s/${(req.params as { code: string }).code}`));
  return app;
}
