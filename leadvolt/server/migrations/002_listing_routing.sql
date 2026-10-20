-- Explicit portal/listing ownership. Publishing identity never decides lead ownership.
ALTER TABLE users ADD COLUMN auth_version integer NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN broker_registration_number text;

CREATE TABLE listing_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source text NOT NULL CHECK (source ~ '^[a-z0-9_]+$'),
  listing_ref text NOT NULL CHECK (length(btrim(listing_ref)) BETWEEN 1 AND 200),
  property_id uuid REFERENCES properties(id),
  responsible_agent_id uuid REFERENCES users(id),
  publisher_agent_id uuid REFERENCES users(id),
  publisher_account text,
  enabled boolean NOT NULL DEFAULT true,
  notes text,
  created_by uuid REFERENCES users(id),
  updated_by uuid REFERENCES users(id),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, listing_ref)
);
CREATE INDEX ix_routes_agent ON listing_routes(tenant_id, responsible_agent_id);

ALTER TABLE leads ADD COLUMN listing_route_id uuid REFERENCES listing_routes(id);
ALTER TABLE leads ADD COLUMN routing_mode text NOT NULL DEFAULT 'rules' CHECK (routing_mode IN ('rules','listing'));
ALTER TABLE leads ADD COLUMN routing_status text NOT NULL DEFAULT 'assigned'
  CHECK (routing_status IN ('assigned','unmapped','missing_reference','agent_unavailable','manual_review'));
ALTER TABLE leads ADD COLUMN routing_note text;
ALTER TABLE leads ADD COLUMN assigned_at timestamptz;
ALTER TABLE leads ADD COLUMN acknowledged_at timestamptz;
ALTER TABLE leads ADD COLUMN last_agent_update_at timestamptz;
UPDATE leads SET assigned_at = created_at WHERE owner_id IS NOT NULL;
UPDATE leads SET routing_status = 'manual_review' WHERE owner_id IS NULL;
UPDATE leads SET last_agent_update_at = last_contacted_at WHERE last_contacted_at IS NOT NULL;
-- Preserve a contact's independent opportunities. A different listing must not inherit another listing's owner.
ALTER TABLE leads ADD COLUMN opportunity_key text NOT NULL DEFAULT '';
UPDATE leads SET opportunity_key = source || ':' || btrim(listing_ref) WHERE nullif(btrim(listing_ref),'') IS NOT NULL;
DROP INDEX ux_leads_phone;
CREATE UNIQUE INDEX ux_leads_phone ON leads(tenant_id, phone_e164, opportunity_key) WHERE phone_e164 IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX ux_leads_email_opportunity ON leads(tenant_id, email, opportunity_key) WHERE phone_e164 IS NULL AND email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_leads_route_pending ON leads(tenant_id, listing_route_id, routing_status) WHERE deleted_at IS NULL AND owner_id IS NULL;
CREATE INDEX ix_leads_daily_update ON leads(tenant_id, owner_id, last_agent_update_at) WHERE deleted_at IS NULL AND stage NOT IN ('lost','booked');

INSERT INTO listing_routes(tenant_id,source,listing_ref)
SELECT DISTINCT tenant_id,source,btrim(listing_ref) FROM leads WHERE nullif(btrim(listing_ref),'') IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE leads l SET listing_route_id=r.id,routing_mode='listing'
FROM listing_routes r WHERE l.tenant_id=r.tenant_id AND l.source=r.source AND btrim(l.listing_ref)=r.listing_ref;
ALTER TABLE lead_assignments DROP CONSTRAINT lead_assignments_reason_check;
ALTER TABLE lead_assignments ADD CONSTRAINT lead_assignments_reason_check CHECK(reason IN ('rule','manual','sla_breach','reenquiry_sticky','bulk','deactivation','listing_mapping'));

-- Each transport delivery has a stable receipt, separate from customer re-enquiries.
CREATE TABLE intake_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source text NOT NULL,
  provider_event_id text NOT NULL,
  payload_hash text NOT NULL,
  lead_id uuid REFERENCES leads(id),
  result jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, provider_event_id)
);
CREATE TABLE integration_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source text NOT NULL,
  adapter text NOT NULL,
  status text NOT NULL CHECK (status IN ('received','duplicate','rejected')),
  provider_event_id text,
  listing_ref text,
  lead_id uuid REFERENCES leads(id),
  error_code text,
  summary text,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_integration_events ON integration_events(tenant_id, received_at DESC);

-- One live booking per opportunity; repeated status saves must not duplicate revenue.
ALTER TABLE deals ADD COLUMN voided_at timestamptz;
WITH ranked AS (SELECT id, row_number() OVER (PARTITION BY tenant_id,lead_id ORDER BY booked_at DESC,id DESC) n FROM deals)
UPDATE deals SET voided_at=now() FROM ranked r WHERE deals.id=r.id AND r.n>1;
CREATE UNIQUE INDEX ux_deals_active_lead ON deals(tenant_id,lead_id) WHERE voided_at IS NULL;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['listing_routes','intake_receipts','integration_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING
      (current_setting('app.system',true)='on' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (current_setting('app.system',true)='on' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  END LOOP;
END $$;

-- Foreign keys must agree on tenant as well as UUID. RLS alone does not enforce this.
DO $$ DECLARE r record; cname text; BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS src, c.confrelid::regclass AS dst,
           a.attname AS col, a2.attname AS refcol
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
    JOIN pg_attribute a2 ON a2.attrelid=c.confrelid AND a2.attnum=c.confkey[1]
    WHERE c.contype='f' AND cardinality(c.conkey)=1 AND a2.attname='id'
      AND c.connamespace='public'::regnamespace
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.conrelid AND attname='tenant_id' AND NOT attisdropped)
      AND EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.confrelid AND attname='tenant_id' AND NOT attisdropped)
  LOOP
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %s(tenant_id,id)', 'ux_tenant_'||r.dst::text,r.dst);
    cname='tenant_fk_'||r.src::text||'_'||r.col;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (tenant_id,%I) REFERENCES %s(tenant_id,id)',r.src,cname,r.col,r.dst);
  END LOOP;
END $$;

CREATE FUNCTION prevent_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit records are append-only'; END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='leadvolt_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON listing_routes,intake_receipts,integration_events TO leadvolt_app;
    REVOKE UPDATE,DELETE,TRUNCATE ON audit_log FROM leadvolt_app;
  END IF;
END $$;
