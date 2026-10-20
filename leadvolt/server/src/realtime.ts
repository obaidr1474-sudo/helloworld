import type { FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import pg from 'pg';
import { config } from './lib/config.js';
import { withSystem, withTenant } from './lib/db.js';
import { MANAGER_ROLES } from './services/leads.js';

interface SocketUser { sub: string; tid: string; role: string }

/**
 * Rooms:
 *   u:{userId}           personal notifications
 *   mgr:{tenantId}       managers/admins see every tenant event
 *   pool:{tenantId}      agents: unassigned-lead events (claimable pool)
 *   lead:{leadId}        anyone viewing that lead (joined on demand after an access check)
 */
export function attachRealtime(app: FastifyInstance) {
  const io = new Server(app.server, { cors: { origin: config.corsOrigin, credentials: true }, path: '/ws' });

  io.use((socket, next) => {
    try {
      const token = (socket.handshake.auth?.token as string) || String(socket.handshake.query?.token ?? '');
      socket.data.user = app.jwt.verify<SocketUser>(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const u = socket.data.user as SocketUser;
    socket.join(`u:${u.sub}`);
    socket.join(MANAGER_ROLES.has(u.role) || u.role === 'viewer' ? `mgr:${u.tid}` : `pool:${u.tid}`);

    socket.on('lead:subscribe', async (leadId: string, ack?: (r: { ok: boolean }) => void) => {
      try {
        const ok = await withTenant(u.tid, async (tx) => {
          const { rows } = await tx.query(`SELECT owner_id FROM leads WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [u.tid, leadId]);
          if (!rows[0]) return false;
          return MANAGER_ROLES.has(u.role) || u.role === 'viewer' || rows[0].owner_id === null || rows[0].owner_id === u.sub;
        });
        if (ok) {
          socket.join(`lead:${leadId}`);
          socket.to(`lead:${leadId}`).emit('presence', { leadId, userId: u.sub, state: 'viewing' });
        }
        ack?.({ ok });
      } catch {
        ack?.({ ok: false });
      }
    });
    socket.on('lead:unsubscribe', (leadId: string) => socket.leave(`lead:${leadId}`));
    socket.on('lead:typing', (leadId: string) => {
      if (socket.rooms.has(`lead:${leadId}`)) socket.to(`lead:${leadId}`).emit('presence', { leadId, userId: u.sub, state: 'editing' });
    });
  });

  const dispatcher = startOutboxDispatcher(io, app.log);
  app.addHook('onClose', async () => {
    await dispatcher.stop();
    io.close();
  });
  return io;
}

/** LISTEN/NOTIFY wakes the dispatcher; a 2s poll covers missed notifications. Rows are claimed with SKIP LOCKED. */
export function startOutboxDispatcher(io: Server, log: FastifyInstance['log']) {
  let stopped = false;
  let running = false;
  let again = false;
  const listener = new pg.Client({ connectionString: config.databaseUrl });

  async function drain() {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const events = await withSystem(async (tx) => {
          const { rows } = await tx.query(
            `SELECT id, tenant_id, type, payload, occurred_at FROM outbox_events WHERE dispatched_at IS NULL ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED`);
          if (rows.length) await tx.query(`UPDATE outbox_events SET dispatched_at = now() WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
          return rows;
        });
        for (const e of events) route(io, e);
        if (events.length === 200) again = true;
      } while (again && !stopped);
    } catch (err) {
      log.error({ err }, 'outbox dispatch failed');
    } finally {
      running = false;
    }
  }

  listener.connect().then(() => listener.query('LISTEN leadvolt_outbox')).catch((err) => log.error({ err }, 'outbox LISTEN failed'));
  listener.on('notification', () => void drain());
  listener.on('error', (err) => log.error({ err }, 'outbox listener error'));
  const timer = setInterval(() => void drain(), 2000);
  void drain();

  return {
    drain,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await listener.end().catch(() => {});
    },
  };
}

function route(io: Server, e: { id: number; tenant_id: string; type: string; payload: any; occurred_at: Date }) {
  const frame = { seq: Number(e.id), type: e.type, data: e.payload, ts: e.occurred_at };
  const rooms = new Set<string>([`mgr:${e.tenant_id}`]);
  const p = e.payload ?? {};
  if (p.owner_id) rooms.add(`u:${p.owner_id}`);
  for (const id of p.user_ids ?? []) if (id) rooms.add(`u:${id}`);
  if (p.lead_id) rooms.add(`lead:${p.lead_id}`);
  if (p.owner_id === null || (p.lead_id && p.owner_id === undefined && e.type.startsWith('lead.'))) rooms.add(`pool:${e.tenant_id}`);
  io.to([...rooms]).emit('event', frame);
}
