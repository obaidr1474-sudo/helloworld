import type { FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import pg from 'pg';
import { config } from './lib/config.js';
import { withSystem, withTenant } from './lib/db.js';
import { validateIdentity,type JwtUser } from './lib/http.js';
import type { Tx } from './lib/db.js';
import { MANAGER_ROLES } from './services/leads.js';

type SocketUser=JwtUser;

/**
 * Rooms:
 *   u:{userId}           personal notifications
 *   mgr:{tenantId}       managers/admins see every tenant event
 *   pool:{tenantId}      agents: unassigned-lead events (claimable pool)
 *   lead:{leadId}        anyone viewing that lead (joined on demand after an access check)
 */
export function attachRealtime(app: FastifyInstance) {
  const io = new Server(app.server, { cors: { origin: config.corsOrigin, credentials: true }, path: '/ws' });

  io.use(async (socket, next) => {
    try {
      const token=(socket.handshake.auth?.token as string)||app.parseCookie(socket.handshake.headers.cookie??'').lv_session;
      socket.data.user=app.jwt.verify<SocketUser>(token??'');
      if(!(await validateIdentity(socket.data.user))) return next(new Error('Session revoked'));
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const u = socket.data.user as SocketUser;
    socket.join(`u:${u.sub}`);
    if(u.sid)socket.join(`s:${u.sid}`);
    if(MANAGER_ROLES.has(u.role)||u.role==='viewer') socket.join(`mgr:${u.tid}`);
    const expiry=setTimeout(()=>socket.disconnect(true),Math.min(2147483647,Math.max(0,(u.exp??0)*1000-Date.now())));
    expiry.unref();socket.on('disconnect',()=>clearTimeout(expiry));

    socket.on('lead:subscribe', async (leadId: string, ack?: (r: { ok: boolean }) => void) => {
      try {
        if(typeof leadId!=='string'||!/^[-a-f0-9]{36}$/i.test(leadId)||!(await validateIdentity(u))) return ack?.({ok:false});
        const ok = await withTenant(u.tid, async (tx) => {
          const { rows } = await tx.query(`SELECT owner_id FROM leads WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`, [u.tid, leadId]);
          if (!rows[0]) return false;
          return MANAGER_ROLES.has(u.role) || u.role === 'viewer' || rows[0].owner_id === u.sub;
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
          for(const event of rows) await route(io,tx,event);
          if(rows.length) await tx.query(`UPDATE outbox_events SET dispatched_at=now() WHERE id=ANY($1)`,[rows.map(r=>r.id)]);
          return rows;
        });

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

async function route(io:Server,tx:Tx,e:{id:number;tenant_id:string;type:string;payload:any;occurred_at:Date}) {
  const p=e.payload??{};
  if(e.type==='auth.session_revoked'){io.in(`s:${p.session_id}`).disconnectSockets(true);return;}
  if(e.type==='auth.revoked'){
    for(const id of p.user_ids??[]) io.in(`u:${id}`).disconnectSockets(true);
    return;
  }
  const rooms=new Set<string>([`mgr:${e.tenant_id}`]);
  let payload=p;
  if(p.lead_id){
    const lead=(await tx.query('SELECT owner_id,deleted_at FROM leads WHERE tenant_id=$1 AND id=$2',[e.tenant_id,p.lead_id])).rows[0];
    // Membership in a previously subscribed lead room is not an authorization grant.
    if(lead&&!lead.deleted_at&&lead.owner_id) rooms.add(`u:${lead.owner_id}`);
    payload={...p,owner_id:lead?.owner_id??null};
    if(e.type==='lead.assigned') for(const id of p.user_ids??[]) if(id&&id!==lead?.owner_id){
      io.to(`u:${id}`).emit('event',{seq:Number(e.id),type:'lead.access_revoked',data:{lead_id:p.lead_id},ts:e.occurred_at});
      io.in(`u:${id}`).socketsLeave(`lead:${p.lead_id}`);
    }
  }else{
    if(p.owner_id)rooms.add(`u:${p.owner_id}`);
    for(const id of p.user_ids??[])if(id)rooms.add(`u:${id}`);
  }
  io.to([...rooms]).emit('event',{seq:Number(e.id),type:e.type,data:payload,ts:e.occurred_at});
}
