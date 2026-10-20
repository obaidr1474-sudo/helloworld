/**
 * End-to-end API tests against a real PostgreSQL.
 * Set TEST_DATABASE_URL (runtime role, e.g. leadvolt_app) and TEST_MIGRATION_URL (owner role) to run.
 * The schema in that database is dropped and recreated.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { io as ioc } from 'socket.io-client';

const RUN = !!process.env.TEST_DATABASE_URL && !!process.env.TEST_MIGRATION_URL;
const d = RUN ? describe : describe.skip;

d('LeadVolt API', () => {
  let app: any; let base = ''; let signIntake: any; let runSlaSweep: any; let pool: any;
  const tok: Record<string, string> = {}; const ids: Record<string, string> = {};
  const call = async (method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method, url: '/api/v1' + url, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, payload: body ? JSON.stringify(body) : undefined });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  };
  const inHour = (h = 1) => new Date(Date.now() + h * 3600_000).toISOString();

  beforeAll(async () => {
    const workerUrl=new URL(process.env.TEST_MIGRATION_URL!);workerUrl.username='leadvolt_worker';workerUrl.password='leadvolt_worker';process.env.WORKER_DATABASE_URL=process.env.TEST_WORKER_DATABASE_URL??workerUrl.toString();
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.MIGRATION_DATABASE_URL = process.env.TEST_MIGRATION_URL;
    process.env.CORS_ORIGIN = 'http://localhost';
    const owner = new pg.Client({ connectionString: process.env.TEST_MIGRATION_URL });
    await owner.connect();
    await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await owner.query(`GRANT USAGE ON SCHEMA public TO leadvolt_app`);
    await owner.end();
    const { migrate } = await import('../src/migrate.js');
    await migrate(process.env.TEST_MIGRATION_URL);
    ({ signIntake } = await import('../src/services/intake.js'));
    ({ runSlaSweep } = await import('../src/workers.js'));
    ({ pool } = await import('../src/lib/db.js'));
    const { buildApp } = await import('../src/app.js');
    const { attachRealtime } = await import('../src/realtime.js');
    app = await buildApp({ logger: false });
    attachRealtime(app);
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${app.server.address().port}`;
  });
  afterAll(async () => { await app?.close(); await pool?.end(); });

  it('registers a workspace and team', async () => {
    const r = await call('POST', '/auth/register', undefined, { company: 'Test Realty', slug: 'test-realty', name: 'Olivia Owner', email: 'owner@t.test', password: 'password-1234' });
    expect(r.status).toBe(200);
    tok.owner = r.body.token;
    for (const [k, name] of [['a', 'Sara Khan'], ['b', 'Omar Haddad']]) {
      const u = await call('POST', '/users', tok.owner, { email: `${k}@t.test`, name, password: 'password-1234', role: 'agent' });
      expect(u.status).toBe(200); ids[k] = u.body.id;
      tok[k] = (await call('POST', '/auth/login', undefined, { workspace: 'test-realty', email: `${k}@t.test`, password: 'password-1234' })).body.token;
    }
    expect((await call('POST', '/auth/login', undefined, { workspace: 'test-realty', email: 'a@t.test', password: 'wrong-password' })).status).toBe(401);
  });

  it('adds inventory', async () => {
    const r = await call('POST', '/properties', tok.owner, { reference: 'LV-1', projectName: 'Hills Vista', community: 'Dubai Hills Estate', offeringType: 'off_plan', propertyType: 'Apartment', beds: 2, price: 2_100_000, portalRefs: { bayut: 'BY-99' } });
    expect(r.status).toBe(201); ids.prop = r.body.id;
    expect((await call('POST', '/properties', tok.a, { projectName: 'X', community: 'Y', offeringType: 'ready', propertyType: 'Apartment', beds: 1, price: 1 })).status).toBe(403);
  });

  it('creates leads with round-robin allocation and catches duplicates as re-enquiries', async () => {
    const mk = (name: string, phone: string) => call('POST', '/leads', tok.owner, { name, phone, source: 'bayut', subSource: 'Bayut WhatsApp',
      requirements: { purpose: 'buy', offering: 'off_plan', types: ['Apartment'], beds: 2, budgetMin: 1_800_000, budgetMax: 2_300_000, communities: ['Dubai Hills Estate'] } });
    const r1 = await mk('Lead One', '050 111 1111'); const r2 = await mk('Lead Two', '0502222222');
    expect(r1.status).toBe(201); expect(r2.status).toBe(201);
    expect(new Set([r1.body.lead.ownerId, r2.body.lead.ownerId])).toEqual(new Set([ids.a, ids.b]));
    expect(r1.body.lead.phone).toBe('+971501111111');
    ids.l1 = r1.body.lead.id; ids.l2 = r2.body.lead.id;
    ids.l1owner = r1.body.lead.ownerId;
    const dup = await mk('Lead One Again', '+971501111111');
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ created: false, reenquiry: true });
    expect(dup.body.lead.id).toBe(ids.l1);
    expect(dup.body.lead.reenquiryCount).toBe(1);
  });

  it('enforces agent visibility', async () => {
    const other = ids.l1owner === ids.a ? 'b' : 'a';
    expect((await call('GET', `/leads/${ids.l1}`, tok[other])).status).toBe(403);
    const mine = ids.l1owner === ids.a ? 'a' : 'b';
    expect((await call('GET', `/leads/${ids.l1}`, tok[mine])).status).toBe(200);
    const list = await call('GET', '/leads?queue=active', tok[other]);
    expect(list.body.items.map((l: any) => l.id)).not.toContain(ids.l1);
  });

  it('validates and applies dispositions with optimistic locking', async () => {
    const mine = ids.l1owner === ids.a ? 'a' : 'b';
    const bad = await call('POST', `/leads/${ids.l1}/disposition`, tok[mine], { disposition: 'site_visit' });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/next action/);
    const cur = await call('GET', `/leads/${ids.l1}`, tok[mine]);
    const ok = await call('POST', `/leads/${ids.l1}/disposition`, tok[mine], { disposition: 'site_visit', subStatus: 'Scheduled', nextActionAt: inHour(24), propertyId: ids.prop, note: 'Saturday 11am' }, { 'if-match': `"${cur.body.version}"` });
    expect(ok.status).toBe(200);
    expect(ok.body.lead.stage).toBe('site_visit');
    expect(ok.body.task.type).toBe('site_visit');
    expect(ok.body.lead.firstResponseAt).toBeTruthy();
    const stale = await call('POST', `/leads/${ids.l1}/disposition`, tok[mine], { disposition: 'callback', nextActionAt: inHour(2) }, { 'if-match': `"${cur.body.version}"` });
    expect(stale.status).toBe(412);
    for (const qn of ['overdue', 'today', 'done']) expect((await call('GET', `/tasks?queue=${qn}`, tok[mine])).status).toBe(200);
    const tasks = await call('GET', '/tasks?queue=upcoming', tok[mine]);
    expect(tasks.body.filter((t: any) => t.lead_id === ids.l1 && t.status === 'open')).toHaveLength(1);
    const tl = await call('GET', `/leads/${ids.l1}/timeline`, tok[mine]);
    expect(tl.body[0].type).toBe('status_change');
  });

  it('matches properties and creates tracked share links', async () => {
    const mine = ids.l1owner === ids.a ? 'a' : 'b';
    const m = await call('GET', `/leads/${ids.l1}/matches`, tok[mine]);
    expect(m.body[0].property.id).toBe(ids.prop);
    expect(m.body[0].score).toBeGreaterThan(80);
    const s = await call('POST', `/leads/${ids.l1}/share`, tok[mine], { propertyIds: [ids.prop] });
    expect(s.status).toBe(201);
    expect(s.body.message).toContain('Hills Vista');
    const page = await app.inject({ method: 'GET', url: `/api/v1/s/${s.body.code}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Hills Vista');
    const tl = await call('GET', `/leads/${ids.l1}/timeline`, tok[mine]);
    expect(tl.body.some((i: any) => i.type === 'brochure_opened')).toBe(true);
  });

  it('accepts HMAC-signed portal intake and rejects bad signatures', async () => {
    const settings = await call('POST','/settings/intake-secret/reveal',tok.owner,{});
    const body = JSON.stringify({ contact: { name: 'Portal Person', phone: '0503333333' }, listing: { reference: 'BY-99' }, channel: 'whatsapp' });
    const ok = await app.inject({ method: 'POST', url: '/api/v1/intake/portal?source=bayut', payload: body,
      headers: { 'content-type': 'application/json', 'x-leadvolt-workspace': 'test-realty', 'x-leadvolt-signature': signIntake(settings.body.secret, body) } });
    expect(ok.statusCode).toBe(201);
    const lead = await call('GET', `/leads/${JSON.parse(ok.body).leadId}`, tok.owner);
    expect(lead.body.propertyId).toBe(ids.prop);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/intake/portal?source=bayut', payload: body,
      headers: { 'content-type': 'application/json', 'x-leadvolt-workspace': 'test-realty', 'x-leadvolt-signature': 'sha256=deadbeef' } });
    expect(bad.statusCode).toBe(401);
  });

  it('isolates tenants at the database level (RLS)', async () => {
    const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    expect((await c.query('SELECT count(*)::int AS n FROM leads')).rows[0].n).toBe(0);
    await c.query(`SELECT set_config('app.tenant_id', gen_random_uuid()::text, false)`);
    expect((await c.query('SELECT count(*)::int AS n FROM leads')).rows[0].n).toBe(0);
    await c.query("SELECT set_config('app.system','on',false)");
    expect((await c.query('SELECT count(*)::int AS n FROM leads')).rows[0].n).toBe(0);
    await c.end();
  });

  it('streams domain events over websockets', async () => {
    const mine = ids.l1owner === ids.a ? 'a' : 'b';
    const sock = ioc(base, { path: '/ws', auth: { token: tok[mine] }, transports: ['websocket'] });
    await new Promise<void>((res, rej) => { sock.on('connect', () => res()); sock.on('connect_error', rej); });
    const got = new Promise<any>((res) => sock.on('event', (e: any) => { if (e.type === 'interaction.created' && e.data.lead_id === ids.l1) res(e); }));
    await new Promise((res) => sock.emit('lead:subscribe', ids.l1, res));
    await call('POST', `/leads/${ids.l1}/notes`, tok[mine], { body: 'Client prefers a high floor' });
    const e = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no event')), 5000))]);
    expect((e as any).data.summary).toContain('high floor');
    sock.close();
  });

  it('flags first-response SLA breaches and reports analytics', async () => {
    await pool.query(`SELECT 1`);
    const owner = new pg.Client({ connectionString: process.env.TEST_MIGRATION_URL });
    await owner.connect();
    await owner.query(`UPDATE leads SET sla_due_at = now() - interval '1 minute' WHERE id = $1`, [ids.l2]);
    await owner.end();
    const r = await runSlaSweep();
    expect(r.breaches).toBe(1);
    const a = await call('GET', '/analytics/overview', tok.owner);
    expect(a.body.totals.leads).toBe(3);
    expect(a.body.slaBreaches.map((x: any) => x.id)).toContain(ids.l2);
    const counts = await call('GET', '/leads/counts', tok.owner);
    expect(counts.body.sla).toBe(1);
  });

  it('keeps lead counts consistent with the selected filters and agent permissions', async () => {
    const none = await call('GET', '/leads/counts?source=nonexistent', tok.owner);
    expect(none.status).toBe(200);
    expect(none.body.all).toBe(0);
    expect(none.body.active).toBe(0);
    const stage = await call('GET', '/leads/counts?stage=site_visit', tok.owner);
    expect(stage.body.all).toBe(1);
    expect(stage.body.new).toBe(0);
    const mine = await call('GET', '/leads?queue=all&scope=mine', tok.a);
    const counts = await call('GET', '/leads/counts?scope=mine', tok.a);
    expect(counts.body.all).toBe(mine.body.items.length);
    const reenquired = await call('GET', '/leads/counts?scope=reenquired', tok.owner);
    expect(reenquired.body.all).toBe(1);
  });

  it('paginates every matching lead without duplicates, including unscheduled leads', async () => {
    for (const sort of ['updated', 'next_action', 'score']) {
      const seen: string[] = []; let cursor = '';
      do {
        const r = await call('GET', `/leads?queue=all&limit=1&sort=${sort}${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, tok.owner);
        expect(r.status).toBe(200);
        expect(r.body.items).toHaveLength(1);
        seen.push(r.body.items[0].id);
        cursor = r.body.nextCursor;
        expect(seen.length).toBeLessThanOrEqual(3);
      } while (cursor);
      expect(seen).toHaveLength(3);
      expect(new Set(seen).size).toBe(3);
    }
    expect((await call('GET', '/leads?cursor=invalid', tok.owner)).status).toBe(400);
  });

  it('applies creation date boundaries to lead lists, counts and dashboard drill-throughs', async () => {
    const future = encodeURIComponent(inHour(24));
    const list = await call('GET', `/leads?queue=all&createdFrom=${future}`, tok.owner);
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(0);
    expect((await call('GET', `/leads/counts?createdFrom=${future}`, tok.owner)).body.all).toBe(0);
    const before = await call('GET', '/leads?queue=all&createdTo=2000-01-01T00%3A00%3A00.000Z', tok.owner);
    expect(before.body.items).toHaveLength(0);
    expect((await call('GET', '/leads?createdFrom=yesterday', tok.owner)).status).toBe(400);
  });

  it('scopes dashboard SLA alerts and performance to the selected agent and period', async () => {
    const mine = ids.l1owner === ids.a ? 'a' : 'b';
    const own = await call('GET', '/analytics/overview', tok[mine]);
    expect(own.status).toBe(200);
    expect(own.body.slaBreaches.map((l: any) => l.id)).not.toContain(ids.l2);
    expect(own.body.agents.map((a: any) => a.id)).toEqual([ids.l1owner]);
    const scoped = await call('GET', `/analytics/overview?agentIds=${ids.l1owner}`, tok.owner);
    expect(scoped.body.slaBreaches.map((l: any) => l.id)).not.toContain(ids.l2);
    expect(scoped.body.agents.map((a: any) => a.id)).toEqual([ids.l1owner]);
    expect(scoped.body.totals.site_visit).toBe(1);
    expect(scoped.body.totals.scheduled).toBe(1);
    const future = await call('GET', `/analytics/overview?from=${encodeURIComponent(inHour(24))}`, tok.owner);
    expect(future.body.totals.leads).toBe(0);
    expect(future.body.slaBreaches).toHaveLength(0);
    expect(future.body.agents.every((a: any) => a.leads === 0 && a.calls === 0)).toBe(true);
  });

  it('bulk assigns selected leads and enforces manager-only reassignment', async () => {
    const denied = await call('POST', '/leads/bulk-assign', tok.b, { leadIds: [ids.l1, ids.l2], userId: ids.a });
    expect(denied.status).toBe(403);
    const assigned = await call('POST', '/leads/bulk-assign', tok.owner, { leadIds: [ids.l1, ids.l2], userId: ids.a });
    expect(assigned.status).toBe(200);
    expect(assigned.body.updated).toBe(2);
    for (const id of [ids.l1, ids.l2]) expect((await call('GET', `/leads/${id}`, tok.a)).body.ownerId).toBe(ids.a);
  });

  it('does not interpret digits embedded in a contact name as a phone search', async () => {
    const r = await call('GET', '/leads?queue=all&q=Buyer%20111', tok.owner);
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(0);
    const phone = await call('GET', '/leads?queue=all&q=%2B971%20501%20111%20111', tok.owner);
    expect(phone.status).toBe(200);
    expect(phone.body.items.map((l: any) => l.id)).toEqual([ids.l1]);
  });
});
