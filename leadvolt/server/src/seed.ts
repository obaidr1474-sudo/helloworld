/**
 * Seeds a clearly-labelled DEMO workspace (slug "demo") for local development.
 * Every person and listing below is fictional sample data.
 */
import bcrypt from 'bcryptjs';
import { q, withTenant, pool } from './lib/db.js';
import { createOrReenquire, applyDisposition } from './services/leads.js';
import { upsertProperty } from './services/properties.js';

const PASSWORD = process.env.SEED_PASSWORD ?? 'demo-password-123';

async function main() {
  const existing = (await q(`SELECT id FROM tenants WHERE slug = 'demo'`)).rows[0];
  if (existing) { console.log('demo workspace already exists'); return; }
  const { rows: [t] } = await q(`INSERT INTO tenants (name, slug, settings) VALUES ('Demo Realty (sample)', 'demo', '{"sla_minutes":15}') RETURNING id`);
  const hash = await bcrypt.hash(PASSWORD, 10);
  await withTenant(t.id, async (tx) => {
    const mk = async (email: string, name: string, role: string) => (await tx.query(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, role, is_clocked_in) VALUES ($1,$2,$3,$4,$5,true) RETURNING id`, [t.id, email, hash, name, role])).rows[0].id;
    const owner = await mk('owner@demo.test', 'Demo Owner', 'owner');
    await mk('sara@demo.test', 'Sara Khan', 'agent');
    await mk('omar@demo.test', 'Omar Haddad', 'agent');
    await mk('priya@demo.test', 'Priya Nair', 'agent');
    const actor = { id: owner, tenantId: t.id, role: 'owner' };
    const P: [string, string, string, 'ready' | 'off_plan', number, number, number, string?][] = [
      ['Hills Vista Residences', 'Dubai Hills Estate', 'Apartment', 'off_plan', 2, 1180, 2150000, 'Q2 2027'],
      ['Park Ridge Tower B', 'Dubai Hills Estate', 'Apartment', 'ready', 1, 780, 1350000],
      ['Marina Crest', 'Dubai Marina', 'Apartment', 'ready', 2, 1290, 2600000],
      ['Bayfront Lofts', 'Business Bay', 'Apartment', 'off_plan', 1, 720, 1180000, 'Q4 2026'],
      ['Circle Gardens', 'Jumeirah Village Circle', 'Apartment', 'ready', 0, 420, 610000],
      ['Ranches Grove', 'Arabian Ranches 3', 'Townhouse', 'off_plan', 3, 2240, 3100000, 'Q1 2028'],
    ];
    let i = 0;
    for (const p of P) await upsertProperty(tx, actor, { reference: `LV-${2001 + i++}`, projectName: p[0], community: p[1], propertyType: p[2], offeringType: p[3], beds: p[4], areaSqft: p[5], price: p[6], handover: p[7], notes: 'Sample listing' });
    const leads = [
      ['Ahmed Al Mansouri', '+971500000001', 'bayut', 'Bayut WhatsApp', { purpose: 'buy', offering: 'off_plan', types: ['Apartment'], beds: 2, budgetMin: 1800000, budgetMax: 2500000, communities: ['Dubai Hills Estate'] }],
      ['Fatima Rahman', '+971500000002', 'property_finder', 'PF listing enquiry', { purpose: 'buy', offering: 'ready', types: ['Apartment'], beds: 1, budgetMax: 1400000, communities: ['Dubai Hills Estate'] }],
      ['James Whitfield', '+971500000003', 'facebook', 'Lead form', { purpose: 'invest', types: ['Apartment'], beds: 1, budgetMax: 1300000, communities: ['Business Bay'] }],
      ['Elena Petrova', '+971500000004', 'ivr', 'Line 04', { purpose: 'buy', types: ['Townhouse'], beds: 3, budgetMax: 3300000, communities: ['Arabian Ranches 3'] }],
    ] as const;
    for (const [name, phone, source, sub, req] of leads) await createOrReenquire(tx, actor, { name, phone, source, subSource: sub, requirements: req as any, ownerId: 'auto', note: 'Sample enquiry' });
    const first = (await tx.query(`SELECT id FROM leads WHERE tenant_id = $1 ORDER BY serial_no LIMIT 1`, [t.id])).rows[0];
    await applyDisposition(tx, actor, first.id, { disposition: 'site_visit', subStatus: 'Scheduled', nextActionAt: new Date(Date.now() + 86_400_000).toISOString(), note: 'Sample visit' });
  });
  console.log(`Seeded workspace "demo". Sign in as owner@demo.test / ${PASSWORD}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
