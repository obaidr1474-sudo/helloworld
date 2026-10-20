import { describe, expect, it } from 'vitest';
import { validateDisposition, canTransition } from '../src/domain/pipeline.js';
import { scoreLead, temperatureOf } from '../src/domain/scoring.js';
import { matchProperty, rankMatches } from '../src/domain/matching.js';
import { allocate, type Agent, type Rule } from '../src/domain/allocation.js';
import { normalizePhone } from '../src/lib/phone.js';
import { normalizeIntake, signIntake, verifyIntake } from '../src/services/intake.js';

const future = () => new Date(Date.now() + 3600_000).toISOString();

describe('pipeline', () => {
  it('requires a next action for callback', () => {
    expect(validateDisposition('new', { disposition: 'callback' })).toMatch(/next action/);
    expect(validateDisposition('new', { disposition: 'callback', nextActionAt: future() })).toBeNull();
  });
  it('rejects past next actions, missing deal values and lost reasons', () => {
    expect(validateDisposition('new', { disposition: 'meeting', nextActionAt: '2020-01-01T00:00:00Z' })).toMatch(/past/);
    expect(validateDisposition('eoi', { disposition: 'booked', subStatus: 'Approved' })).toMatch(/deal value/);
    expect(validateDisposition('contacted', { disposition: 'not_interested' })).toMatch(/reason/);
  });
  it('blocks invalid transitions', () => {
    expect(canTransition('booked', 'meeting')).toBe(false);
    expect(validateDisposition('booked', { disposition: 'callback', nextActionAt: future() })).toMatch(/cannot move/);
    expect(canTransition('lost', 'new')).toBe(true);
  });
});

describe('scoring', () => {
  const base = { source: 'bayut', stage: 'new' as const, requirements: {}, inboundCount: 0, connectedCalls: 0, reenquiryCount: 0, lastActivityAt: new Date(), inventoryFit: 0 };
  it('rewards complete requirements, engagement and progress', () => {
    const cold = scoreLead(base);
    const hot = scoreLead({ ...base, stage: 'site_visit', inboundCount: 2, connectedCalls: 1, inventoryFit: 3,
      requirements: { purpose: 'buy', types: ['Apartment'], beds: 2, budgetMax: 2e6, communities: ['JVC'] } });
    expect(cold).toBeLessThan(40);
    expect(hot).toBeGreaterThanOrEqual(70);
    expect(temperatureOf(hot)).toBe('hot');
  });
  it('decays stale leads and caps lost leads', () => {
    const stale = scoreLead({ ...base, lastActivityAt: new Date(Date.now() - 10 * 86400_000) });
    expect(stale).toBe(scoreLead(base) - 10);
    expect(scoreLead({ ...base, stage: 'lost', inboundCount: 4 })).toBeLessThanOrEqual(15);
  });
});

describe('matching', () => {
  const p = (o: Partial<any>) => ({ id: 'x', project_name: 'P', community: 'Dubai Hills Estate', property_type: 'Apartment', offering_type: 'ready' as const, beds: 2, price: 2_000_000, status: 'available', ...o });
  it('applies hard filters', () => {
    const req = { budgetMax: 2_100_000, types: ['Apartment'], beds: 2 };
    expect(matchProperty(req, p({ price: 2_400_000 }))).toBeNull();
    expect(matchProperty(req, p({ property_type: 'Villa' }))).toBeNull();
    expect(matchProperty(req, p({ beds: 4 }))).toBeNull();
    expect(matchProperty(req, p({ status: 'sold' }))).toBeNull();
  });
  it('ranks preferred community first and explains why', () => {
    const req = { budgetMin: 1_800_000, budgetMax: 2_200_000, beds: 2, communities: ['Dubai Hills Estate'] };
    const r = rankMatches(req, [p({ id: 'a', community: 'JVC' }), p({ id: 'b' })]);
    expect(r[0].property.id).toBe('b');
    expect(r[0].reasons).toContain('Dubai Hills Estate');
  });
});

describe('allocation', () => {
  const agents: Agent[] = [
    { id: 'a1', team_id: 't1', is_active: true, is_clocked_in: true, capacity_max_open_leads: null, open_leads: 5 },
    { id: 'a2', team_id: 't1', is_active: true, is_clocked_in: false, capacity_max_open_leads: null, open_leads: 1 },
    { id: 'a3', team_id: 't2', is_active: true, is_clocked_in: true, capacity_max_open_leads: 2, open_leads: 2 },
  ];
  const rule = (def: any, id = 'r', priority = 1, rr = 0): Rule => ({ id, name: id, priority, rr_cursor: rr, definition: def });
  it('round robins over eligible agents and skips capacity', () => {
    const r = rule({ conditions: {}, strategy: 'round_robin', pool: { onlyClockedIn: true } });
    expect(allocate({}, [r], agents).agentId).toBe('a1');   // a2 off shift, a3 at capacity
    const r2 = rule({ conditions: {}, strategy: 'round_robin', pool: {} }, 'r', 1, 1);
    expect(allocate({}, [r2], agents).agentId).toBe('a2');
  });
  it('honours conditions, priority and least-loaded', () => {
    const offplan = rule({ conditions: { all: [{ field: 'requirements.offering', op: 'eq', value: 'off_plan' }] }, strategy: 'least_loaded', pool: { teamId: 't1' } }, 'op', 1);
    const fallback = rule({ conditions: {}, strategy: 'manual_pool', pool: {} }, 'fb', 99);
    expect(allocate({ requirements: { offering: 'off_plan' } }, [fallback, offplan], agents)).toMatchObject({ agentId: 'a2', ruleId: 'op' });
    expect(allocate({ requirements: { offering: 'ready' } }, [fallback, offplan], agents)).toMatchObject({ agentId: null, ruleId: 'fb' });
  });
  it('returns re-enquiries to the sticky owner', () => {
    const r = rule({ conditions: {}, strategy: 'sticky_owner', pool: {} });
    expect(allocate({}, [r], agents, 'a3').agentId).toBe('a3');
  });
});

describe('phone & intake', () => {
  it('normalises UAE formats', () => {
    expect(normalizePhone('050 123 4567')).toBe('+971501234567');
    expect(normalizePhone('00971501234567')).toBe('+971501234567');
    expect(normalizePhone('501234567')).toBe('+971501234567');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('abc')).toBeNull();
  });
  it('maps portal payloads and verifies signatures', () => {
    const lead = normalizeIntake('portal', 'bayut', { contact: { name: 'A B', phone: '0501234567' }, listing: { reference: 'LV-1' }, channel: 'whatsapp' });
    expect(lead).toMatchObject({ name: 'A B', phone: '0501234567', source: 'bayut', listingRef: 'LV-1', subSource: 'bayut whatsapp' });
    const body = JSON.stringify({ a: 1 });
    expect(verifyIntake('s3cret', body, signIntake('s3cret', body))).toBe(true);
    expect(verifyIntake('s3cret', body, signIntake('other', body))).toBe(false);
  });
});
