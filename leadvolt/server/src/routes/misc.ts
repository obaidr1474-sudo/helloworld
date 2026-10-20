import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { q, withSystem, withTenant } from '../lib/db.js';
import { config } from '../lib/config.js';
import { badRequest,HttpError, notFound } from '../lib/errors.js';
import { actorOf, authenticate, parse,requireRole,ifMatch } from '../lib/http.js';
import { createTask, listTasks, setTaskStatus } from '../services/tasks.js';
import { matchingLeads, upsertProperty } from '../services/properties.js';
import { overview } from '../services/analytics.js';
import { inbox, recordInbound, verifyMetaSignature } from '../services/messages.js';
import {recordMessageReceipt} from '../services/receipts.js';
import { openShareLink } from '../services/share.js';
import { normalizeIntake,receiveEnquiry,verifyIntakeV2,verifyIntake, type AdapterName } from '../services/intake.js';
import { createOrReenquire } from '../services/leads.js';
import { allocate, type Rule } from '../domain/allocation.js';

const propertySchema = z.object({
  reference: z.string().optional(), projectName: z.string().min(1), developer: z.string().optional(), community: z.string().min(1),
  subCommunity: z.string().optional(), offeringType: z.enum(['ready', 'off_plan']), purpose: z.enum(['sale', 'rent']).optional(),
  propertyType: z.string().min(1), beds: z.number().int().min(0), baths: z.number().int().min(0).optional(), areaSqft:z.number().finite().min(0).max(1e9).optional(),
  price:z.number().finite().positive().max(1e12), handover: z.string().optional(), status: z.enum(['available', 'reserved', 'sold', 'rented', 'off_market']).optional(),
  permitNumber: z.string().optional(), brochureUrl:z.string().url().refine(v=>/^https?:\/\//i.test(v),'Use an HTTP or HTTPS URL.').optional().or(z.literal('')), notes: z.string().optional(),
  portalRefs: z.record(z.string()).optional(),
});

const ruleSchema = z.object({
  name: z.string().min(1), priority: z.number().int().default(100), isEnabled: z.boolean().default(true),
  definition: z.object({
    conditions: z.object({
      all: z.array(z.object({ field: z.string(), op: z.enum(['eq', 'neq', 'in', 'nin', 'gte', 'lte', 'contains']), value: z.unknown() })).optional(),
      any: z.array(z.object({ field: z.string(), op: z.enum(['eq', 'neq', 'in', 'nin', 'gte', 'lte', 'contains']), value: z.unknown() })).optional(),
    }),
    strategy: z.enum(['round_robin', 'least_loaded', 'sticky_owner', 'manual_pool']),
    pool: z.object({ userIds: z.array(z.string().uuid()).optional(), teamId: z.string().uuid().optional(), onlyClockedIn: z.boolean().optional(), respectCapacity: z.boolean().optional() }),
    sla: z.object({ firstResponseMinutes: z.number().int().positive().optional(), reassignAfterMinutes: z.number().int().positive().optional() }).optional(),
  }),
});

export async function appRoutes(app: FastifyInstance) {
  // ------------------------------------------------ authenticated
  app.register(async (r) => {
    r.addHook('preHandler', authenticate);

    r.get('/tasks', async (req) => {
      const a = actorOf(req);
      const p = parse(z.object({ queue: z.enum(['overdue', 'today', 'upcoming', 'done']).optional(), assigneeId: z.string().uuid().optional(), leadId: z.string().uuid().optional() }), req.query);
      return withTenant(a.tenantId, (tx) => listTasks(tx, a, p));
    });
    r.post('/tasks', async (req, reply) => {
      const a = actorOf(req);
      const b = parse(z.object({
        leadId: z.string().uuid().nullable().optional(), assigneeId: z.string().uuid().optional(),
        type: z.enum(['call', 'whatsapp', 'meeting', 'site_visit', 'follow_up', 'document', 'custom']), title: z.string().min(1),
        notes: z.string().optional(), dueAt: z.string().datetime({ offset: true }), priority: z.number().int().min(1).max(3).optional(),
        propertyId: z.string().uuid().nullable().optional(),
      }), req.body);
      reply.code(201);
      return withTenant(a.tenantId, (tx) => createTask(tx, a, b));
    });
    r.post('/tasks/:id/complete', async (req) => {
      const a = actorOf(req); const { id } = req.params as { id: string };
      const b = parse(z.object({ outcome: z.string().optional() }).default({}), req.body ?? {});
      return withTenant(a.tenantId, (tx) => setTaskStatus(tx, a, id, 'done', b.outcome));
    });
    r.post('/tasks/:id/reopen', async (req) => {
      const a = actorOf(req); const { id } = req.params as { id: string };
      return withTenant(a.tenantId, (tx) => setTaskStatus(tx, a, id, 'open'));
    });

    r.get('/properties', async (req) => {
      const a = actorOf(req);
      const p = parse(z.object({ status: z.string().optional(), q: z.string().optional() }), req.query);
      return withTenant(a.tenantId, async (tx) => (await tx.query(
        `SELECT * FROM properties WHERE tenant_id = $1 AND deleted_at IS NULL AND ($2::text IS NULL OR status = $2)
           AND ($3::text IS NULL OR project_name ILIKE '%'||$3||'%' OR community ILIKE '%'||$3||'%' OR reference ILIKE '%'||$3||'%')
         ORDER BY project_name LIMIT 1000`, [a.tenantId, p.status ?? null, p.q ?? null])).rows);
    });
    r.post('/properties', async (req, reply) => {
      const a = actorOf(req); const b = parse(propertySchema, req.body);
      reply.code(201);
      return withTenant(a.tenantId, (tx) => upsertProperty(tx, a, { ...b, brochureUrl: b.brochureUrl || undefined }));
    });
    r.put('/properties/:id', async (req) => {
      const a = actorOf(req); const { id } = req.params as { id: string }; const b = parse(propertySchema, req.body);
      return withTenant(a.tenantId, (tx) => upsertProperty(tx, a, { ...b, brochureUrl:b.brochureUrl||undefined},id,ifMatch(req)));
    });
    r.get('/properties/:id/matching-leads', async (req) => {
      const a = actorOf(req); const { id } = req.params as { id: string };
      return withTenant(a.tenantId, (tx) => matchingLeads(tx, a, id));
    });

    r.get('/inbox', async (req) => {
      const a = actorOf(req); const p = parse(z.object({ filter: z.enum(['all', 'mine', 'waiting']).default('all') }), req.query);
      return withTenant(a.tenantId, (tx) => inbox(tx, a, p.filter));
    });

    r.get('/analytics/overview', async (req) => {
      const a = actorOf(req);
      const p = parse(z.object({ from: z.string().datetime({ offset: true }).optional(), to: z.string().datetime({ offset: true }).optional(), agentIds: z.string().optional() }), req.query);
      return withTenant(a.tenantId, (tx) => overview(tx, a, { ...p, agentIds: p.agentIds?.split(',').filter(Boolean) }));
    });

    // allocation rules (admin)
    r.get('/allocation-rules', async (req) => {
      const a = actorOf(req);
      return withTenant(a.tenantId, async (tx) => (await tx.query(`SELECT * FROM allocation_rules WHERE tenant_id = $1 ORDER BY priority`, [a.tenantId])).rows);
    });
    r.post('/allocation-rules', { preHandler: requireRole('owner', 'admin') }, async (req, reply) => {
      const a = actorOf(req); const b = parse(ruleSchema, req.body);
      reply.code(201);
      return withTenant(a.tenantId, async (tx) => (await tx.query(
        `INSERT INTO allocation_rules (tenant_id, name, priority, is_enabled, definition) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [a.tenantId, b.name, b.priority, b.isEnabled, b.definition])).rows[0]);
    });
    r.put('/allocation-rules/:id', { preHandler: requireRole('owner', 'admin') }, async (req) => {
      const a = actorOf(req); const { id } = req.params as { id: string }; const b = parse(ruleSchema, req.body);
      return withTenant(a.tenantId, async (tx) => {
        const row = (await tx.query(`UPDATE allocation_rules SET name=$3, priority=$4, is_enabled=$5, definition=$6, updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
          [a.tenantId, id, b.name, b.priority, b.isEnabled, b.definition])).rows[0];
        if (!row) throw notFound('Rule');
        return row;
      });
    });
    r.delete('/allocation-rules/:id', { preHandler: requireRole('owner', 'admin') }, async (req, reply) => {
      const a = actorOf(req); const { id } = req.params as { id: string };
      await withTenant(a.tenantId, (tx) => tx.query(`DELETE FROM allocation_rules WHERE tenant_id = $1 AND id = $2`, [a.tenantId, id]));
      reply.code(204).send();
    });
    /** Dry-run: which agent would get this lead right now? No writes. */
    r.post('/allocation-rules/simulate', async (req) => {
      const a = actorOf(req); const facts = parse(z.record(z.unknown()), req.body);
      return withTenant(a.tenantId, async (tx) => {
        const rules = (await tx.query<Rule>(`SELECT id, name, priority, definition, rr_cursor FROM allocation_rules WHERE tenant_id = $1 AND is_enabled`, [a.tenantId])).rows;
        const agents = (await tx.query(`SELECT u.id, u.team_id, u.is_active, u.is_clocked_in, u.capacity_max_open_leads,
            (SELECT count(*)::int FROM leads l WHERE l.owner_id = u.id AND l.deleted_at IS NULL AND l.stage NOT IN ('lost','booked')) AS open_leads
            FROM users u WHERE u.tenant_id = $1 AND u.role IN ('agent','manager') AND u.is_active`, [a.tenantId])).rows;
        return allocate(facts, rules, agents);
      });
    });

    r.post('/settings/intake-secret/reveal',{preHandler:requireRole('owner','admin')},async(req)=>{
      const a=actorOf(req);return withTenant(a.tenantId,async tx=>{const t=(await tx.query('SELECT intake_secret FROM tenants WHERE id=$1',[a.tenantId])).rows[0];await import('../lib/events.js').then(m=>m.audit(tx,a.tenantId,a.id,'tenant',a.tenantId,'intake_secret.reveal'));return {secret:t.intake_secret};});
    });
    r.post('/settings/intake-secret/rotate',{preHandler:requireRole('owner','admin')},async(req)=>{
      const a=actorOf(req);parse(z.object({confirm:z.literal('rotate')}),req.body);
      return withTenant(a.tenantId,async tx=>{const t=(await tx.query(`UPDATE tenants SET intake_secret=encode(gen_random_bytes(24),'hex') WHERE id=$1 RETURNING intake_secret`,[a.tenantId])).rows[0];await import('../lib/events.js').then(m=>m.audit(tx,a.tenantId,a.id,'tenant',a.tenantId,'intake_secret.rotate'));return {secret:t.intake_secret};});
    });
    r.patch('/settings', { preHandler: requireRole('owner', 'admin') }, async (req) => {
      const a = actorOf(req);
      const b = parse(z.object({
        sla_minutes: z.number().int().positive().optional(), sla_auto_reassign: z.boolean().optional(),
        wa_phone_number_id: z.string().optional(), intake_field_maps: z.record(z.record(z.array(z.string()))).optional(),
      }), req.body);
      const { rows: [t] } = await q(`UPDATE tenants SET settings = settings || $2 WHERE id = $1 RETURNING settings`, [a.tenantId, b]);
      return t.settings;
    });
    r.get('/settings', { preHandler: requireRole('owner', 'admin') }, async (req) => {
      const a = actorOf(req);
      const { rows: [t] } = await q(`SELECT name,slug,default_currency,timezone,settings,true AS intake_secret_configured FROM tenants WHERE id = $1`, [a.tenantId]);
      return t;
    });
  });

  // ------------------------------------------------ public: intake webhooks (HMAC signed per tenant)
  app.post('/intake/:adapter', async (req, reply) => {
    const { adapter } = req.params as { adapter: AdapterName };
    if (!['generic', 'portal', 'ivr', 'web_form'].includes(adapter)) throw notFound('Intake adapter');
    const slug=String(req.headers['x-leadvolt-workspace']??'');
    const source=parse(z.string().regex(/^[a-z0-9_]{1,50}$/).optional(),(req.query as {source?:string}).source);
    if(adapter==='portal'&&!source)throw badRequest('Specify the portal source for this intake endpoint.');
    const t=(await q('SELECT id,intake_secret,settings FROM tenants WHERE slug=$1',[slug])).rows[0];
    const signature=req.headers['x-leadvolt-signature'] as string|undefined;
    const timestamp=req.headers['x-leadvolt-timestamp'] as string|undefined;
    const verified=t&&(timestamp?verifyIntakeV2(t.intake_secret,req.rawBody??'',source??adapter,timestamp,signature):config.allowLegacyIntake&&verifyIntake(t.intake_secret,req.rawBody??'',signature));
    if(!verified) throw new HttpError(401,'invalid_signature','Unknown workspace, stale delivery timestamp or bad signature.');
    let input:ReturnType<typeof normalizeIntake>|undefined;
    try {
      parse(z.record(z.unknown()),req.body);
      input=normalizeIntake(adapter,source,req.body,t.settings?.intake_field_maps?.[source??adapter]);
      const eventId=input.providerEventId??(req.headers['x-leadvolt-event-id'] as string|undefined);
      if(config.production&&adapter==='portal'&&!input.providerEventId) throw badRequest('Include a stable provider event ID inside the signed portal payload.');
      const hash=crypto.createHash('sha256').update(req.rawBody??'').digest('hex');
      const r=await withTenant(t.id,tx=>receiveEnquiry(tx,{id:null,tenantId:t.id,role:'system'},input!,adapter,eventId,hash));
      reply.code(r.created?201:200);
      return {leadId:r.lead.id,serialNo:r.lead.serialNo,created:r.created,reenquiry:r.reenquiry,ownerId:r.lead.ownerId,duplicate:r.duplicate,routingStatus:r.lead.routingStatus};
    } catch(error) {
      await withTenant(t.id,tx=>tx.query(`INSERT INTO integration_events(tenant_id,source,adapter,status,listing_ref,error_code,summary) VALUES($1,$2,$3,'rejected',$4,$5,$6)`,[t.id,source??adapter,adapter,input?.listingRef??null,error instanceof HttpError?error.code:'processing_error',error instanceof HttpError?error.message.slice(0,300):'Enquiry processing failed; sender should retry after correction']));
      throw error;
    }
  });

  // ------------------------------------------------ public: WhatsApp Cloud API webhook
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const qy = req.query as Record<string, string>;
    if (qy['hub.mode'] === 'subscribe' && config.whatsapp.verifyToken && qy['hub.verify_token'] === config.whatsapp.verifyToken) return reply.type('text/plain').send(qy['hub.challenge']);
    reply.code(403).send();
  });
  app.post('/webhooks/whatsapp', async (req, reply) => {
    if (!verifyMetaSignature(req.rawBody ?? '', req.headers['x-hub-signature-256'] as string | undefined, config.whatsapp.appSecret)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }
    const body = req.body as any;
    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};
        const pnid = v.metadata?.phone_number_id;
        const t = (await q(`SELECT id FROM tenants WHERE settings->>'wa_phone_number_id'=$1 AND ($2::text='' OR slug=$2)`,[pnid,config.whatsapp.workspace])).rows[0];
        if (!t) continue;
        const names = Object.fromEntries((v.contacts ?? []).map((c: any) => [c.wa_id, c.profile?.name]));
        for (const m of v.messages ?? []) {
          const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? `[${m.type} message]`;
          await withTenant(t.id, async (tx) => {
            await recordInbound(tx, { id: null, tenantId: t.id, role: 'system' }, { phone: '+' + m.from, name: names[m.from], body: text, providerId:m.id });
          });
        }
        for (const s of v.statuses ?? []) {
          await withTenant(t.id, tx=>recordMessageReceipt(tx,t.id,s));
        }
      }
    }
    return { ok: true };
  });

  // ------------------------------------------------ public: shared property page
  app.get('/s/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const r = await withSystem((tx) => openShareLink(tx, code));
    if (!r) return reply.code(404).type('text/html').send('<p>This link has expired. Ask your agent for a new one.</p>');
    const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const cards = r.properties.map((p: any) => `<article><h2>${esc(p.project_name)}</h2><p>${esc(p.community)} · ${p.beds === 0 ? 'Studio' : esc(p.beds) + ' BR'} ${esc(p.property_type)}${p.area_sqft ? ' · ' + Number(p.area_sqft).toLocaleString('en-AE') + ' sq ft' : ''}</p>
      <p class="price">${esc(p.currency)} ${Number(p.price).toLocaleString('en-AE')}</p>${p.offering_type === 'off_plan' && p.handover ? `<p>Off-plan · handover ${esc(p.handover)}</p>` : ''}
      ${p.brochure_url&&/^https?:\/\//i.test(p.brochure_url)?`<a href="${esc(p.brochure_url)}" rel="noopener">Download brochure</a>` : ''}</article>`).join('');
    reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.tenantName)}</title>
      <style>body{font-family:system-ui,sans-serif;margin:0;padding:20px 16px;background:#f3f5f8;color:#121826}main{max-width:640px;margin:auto}article{background:#fff;border:1px solid #dce1e8;border-radius:10px;padding:16px;margin:12px 0}h1{font-size:20px}h2{font-size:17px;margin:0 0 6px}.price{font-weight:700;font-size:18px}a{color:#1d5fd0}</style></head>
      <body><main><h1>Properties selected for you by ${esc(r.tenantName)}</h1>${cards}</main></body></html>`);
  });
}
