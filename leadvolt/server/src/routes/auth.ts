import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { q, withTenant } from '../lib/db.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { actorOf, authenticate, parse, requireRole } from '../lib/http.js';
import { emit, audit } from '../lib/events.js';

export async function authRoutes(app: FastifyInstance) {
  const sign = (u: { id: string; tenant_id: string; role: string; full_name: string }) =>
    app.jwt.sign({ sub: u.id, tid: u.tenant_id, role: u.role, name: u.full_name }, { expiresIn: '12h' });

  app.post('/auth/register', async (req) => {
    const b = parse(z.object({
      company: z.string().min(2), slug: z.string().regex(/^[a-z0-9-]{3,40}$/), name: z.string().min(2),
      email: z.string().email(), password: z.string().min(10),
    }), req.body);
    const exists = await q(`SELECT 1 FROM tenants WHERE slug = $1`, [b.slug]);
    if (exists.rowCount) throw badRequest('That workspace name is taken. Choose another.');
    const { rows: [t] } = await q(`INSERT INTO tenants (name, slug, settings) VALUES ($1, $2, '{"sla_minutes":15}') RETURNING id`, [b.company, b.slug]);
    const hash = await bcrypt.hash(b.password, 12);
    const user = await withTenant(t.id, async (tx) => (await tx.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role) VALUES ($1,$2,$3,$4,'owner') RETURNING id, tenant_id, role, full_name`,
      [t.id, b.email, hash, b.name])).rows[0]);
    return { token: sign(user), tenant: { id: t.id, slug: b.slug } };
  });

  app.post('/auth/login', async (req) => {
    const b = parse(z.object({ workspace: z.string(), email: z.string().email(), password: z.string() }), req.body);
    const t = (await q(`SELECT id FROM tenants WHERE slug = $1`, [b.workspace])).rows[0];
    const fail = new HttpError(401, 'invalid_credentials', 'The workspace, email or password is not correct.');
    if (!t) throw fail;
    const u = await withTenant(t.id, async (tx) => (await tx.query(
      `SELECT id, tenant_id, role, full_name, password_hash, is_active FROM users WHERE tenant_id = $1 AND email = $2`, [t.id, b.email])).rows[0]);
    if (!u || !u.is_active || !(await bcrypt.compare(b.password, u.password_hash))) throw fail;
    return { token: sign(u) };
  });

  app.get('/me', { preHandler: authenticate }, async (req) => {
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
      `SELECT u.id, u.email, u.full_name, u.role, u.team_id, u.is_active, u.is_clocked_in, u.capacity_max_open_leads,
              (SELECT count(*)::int FROM leads l WHERE l.owner_id = u.id AND l.deleted_at IS NULL AND l.stage NOT IN ('lost','booked')) AS open_leads
         FROM users u WHERE u.tenant_id = $1 ORDER BY u.full_name`, [a.tenantId])).rows);
  });

  const userBody = z.object({
    email: z.string().email(), name: z.string().min(2), password: z.string().min(10).optional(),
    role: z.enum(['admin', 'manager', 'agent', 'listing_manager', 'viewer']).default('agent'),
    teamId: z.string().uuid().nullable().optional(), capacity: z.number().int().min(0).nullable().optional(), isActive: z.boolean().optional(),
  });
  app.post('/users', { preHandler: [authenticate, requireRole('owner', 'admin')] }, async (req) => {
    const a = actorOf(req); const b = parse(userBody, req.body);
    if (!b.password) throw badRequest('Set an initial password of at least 10 characters.');
    const hash = await bcrypt.hash(b.password, 12);
    return withTenant(a.tenantId, async (tx) => {
      const { rows: [u] } = await tx.query(
        `INSERT INTO users (tenant_id, email, password_hash, full_name, role, team_id, capacity_max_open_leads) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (tenant_id, email) DO NOTHING RETURNING id, email, full_name, role`, [a.tenantId, b.email, hash, b.name, b.role, b.teamId ?? null, b.capacity ?? null]);
      if (!u) throw badRequest('Someone in this workspace already uses that email.');
      await audit(tx, a.tenantId, a.id, 'user', u.id, 'create');
      return u;
    });
  });
  app.patch('/users/:id', { preHandler: [authenticate, requireRole('owner', 'admin')] }, async (req) => {
    const a = actorOf(req); const { id } = req.params as { id: string }; const b = parse(userBody.partial(), req.body);
    return withTenant(a.tenantId, async (tx) => {
      const { rows: [u] } = await tx.query(
        `UPDATE users SET full_name = COALESCE($3, full_name), role = COALESCE($4, role), team_id = COALESCE($5, team_id),
            capacity_max_open_leads = CASE WHEN $6::boolean THEN $7 ELSE capacity_max_open_leads END,
            is_active = COALESCE($8, is_active), is_clocked_in = CASE WHEN $8 = false THEN false ELSE is_clocked_in END, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 RETURNING id, email, full_name, role, is_active`,
        [a.tenantId, id, b.name ?? null, b.role ?? null, b.teamId ?? null, b.capacity !== undefined, b.capacity ?? null, b.isActive ?? null]);
      if (b.isActive === false) {
        // deactivation returns open leads to the unassigned pool
        await tx.query(`UPDATE leads SET owner_id = NULL, updated_at = now(), version = version + 1 WHERE tenant_id = $1 AND owner_id = $2 AND stage NOT IN ('lost','booked')`, [a.tenantId, id]);
      }
      await audit(tx, a.tenantId, a.id, 'user', id, 'update', b);
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
