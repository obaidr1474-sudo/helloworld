-- LeadVolt initial schema (PostgreSQL 16)
-- Conventions: uuid PKs, tenant_id on every tenant-owned row, RLS keyed on app.tenant_id,
-- timestamptz everywhere, money as numeric(14,2) + currency.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- tenancy & identity ----------
CREATE TABLE tenants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  slug             text NOT NULL UNIQUE,
  default_currency char(3) NOT NULL DEFAULT 'AED',
  timezone         text NOT NULL DEFAULT 'Asia/Dubai',
  intake_secret    text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  settings         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- sla_minutes, allocation defaults, wa config refs
  lead_serial_seq  bigint NOT NULL DEFAULT 1000,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  parent_id  uuid REFERENCES teams(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TYPE user_role AS ENUM ('owner','admin','manager','agent','listing_manager','viewer');

CREATE TABLE users (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email                   citext NOT NULL,
  password_hash           text NOT NULL,
  full_name               text NOT NULL,
  phone_e164              text,
  role                    user_role NOT NULL DEFAULT 'agent',
  team_id                 uuid REFERENCES teams(id),
  capacity_max_open_leads int,
  is_active               boolean NOT NULL DEFAULT true,
  is_clocked_in           boolean NOT NULL DEFAULT false,
  preferences             jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);
CREATE INDEX ix_users_email ON users(email);

CREATE TABLE attendance (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id),
  clock_in_at  timestamptz NOT NULL DEFAULT now(),
  clock_out_at timestamptz,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_attendance_user ON attendance(tenant_id, user_id, clock_in_at DESC);

-- ---------- inventory ----------
CREATE TABLE properties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  reference         text NOT NULL,
  portal_refs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  project_name      text NOT NULL,
  developer         text,
  community         text NOT NULL,
  sub_community     text,
  offering_type     text NOT NULL DEFAULT 'ready' CHECK (offering_type IN ('ready','off_plan')),
  purpose           text NOT NULL DEFAULT 'sale' CHECK (purpose IN ('sale','rent')),
  property_type     text NOT NULL,
  beds              smallint NOT NULL DEFAULT 0,
  baths             smallint,
  area_sqft         numeric(10,2),
  price             numeric(14,2) NOT NULL,
  currency          char(3) NOT NULL DEFAULT 'AED',
  handover          text,
  status            text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','sold','rented','off_market')),
  permit_number     text,
  brochure_url      text,
  latitude          double precision,
  longitude         double precision,
  amenities         text[] NOT NULL DEFAULT '{}',
  notes             text,
  listing_agent_id  uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at        timestamptz,
  UNIQUE (tenant_id, reference)
);
CREATE INDEX ix_props_match ON properties(tenant_id, status, property_type, beds, price) WHERE deleted_at IS NULL;

-- ---------- leads ----------
CREATE TABLE leads (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  serial_no           bigint NOT NULL,
  full_name           text NOT NULL,
  phone_e164          text,
  email               citext,
  owner_id            uuid REFERENCES users(id),
  original_owner_id   uuid REFERENCES users(id),
  team_id             uuid REFERENCES teams(id),
  stage               text NOT NULL DEFAULT 'new'
                      CHECK (stage IN ('new','contacted','meeting','site_visit','eoi','booked','lost')),
  sub_status          text,
  lost_reason         text,
  source              text NOT NULL,
  sub_source          text,
  campaign            jsonb NOT NULL DEFAULT '{}'::jsonb,
  listing_ref         text,
  property_id         uuid REFERENCES properties(id),
  requirements        jsonb NOT NULL DEFAULT '{}'::jsonb,
  score               smallint NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  temperature         text NOT NULL DEFAULT 'cold' CHECK (temperature IN ('cold','warm','hot')),
  temperature_overridden boolean NOT NULL DEFAULT false,
  tags                text[] NOT NULL DEFAULT '{}',
  reenquiry_count     int NOT NULL DEFAULT 0,
  last_reenquired_at  timestamptz,
  inbound_count       int NOT NULL DEFAULT 0,
  connected_calls     int NOT NULL DEFAULT 0,
  deal_value          numeric(14,2),
  first_response_at   timestamptz,
  last_contacted_at   timestamptz,
  last_inbound_at     timestamptz,
  next_action_at      timestamptz,
  sla_due_at          timestamptz,
  sla_breached_at     timestamptz,
  created_by          uuid REFERENCES users(id),
  updated_by          uuid REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  version             int NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, serial_no)
);
-- one live lead per phone per tenant: intake uses ON CONFLICT to turn duplicates into re-enquiries
CREATE UNIQUE INDEX ux_leads_phone ON leads(tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_leads_queue ON leads(tenant_id, owner_id, stage, next_action_at) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_unassigned ON leads(tenant_id, created_at) WHERE owner_id IS NULL AND deleted_at IS NULL;
CREATE INDEX ix_leads_source ON leads(tenant_id, source, created_at);
CREATE INDEX ix_leads_sla ON leads(sla_due_at) WHERE first_response_at IS NULL AND sla_breached_at IS NULL AND deleted_at IS NULL;
CREATE INDEX ix_leads_email ON leads(tenant_id, email);
CREATE INDEX ix_leads_req ON leads USING gin (requirements jsonb_path_ops);

CREATE TABLE lead_enquiries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id     uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source      text NOT NULL,
  sub_source  text,
  listing_ref text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_enq_lead ON lead_enquiries(tenant_id, lead_id, received_at DESC);

CREATE TABLE lead_assignments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id      uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  from_user_id uuid REFERENCES users(id),
  to_user_id   uuid REFERENCES users(id),
  assigned_by  uuid REFERENCES users(id),
  rule_id      uuid,
  reason       text NOT NULL CHECK (reason IN ('rule','manual','sla_breach','reenquiry_sticky','bulk','deactivation')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_assign_lead ON lead_assignments(tenant_id, lead_id, created_at DESC);

CREATE TABLE interactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id         uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id),
  type            text NOT NULL CHECK (type IN ('call','whatsapp','email','sms','note','status_change','assignment',
                                             'meeting','site_visit','brochure_shared','brochure_opened','task','reenquiry','system')),
  direction       text CHECK (direction IN ('inbound','outbound','internal')),
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  summary         text NOT NULL,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_confidential boolean NOT NULL DEFAULT false,
  external_id     text
);
CREATE INDEX ix_interactions_lead ON interactions(tenant_id, lead_id, occurred_at DESC);
CREATE UNIQUE INDEX ux_interactions_ext ON interactions(tenant_id, type, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE tasks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id               uuid REFERENCES leads(id) ON DELETE CASCADE,
  property_id           uuid REFERENCES properties(id),
  assignee_id           uuid NOT NULL REFERENCES users(id),
  created_by            uuid REFERENCES users(id),
  type                  text NOT NULL CHECK (type IN ('call','whatsapp','meeting','site_visit','follow_up','document','custom')),
  title                 text NOT NULL,
  notes                 text,
  priority              smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  due_at                timestamptz NOT NULL,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  reminded_at           timestamptz,
  completed_at          timestamptz,
  outcome               text,
  source_interaction_id uuid REFERENCES interactions(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_tasks_queue ON tasks(tenant_id, assignee_id, status, due_at);
CREATE INDEX ix_tasks_lead ON tasks(tenant_id, lead_id, status);
CREATE INDEX ix_tasks_remind ON tasks(due_at) WHERE status = 'open' AND reminded_at IS NULL;

CREATE TABLE messages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  channel        text NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','email','sms')),
  direction      text NOT NULL CHECK (direction IN ('inbound','outbound')),
  body           text NOT NULL,
  template_name  text,
  provider_id    text,
  status         text NOT NULL DEFAULT 'logged' CHECK (status IN ('logged','queued','sent','delivered','read','failed','received')),
  sent_by        uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_messages_lead ON messages(tenant_id, lead_id, created_at);
CREATE UNIQUE INDEX ux_messages_provider ON messages(tenant_id, provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE share_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code           text NOT NULL UNIQUE,
  lead_id        uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  created_by     uuid REFERENCES users(id),
  property_ids   uuid[] NOT NULL,
  channel        text NOT NULL DEFAULT 'whatsapp',
  expires_at     timestamptz,
  open_count     int NOT NULL DEFAULT 0,
  last_opened_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  lead_id          uuid NOT NULL REFERENCES leads(id),
  property_id      uuid REFERENCES properties(id),
  agent_id         uuid REFERENCES users(id),
  deal_value       numeric(14,2) NOT NULL,
  currency         char(3) NOT NULL DEFAULT 'AED',
  commission_pct   numeric(5,2) NOT NULL DEFAULT 2.00,
  brokerage_amount numeric(14,2) GENERATED ALWAYS AS (round(deal_value * commission_pct / 100, 2)) STORED,
  status           text NOT NULL DEFAULT 'pending_approval' CHECK (status IN ('pending_approval','approved','invoiced','paid','cancelled')),
  booked_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------- configuration ----------
CREATE TABLE allocation_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text NOT NULL,
  priority    int NOT NULL DEFAULT 100,
  is_enabled  boolean NOT NULL DEFAULT true,
  definition  jsonb NOT NULL,           -- see src/domain/allocation.ts RuleDefinition
  rr_cursor   bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_rules_tenant ON allocation_rules(tenant_id, is_enabled, priority);

CREATE TABLE saved_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id   uuid NOT NULL REFERENCES users(id),
  name       text NOT NULL,
  query      jsonb NOT NULL,
  is_shared  boolean NOT NULL DEFAULT false,
  position   int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- eventing & audit ----------
CREATE TABLE outbox_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  type          text NOT NULL,
  payload       jsonb NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz
);
CREATE INDEX ix_outbox_pending ON outbox_events(id) WHERE dispatched_at IS NULL;

CREATE OR REPLACE FUNCTION notify_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM pg_notify('leadvolt_outbox', NEW.id::text); RETURN NEW; END $$;
CREATE TRIGGER trg_outbox_notify AFTER INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION notify_outbox();

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  actor_id   uuid,
  entity     text NOT NULL,
  entity_id  uuid,
  action     text NOT NULL,
  diff       jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_log(tenant_id, entity, entity_id, at DESC);

-- ---------- row-level security ----------
-- The API sets `app.tenant_id` per transaction (set_config(..., true)). Background workers that
-- must span tenants (outbox dispatcher, SLA scheduler) set `app.system = on` for their transaction only.
-- Policies bind the non-owner runtime role (leadvolt_app); the migration owner bypasses them.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['teams','users','attendance','properties','leads','lead_enquiries','lead_assignments',
                           'interactions','tasks','messages','share_links','deals','allocation_rules','saved_views',
                           'outbox_events','audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (current_setting('app.system', true) = 'on'
             OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
      WITH CHECK (current_setting('app.system', true) = 'on'
             OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

-- Grant the runtime role if it exists (created by docker/initdb or your platform).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'leadvolt_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO leadvolt_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO leadvolt_app;
  END IF;
END $$;
