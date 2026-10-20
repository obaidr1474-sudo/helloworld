import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { config } from '../lib/config.js';
import { assignInternal, loadLead } from '../services/leads.js';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { q, withTenant } from '../lib/db.js';
import { badRequest, forbidden, notFound, HttpError } from '../lib/errors.js';
import { actorOf, authenticate, parse, requireRole, validateOrigin } from '../lib/http.js';
import { emit, audit } from '../lib/events.js';

const DUMMY_HASH=bcrypt.hashSync('unknown-account-timing-padding',12);

export async function authRoutes(app: FastifyInstance) {
  const sign = (u: { id: string; tenant_id: string; role: string; full_name: string; auth_version:number },reply:any) => {
    const token=app.jwt.sign({sub:u.id,tid:u.tenant_id,role:u.role,name:u.full_name,ver:u.auth_version},{expiresIn:`${config.sessionHours}h`});
    reply.setCookie('lv_session',token,{httpOnly:true,secure:config.production,sameSite:'lax',path:'/',maxAge:config.sessionHours*3600});
    return token;
  };
  const passwordSchema=z.string().min(12).refine(v=>Buffer.byteLength(v,'utf8')<=72,'Password must be at most 72 UTF-8 bytes.');
  app.post('/auth/register',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
    validateOrigin(req);
    if(!config.allowRegistration) throw forbidden('Workspace registration is disabled. Contact your administrator.');
    const b=parse(z.object({company:z.string().trim().min(2).max(160),slug:z.string().regex(/^[a-z0-9-]{3,40}$/),name:z.string().trim().min(2).max(160),email:z.string().trim().email().max(254),password:passwordSchema}),req.body);
    const tenantId=crypto.randomUUID(),hash=await bcrypt.hash(b.password,12);
    const user=await withTenant(tenantId,async tx=>{
      await tx.query(`INSERT INTO tenants(id,name,slug,settings) VALUES($1,$2,$3,'{"sla_minutes":15}')`,[tenantId,b.company,b.slug]);
      const u=(await tx.query(`INSERT INTO users(tenant_id,email,password_hash,full_name,role) VALUES($1,$2,$3,$4,'owner') RETURNING id,tenant_id,role,full_name,auth_version`,[tenantId,b.email.toLowerCase(),hash,b.name])).rows[0];
      await audit(tx,tenantId,u.id,'tenant',tenantId,'register');return u;
    });
    return {token:sign(user,reply),tenant:{id:tenantId,slug:b.slug}};
  });

  app.post('/auth/login',{config:{rateLimit:{max:10,timeWindow:'1 minute'}}},async(req,reply)=>{
    validateOrigin(req);
    const b = parse(z.object({ workspace:z.string().trim().max(40),email:z.string().trim().email().max(254),password:z.string().max(256) }), req.body);
    const t = (await q(`SELECT id FROM tenants WHERE slug = $1`, [b.workspace])).rows[0];
    const fail = new HttpError(401, 'invalid_credentials', 'The workspace, email or password is not correct.');
    if(!t){await bcrypt.compare(b.password,DUMMY_HASH);throw fail;}
    const u = await withTenant(t.id, async (tx) => (await tx.query(
      `SELECT id, tenant_id, role, full_name, password_hash, is_active,auth_version FROM users WHERE tenant_id = $1 AND email = $2`, [t.id, b.email])).rows[0]);
    const valid=await bcrypt.compare(b.password,u?.password_hash??DUMMY_HASH);
    if(!u||!u.is_active||!valid) throw fail;
    return { token: sign(u,reply) };
  });

  app.post('/auth/logout',{preHandler:authenticate},async(req,reply)=>{
    const a=actorOf(req);
    await withTenant(a.tenantId,async tx=>{
      await tx.query('UPDATE users SET auth_version=auth_version+1 WHERE tenant_id=$1 AND id=$2',[a.tenantId,a.id]);
      await emit(tx,a.tenantId,'auth.revoked',{user_ids:[a.id!]});
      await audit(tx,a.tenantId,a.id,'user',a.id,'logout');
    });
    reply.clearCookie('lv_session',{path:'/',httpOnly:true,secure:config.production,sameSite:'lax'});
    return {ok:true};
  });

  app.get('/me' , { preHandler: authenticate }, async (req) => {
    const a = actorOf(req);
    return withTenant(a.tenantId, async (tx) => {
      const { rows: [u] } = await tx.query(`SELECT u.id, u.email, u.full_name, u.role, u.team_id, u.is_clocked_in, u.preferences, t.name AS tenant_name, t.slug,
          t.default_currency, t.timezone FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.tenant_id = $1 AND u.id = $2`, [a.tenantId, a.id]);
      return u;
    });
  });

  // ---- users / team
  app.get('/users', { preHandler: authenticate }, async (req) => {
    const a = actorOf(req);
    return withTenant(a.tenantId, async (tx) => (await tx.query(
      `SELECT u.id, u.email, u.full_name, u.role, u.team_id, u.is_active, u.is_clocked_in,u.broker_registration_number,u.capacity_max_open_leads,
              (SELECT count(*)::int FROM leads l WHERE l.owner_id = u.id AND l.deleted_at IS NULL AND l.stage NOT IN ('lost','booked')) AS open_leads
         FROM users u WHERE u.tenant_id = $1 ORDER BY u.full_name`, [a.tenantId])).rows);
  });

  const userBody = z.object({
    email:z.string().trim().email().max(254),name:z.string().trim().min(2).max(160),password:passwordSchema.optional(),brokerRegistrationNumber:z.string().trim().max(100).nullable().optional(),
    role: z.enum(['admin', 'manager', 'agent', 'listing_manager', 'viewer']).default('agent'),
    teamId: z.string().uuid().nullable().optional(), capacity: z.number().int().min(0).nullable().optional(), isActive: z.boolean().optional(),
  });
  app.post('/users', { preHandler: [authenticate, requireRole('owner', 'admin')] }, async (req) => {
    const a = actorOf(req); const b = parse(userBody, req.body);
    if (!b.password) throw badRequest('Set an initial password of at least 12 characters.');
    const hash = await bcrypt.hash(b.password, 12);
    return withTenant(a.tenantId, async (tx) => {
      const { rows: [u] } = await tx.query(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role, team_id, capacity_max_open_leads,broker_registration_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (tenant_id, email) DO NOTHING RETURNING id, email, full_name, role`, [a.tenantId, b.email, hash, b.name, b.role, b.teamId ?? null, b.capacity ?? null,b.brokerRegistrationNumber??null]);
      if (!u) throw badRequest('Someone in this workspace already uses that email.');
      await audit(tx, a.tenantId, a.id, 'user', u.id, 'create');
      return u;
    });
  });
  app.patch('/users/:id',{preHandler:[authenticate,requireRole('owner','admin')]},async(req)=>{
    const a=actorOf(req),{id}=req.params as {id:string},b=parse(userBody.partial(),req.body);
    const passwordHash=b.password?await bcrypt.hash(b.password,12):null;
    return withTenant(a.tenantId,async tx=>{
      const old=(await tx.query('SELECT * FROM users WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[a.tenantId,id])).rows[0];
      if(!old) throw notFound('Teammate');
      if(old.role==='owner' && (b.role!==undefined||b.isActive===false)) throw forbidden('The workspace owner cannot be demoted or deactivated here.');
      if(id===a.id && b.isActive===false) throw forbidden('You cannot deactivate your own account.');
      const revoked=!!passwordHash||b.isActive===false||(b.role!==undefined&&b.role!==old.role);
      const u=(await tx.query(`UPDATE users SET full_name=COALESCE($3,full_name),role=COALESCE($4,role),email=COALESCE($5,email),
        team_id=CASE WHEN $6 THEN $7 ELSE team_id END,capacity_max_open_leads=CASE WHEN $8 THEN $9 ELSE capacity_max_open_leads END,
        is_active=COALESCE($10,is_active),is_clocked_in=CASE WHEN $10=false THEN false ELSE is_clocked_in END,
        password_hash=COALESCE($11,password_hash),broker_registration_number=CASE WHEN $12 THEN $13 ELSE broker_registration_number END,
        auth_version=auth_version+CASE WHEN $14 THEN 1 ELSE 0 END,updated_at=now() WHERE tenant_id=$1 AND id=$2
        RETURNING id,email,full_name,role,is_active,broker_registration_number`,[a.tenantId,id,b.name??null,b.role??null,b.email?.toLowerCase()??null,b.teamId!==undefined,b.teamId??null,b.capacity!==undefined,b.capacity??null,b.isActive??null,passwordHash,b.brokerRegistrationNumber!==undefined,b.brokerRegistrationNumber??null,revoked])).rows[0];
      if(b.isActive===false || (b.role!==undefined&&!['owner','admin','manager','agent'].includes(b.role))) {
        const leads=(await tx.query(`SELECT id FROM leads WHERE tenant_id=$1 AND owner_id=$2 AND deleted_at IS NULL AND stage NOT IN ('lost','booked') ORDER BY id FOR UPDATE`,[a.tenantId,id])).rows;
        for(const l of leads){const lead=await loadLead(tx,a.tenantId,l.id);await assignInternal(tx,a,lead,null,'deactivation');await tx.query(`UPDATE leads SET routing_status=CASE WHEN routing_mode='listing' THEN 'agent_unavailable' ELSE 'manual_review' END,routing_note='Previous agent account is no longer eligible; administrator review is required' WHERE tenant_id=$1 AND id=$2`,[a.tenantId,l.id]);}
      }
      if(revoked) await emit(tx,a.tenantId,'auth.revoked',{user_ids:[id]});
      const {password,...safe}=b;
      await audit(tx,a.tenantId,a.id,'user',id,'update',{...safe,passwordChanged:!!password});
      return u;
    });
  });

  // ---- attendance (drives "only clocked-in" allocation)
  app.post('/attendance/clock-in', { preHandler: authenticate }, async (req) => {
    const a = actorOf(req);
    return withTenant(a.tenantId, async (tx) => {
      await tx.query(`UPDATE users SET is_clocked_in = true WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
      const { rows: [r] } = await tx.query(`INSERT INTO attendance (tenant_id, user_id, meta) VALUES ($1,$2,$3) RETURNING *`, [a.tenantId, a.id, req.body ?? {}]);
      await emit(tx, a.tenantId, 'attendance.changed', { user_ids: [a.id as string], clocked_in: true });
      return r;
    });
  });
  app.post('/attendance/clock-out', { preHandler: authenticate }, async (req) => {
    const a = actorOf(req);
    return withTenant(a.tenantId, async (tx) => {
      await tx.query(`UPDATE users SET is_clocked_in = false WHERE tenant_id = $1 AND id = $2`, [a.tenantId, a.id]);
      await tx.query(`UPDATE attendance SET clock_out_at = now() WHERE tenant_id = $1 AND user_id = $2 AND clock_out_at IS NULL`, [a.tenantId, a.id]);
      await emit(tx, a.tenantId, 'attendance.changed', { user_ids: [a.id as string], clocked_in: false });
      return { ok: true };
    });
  });
}
