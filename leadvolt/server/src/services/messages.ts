import crypto from 'node:crypto';
import type { Tx } from '../lib/db.js';
import { config } from '../lib/config.js';
import { emit } from '../lib/events.js';
import { badRequest } from '../lib/errors.js';
import { waDigits } from '../lib/phone.js';
import { addInteraction, assertCanRead, assertCanWrite, createOrReenquire, loadLead, type Actor } from './leads.js';

const WINDOW_MS = 24 * 3600 * 1000;

export async function listMessages(tx: Tx, actor: Actor, leadId: string) {
  assertCanRead(actor, await loadLead(tx, actor.tenantId, leadId));
  const { rows } = await tx.query(
    `SELECT m.*, u.full_name AS sent_by_name FROM messages m LEFT JOIN users u ON u.id = m.sent_by
      WHERE m.tenant_id = $1 AND m.lead_id = $2 ORDER BY m.created_at ASC LIMIT 500`, [actor.tenantId, leadId]);
  return rows;
}

export async function inbox(tx: Tx, actor: Actor, filter: 'all' | 'mine' | 'waiting') {
  const vals: unknown[] = [actor.tenantId]; const where: string[] = [];
  if (!['owner', 'admin', 'manager', 'viewer'].includes(actor.role) || filter === 'mine') { vals.push(actor.id); where.push(`l.owner_id = $${vals.length}`); }
  if (filter === 'waiting') where.push(`last.direction = 'inbound'`);
  const { rows } = await tx.query(
    `SELECT l.id AS lead_id, l.full_name, l.owner_id, l.stage, last.body, last.direction, last.created_at
       FROM leads l
       JOIN LATERAL (SELECT body, direction, created_at FROM messages m WHERE m.tenant_id = l.tenant_id AND m.lead_id = l.id
                      ORDER BY created_at DESC LIMIT 1) last ON true
      WHERE l.tenant_id = $1 AND l.deleted_at IS NULL ${where.length ? 'AND ' + where.join(' AND ') : ''}
      ORDER BY last.created_at DESC LIMIT 200`, vals);
  return rows;
}

/**
 * Send (when WhatsApp Cloud API is configured and the 24h service window is open, or a template is used)
 * or just log an outbound message that the agent sent from their own WhatsApp.
 */
export async function sendOrLog(tx: Tx, actor: Actor, leadId: string, body: string, opts: { mode: 'send' | 'log'; template?: { name: string; lang: string; vars: string[] } }) {
  const lead = await loadLead(tx, actor.tenantId, leadId, true);
  assertCanWrite(actor, lead);
  if (!body.trim() && !opts.template) throw badRequest('Type a message first.');
  let status = 'logged'; let providerId: string | null = null;
  if (opts.mode === 'send') {
    if (!config.whatsapp.accessToken || !config.whatsapp.phoneNumberId) throw badRequest('WhatsApp sending is not configured. Log the message instead, or set WA_ACCESS_TOKEN and WA_PHONE_NUMBER_ID.');
    const windowOpen = lead.last_inbound_at && Date.now() - new Date(lead.last_inbound_at).getTime() < WINDOW_MS;
    if (!windowOpen && !opts.template) throw badRequest('The 24-hour reply window is closed. Send an approved template to restart the conversation.');
    const payload = opts.template
      ? { messaging_product: 'whatsapp', to: waDigits(lead.phone_e164), type: 'template',
          template: { name: opts.template.name, language: { code: opts.template.lang }, components: [{ type: 'body', parameters: opts.template.vars.map((t) => ({ type: 'text', text: t })) }] } }
      : { messaging_product: 'whatsapp', to: waDigits(lead.phone_e164), type: 'text', text: { body } };
    const res = await fetch(`https://graph.facebook.com/v20.0/${config.whatsapp.phoneNumberId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.whatsapp.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) throw badRequest(`WhatsApp rejected the message: ${json?.error?.message ?? res.statusText}`);
    providerId = json?.messages?.[0]?.id ?? null; status = 'sent';
  }
  const { rows: [msg] } = await tx.query(
    `INSERT INTO messages (tenant_id, lead_id, direction, body, template_name, provider_id, status, sent_by)
     VALUES ($1,$2,'outbound',$3,$4,$5,$6,$7) RETURNING *`, [actor.tenantId, leadId, body, opts.template?.name ?? null, providerId, status, actor.id]);
  await addInteraction(tx, actor.tenantId, leadId, actor.id, 'whatsapp', `WhatsApp ${status === 'sent' ? 'sent' : 'logged'}: ${body}`, { direction: 'outbound', externalId: providerId ?? undefined });
  await tx.query(
    `UPDATE leads SET last_contacted_at = now(), first_response_at = COALESCE(first_response_at, now()),
            stage = CASE WHEN stage = 'new' THEN 'contacted' ELSE stage END,
            sub_status = CASE WHEN stage = 'new' THEN 'WhatsApp sent' ELSE sub_status END,
            updated_at = now(), version = version + 1 WHERE tenant_id = $1 AND id = $2`, [actor.tenantId, leadId]);
  await emit(tx, actor.tenantId, 'message.sent', { lead_id: leadId, owner_id: lead.owner_id, message_id: msg.id });
  return msg;
}

/** Inbound message (from the WhatsApp webhook or logged by an agent). Unknown numbers become new leads. */
export async function recordInbound(tx: Tx, actor: Actor, input: { phone: string; name?: string; body: string; providerId?: string; leadId?: string }) {
  let leadId = input.leadId;
  if (!leadId) {
    const r = await createOrReenquire(tx, actor, { name: input.name || input.phone, phone: input.phone, source: 'whatsapp', subSource: 'Inbound WhatsApp', ownerId: 'auto', note: input.body });
    leadId = r.lead.id;
    if (r.created) {
      // the creation already logged the first message as the note; still store the message row
    }
  }
  if (input.providerId) {
    const dup = (await tx.query(`SELECT 1 FROM messages WHERE tenant_id = $1 AND provider_id = $2`, [actor.tenantId, input.providerId])).rows[0];
    if (dup) return null; // webhook retries are idempotent
  }
  const { rows: [msg] } = await tx.query(
    `INSERT INTO messages (tenant_id, lead_id, direction, body, provider_id, status) VALUES ($1,$2,'inbound',$3,$4,'received') RETURNING *`,
    [actor.tenantId, leadId, input.body, input.providerId ?? null]);
  await addInteraction(tx, actor.tenantId, leadId, null, 'whatsapp', `WhatsApp from lead: ${input.body}`, { direction: 'inbound' });
  await tx.query(`UPDATE leads SET last_inbound_at = now(), inbound_count = inbound_count + 1, updated_at = now(), version = version + 1
                   WHERE tenant_id = $1 AND id = $2`, [actor.tenantId, leadId]);
  const lead = await loadLead(tx, actor.tenantId, leadId);
  await emit(tx, actor.tenantId, 'message.received', { lead_id: leadId, owner_id: lead.owner_id, message_id: msg.id, preview: input.body.slice(0, 120) });
  return msg;
}

export function verifyMetaSignature(rawBody: Buffer | string, header: string | undefined, appSecret: string) {
  if (!appSecret) return false;
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const got = header.slice(7);
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
