import { requirementsSchema } from '../lib/validation.js';
import { z } from 'zod';
import type { Tx } from '../lib/db.js';
import { badRequest,conflict } from '../lib/errors.js';
import { createOrReenquire,loadLead,leadDto,type Actor } from './leads.js';
import crypto from 'node:crypto';
import type { LeadInput } from './leads.js';
import type { Requirements } from '../domain/scoring.js';

/**
 * Intake adapters turn an inbound payload into a LeadInput. Portal payload formats depend on your contract
 * with each portal; `portal` uses a configurable field map (tenant settings.intake_field_maps[adapter]) with
 * common defaults, so map your contracted payload once rather than changing code.
 */
export type AdapterName = 'generic' | 'portal' | 'ivr' | 'web_form';

const DEFAULT_PORTAL_MAP = {
  name: ['name', 'full_name', 'contact.name', 'lead.name'],
  phone: ['phone', 'mobile', 'contact.phone', 'lead.phone', 'phone_number'],
  email: ['email', 'contact.email', 'lead.email'],
  listingRef: ['listing_ref', 'property_reference', 'reference', 'listing.reference', 'property.reference'],
  message: ['message', 'comment', 'enquiry', 'lead.message'],
  channel: ['channel', 'type', 'enquiry_type'],
  eventId: ['event_id','enquiry_id','inquiry_id','lead.id'],
};
export type FieldMap = Partial<Record<keyof typeof DEFAULT_PORTAL_MAP, string[]>>;

function pick(obj: any, paths: string[]): any {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

export function normalizeIntake(adapter: AdapterName, sourceParam: string | undefined, body: any, fieldMap?: FieldMap): LeadInput {
  switch (adapter) {
    case 'generic':
      return {
        name: String(body.name ?? '').trim(), phone: body.phone ?? null, email: body.email ?? null,
        source: body.source ?? sourceParam ?? 'other', subSource: body.subSource ?? null, listingRef: body.listingRef ?? null,
        campaign: body.campaign ?? {}, requirements: body.requirements ?? {}, note: body.note ?? null, rawPayload: body,providerEventId:body.providerEventId,
      };
    case 'portal': {
      const map = { ...DEFAULT_PORTAL_MAP, ...(fieldMap ?? {}) };
      const name = pick(body, map.name); const phone = pick(body, map.phone);
      const channel = pick(body, map.channel);
      return {
        name: String(name ?? phone ?? 'Portal lead'), phone: phone ?? null, email: pick(body, map.email) ?? null,
        source: sourceParam ?? 'other', subSource: channel ? `${sourceParam} ${channel}` : sourceParam ?? null,
        routingMode:'listing',providerEventId:pick(body,map.eventId)?String(pick(body,map.eventId)):undefined,listingRef: pick(body, map.listingRef) ?? null, note: pick(body, map.message) ?? null, rawPayload: body,
      };
    }
    case 'ivr': {
      // Typical cloud-telephony callback: caller number, dialled number (DID) mapped to a source, call status.
      const caller = body.caller ?? body.from ?? body.caller_number;
      const did = body.did ?? body.to ?? body.called_number;
      return {
        name: body.caller_name || `Caller ${caller}`, phone: caller, source: body.source ?? sourceParam ?? 'ivr',
        subSource: did ? `Line ${did}` : 'IVR', note: body.status ? `Call ${body.status}${body.duration ? ' · ' + body.duration + 's' : ''}` : null, rawPayload: body,
      };
    }
    case 'web_form': {
      const req: Requirements = {
        purpose: body.purpose, offering: body.offering ?? 'any', types: body.property_type ? [body.property_type] : [],
        beds: body.beds !== undefined && body.beds !== '' ? Number(body.beds) : null,
        budgetMin: body.budget_min ? Number(body.budget_min) : null, budgetMax: body.budget_max ? Number(body.budget_max) : null,
        communities: body.community ? [body.community] : [],
      };
      return {
        name: String(body.name ?? '').trim(), phone: body.phone, email: body.email, source: 'website', subSource: body.form ?? 'Website form',
        campaign: { utm_source: body.utm_source, utm_medium: body.utm_medium, utm_campaign: body.utm_campaign, utm_term: body.utm_term, utm_content: body.utm_content },
        requirements: req, note: body.message ?? null, rawPayload: body,
      };
    }
  }
}

export function signIntake(secret: string, raw: string | Buffer) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}
export function verifyIntake(secret: string, raw: string | Buffer, header?: string) {
  if (!header) return false;
  const exp = signIntake(secret, raw);
  return exp.length === header.length && crypto.timingSafeEqual(Buffer.from(exp), Buffer.from(header));
}


export function signIntakeV2(secret:string,raw:string|Buffer,source:string,timestamp:string) {
  return 'sha256='+crypto.createHmac('sha256',secret).update(timestamp+'.'+source+'.').update(raw).digest('hex');
}
export function verifyIntakeV2(secret:string,raw:string|Buffer,source:string,timestamp:string|undefined,header:string|undefined,now=Date.now()) {
  if(!timestamp||!/^\d{10}$/.test(timestamp)||Math.abs(now-Number(timestamp)*1000)>300000||!header) return false;
  const expected=signIntakeV2(secret,raw,source,timestamp);
  return header.length===expected.length&&crypto.timingSafeEqual(Buffer.from(header),Buffer.from(expected));
}
const normalizedSchema=z.object({
  requirements:requirementsSchema.optional(),
  name:z.string().trim().min(1).max(200),phone:z.string().max(80).nullable().optional(),email:z.string().trim().email().max(254).nullable().optional(),
  source:z.string().regex(/^[a-z0-9_]{1,50}$/),subSource:z.string().max(200).nullable().optional(),listingRef:z.string().max(200).nullable().optional(),
  note:z.string().max(10000).nullable().optional(),providerEventId:z.string().max(200).optional(),
});
export async function receiveEnquiry(tx:Tx,actor:Actor,input:LeadInput,adapter:string,eventId:string|undefined,payloadHash:string) {
  const valid=normalizedSchema.safeParse(input);
  if(!valid.success) throw badRequest('The enquiry payload is missing valid contact or listing fields.',valid.error.flatten());
  if(eventId && (eventId.length>200||!eventId.trim())) throw badRequest('The provider event ID is invalid.');
  if(eventId) {
    const inserted=await tx.query(`INSERT INTO intake_receipts(tenant_id,source,provider_event_id,payload_hash) VALUES($1,$2,$3,$4)
      ON CONFLICT(tenant_id,source,provider_event_id) DO NOTHING RETURNING id`,[actor.tenantId,input.source,eventId,payloadHash]);
    if(!inserted.rowCount) {
      const receipt=(await tx.query('SELECT * FROM intake_receipts WHERE tenant_id=$1 AND source=$2 AND provider_event_id=$3',[actor.tenantId,input.source,eventId])).rows[0];
      if(receipt.payload_hash!==payloadHash) throw conflict('This event ID was already received with different content.');
      if(!receipt.lead_id) throw conflict('This delivery is being processed. Retry it shortly.');
      await tx.query(`INSERT INTO integration_events(tenant_id,source,adapter,status,provider_event_id,listing_ref,lead_id,summary) VALUES($1,$2,$3,'duplicate',$4,$5,$6,'Provider retry acknowledged; no duplicate enquiry created')`,[actor.tenantId,input.source,adapter,eventId,input.listingRef??null,receipt.lead_id]);
      return {lead:leadDto(await loadLead(tx,actor.tenantId,receipt.lead_id)),created:false,reenquiry:false,duplicate:true};
    }
  }
  const result=await createOrReenquire(tx,actor,{...input,providerEventId:eventId,ownerId:'auto'});
  if(eventId) await tx.query('UPDATE intake_receipts SET lead_id=$4,result=$5 WHERE tenant_id=$1 AND source=$2 AND provider_event_id=$3',[actor.tenantId,input.source,eventId,result.lead.id,{created:result.created,reenquiry:result.reenquiry}]);
  await tx.query(`INSERT INTO integration_events(tenant_id,source,adapter,status,provider_event_id,listing_ref,lead_id,summary) VALUES($1,$2,$3,'received',$4,$5,$6,$7)`,[actor.tenantId,input.source,adapter,eventId??null,input.listingRef??null,result.lead.id,result.lead.ownerId?'Delivered to responsible CRM agent':'Accepted into administrator ownership review']);
  return {...result,duplicate:false};
}
