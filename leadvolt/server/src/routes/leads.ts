import type { FastifyInstance } from 'fastify';
import { requirementsSchema } from '../lib/validation.js';
import { z } from 'zod';
import { withTenant } from '../lib/db.js';
import { actorOf, authenticate, ifMatch, parse } from '../lib/http.js';
import { notFound } from '../lib/errors.js';
import * as L from '../services/leads.js';
import { createShareLink } from '../services/share.js';
import { listMessages, sendOrLog, recordInbound } from '../services/messages.js';
import { DISPOSITIONS, STAGES } from '../domain/pipeline.js';

const reqSchema=requirementsSchema;

const createSchema = z.object({
  name: z.string().trim().min(1).max(200), phone: z.string().nullable().optional(), email: z.string().email().nullable().optional().or(z.literal('')),
  source:z.string().trim().regex(/^[a-z0-9_]{1,50}$/), subSource: z.string().nullable().optional(), listingRef:z.string().trim().max(200).nullable().optional(),
  requirements: reqSchema.optional(), note: z.string().nullable().optional(),
  ownerId: z.union([z.string().uuid(), z.literal('auto'), z.null()]).optional(),
});

const listSchema = z.object({
      scope: z.enum(['all', 'mine', 'unassigned', 'reenquired', 'sla']).optional(),
      queue: z.enum(['active', 'new', 'scheduled', 'overdue', 'eoi', 'booked', 'lost','all','needs_update','unacknowledged']).optional(),
      source: z.string().optional(), stage: z.enum(STAGES).optional(), ownerId: z.string().optional(),
      temperature: z.enum(['hot', 'warm', 'cold']).optional(), q: z.string().optional(),
      sort: z.enum(['updated', 'created', 'next_action', 'score']).optional(), cursor: z.string().optional(),
      createdFrom: z.string().datetime({ offset: true }).optional(), createdTo: z.string().datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    });


export async function leadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.get('/meta/pipeline', async () => ({ stages: STAGES, dispositions: DISPOSITIONS }));

  app.get('/leads', async (req) => {
    const a = actorOf(req);
    const p = parse(listSchema, req.query);
    return withTenant(a.tenantId, (tx) => L.listLeads(tx, a, p));
  });

  app.get('/leads/counts', async (req) => { const a = actorOf(req); return withTenant(a.tenantId, (tx) => L.queueCounts(tx, a, parse(listSchema, req.query))); });

  app.post('/leads', async (req, reply) => {
    const a = actorOf(req); const b = parse(createSchema, req.body);
    const r = await withTenant(a.tenantId, (tx) => L.createOrReenquire(tx, a, {
      ...b, email: b.email || null, ownerId: b.ownerId === undefined ? 'auto' : b.ownerId,
    }));
    reply.code(r.created ? 201 : 200).header('etag', `"${r.lead.version}"`);
    return r;
  });

  app.get('/leads/:id', async (req, reply) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    const lead = await withTenant(a.tenantId, async (tx) => { const l = await L.loadLead(tx, a.tenantId, id); L.assertCanRead(a, l); return L.leadDto(l); });
    reply.header('etag', `"${lead.version}"`);
    return lead;
  });

  app.patch('/leads/:id', async (req, reply) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    const b = parse(z.object({
      name: z.string().min(1).optional(), phone:z.string().max(80).nullable().optional(),email:z.string().email().max(254).nullable().optional(),
      source: z.string().optional(), subSource: z.string().nullable().optional(), requirements: reqSchema.optional(),
      temperature: z.enum(['hot', 'warm', 'cold']).nullable().optional(), tags: z.array(z.string()).optional(),
    }), req.body);
    const lead = await withTenant(a.tenantId, (tx) => L.patchLead(tx, a, id, b, ifMatch(req)));
    reply.header('etag', `"${lead.version}"`);
    return lead;
  });

  app.delete('/leads/:id', async (req, reply) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    await withTenant(a.tenantId, (tx) => L.softDelete(tx, a, id));
    reply.code(204).send();
  });

  app.post('/leads/:id/disposition', async (req, reply) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    const b = parse(z.object({
      disposition: z.string(), subStatus: z.string().optional(), nextActionAt: z.string().datetime({ offset: true }).nullable().optional(),
      dealValue: z.number().positive().max(999_999_999_999.99).multipleOf(0.01).nullable().optional(), propertyId: z.string().uuid().nullable().optional(),
      note: z.string().max(5000).nullable().optional(), assignTo: z.string().uuid().nullable().optional(),
    }), req.body);
    const r = await withTenant(a.tenantId, (tx) => L.applyDisposition(tx, a, id, b, ifMatch(req)));
    reply.header('etag', `"${r.lead.version}"`);
    return r;
  });

  app.post('/leads/:id/assign', async (req) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    const b = parse(z.object({ userId: z.string().uuid().nullable() }), req.body);
    return withTenant(a.tenantId, (tx) => L.assignLead(tx, a, id, b.userId));
  });

  app.post('/leads/bulk-assign', async (req) => {
    const a = actorOf(req);
    const b = parse(z.object({ leadIds: z.array(z.string().uuid()).min(1).max(500), userId: z.string().uuid().nullable() }), req.body);
    return withTenant(a.tenantId, async (tx) => {
      let n = 0;
      for (const id of b.leadIds) { await L.assignLead(tx, a, id, b.userId); n++; }
      return { updated: n };
    });
  });

  app.get('/leads/:id/timeline', async (req) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    const p = parse(z.object({ before: z.string().optional(), limit: z.coerce.number().int().max(200).optional() }), req.query);
    return withTenant(a.tenantId, (tx) => L.timeline(tx, a, id, p.before, p.limit));
  });

  app.post('/leads/:id/notes', async (req, reply) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    const b = parse(z.object({ body: z.string().min(1).max(5000), confidential: z.boolean().optional() }), req.body);
    reply.code(201);
    return withTenant(a.tenantId, (tx) => L.addNote(tx, a, id, b.body, b.confidential));
  });

  app.post('/leads/:id/calls', async (req, reply) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    const b = parse(z.object({
      direction: z.enum(['inbound', 'outbound']), outcome: z.enum(['connected', 'no_answer', 'busy', 'switched_off', 'wrong_number']),
      durationSec:z.number().int().min(0).max(86400).optional(), notes: z.string().max(5000).optional(),
    }), req.body);
    reply.code(201);
    return withTenant(a.tenantId, (tx) => L.logCall(tx, a, id, b));
  });

  app.get('/leads/:id/matches', async (req) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    return withTenant(a.tenantId, (tx) => L.matchesForLead(tx, a, id));
  });

  app.post('/leads/:id/share', async (req, reply) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    const b = parse(z.object({ propertyIds: z.array(z.string().uuid()).min(1).max(5), channel: z.enum(['whatsapp', 'email', 'link']).optional() }), req.body);
    reply.code(201);
    return withTenant(a.tenantId, (tx) => createShareLink(tx, a, id, b.propertyIds, b.channel));
  });

  app.get('/leads/:id/messages', async (req) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    return withTenant(a.tenantId, (tx) => listMessages(tx, a, id));
  });

  app.post('/leads/:id/messages', async (req, reply) => {
    const a = actorOf(req); const { id } = req.params as { id: string };
    const b = parse(z.object({
      clientRequestId:z.string().uuid().optional(),body: z.string().max(4096).default(''), direction: z.enum(['outbound', 'inbound']).default('outbound'), mode: z.enum(['send', 'log']).default('log'),
      template: z.object({ name: z.string(), lang: z.string().default('en'), vars: z.array(z.string()).default([]) }).optional(),
    }), req.body);
    reply.code(201);
    return withTenant(a.tenantId, async (tx) => {
      if (b.direction === 'inbound') {
        const l = await L.loadLead(tx, a.tenantId, id); L.assertCanWrite(a, l);
        const m = await recordInbound(tx, a, { phone: l.phone_e164 ?? '', body: b.body, leadId: id });
        if (!m) throw notFound('Message');
        return m;
      }
      return sendOrLog(tx, a, id, b.body, {mode:b.mode,template:b.template,clientRequestId:b.clientRequestId});
    });
  });
}
