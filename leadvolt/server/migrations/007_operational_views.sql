ALTER TABLE saved_views ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE saved_views ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX ux_saved_views_name ON saved_views(tenant_id,owner_id,lower(name));
CREATE TABLE reconciliation_runs (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),source text NOT NULL,
 created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),provider_count integer NOT NULL,received_count integer NOT NULL,
 missing_count integer NOT NULL,rejected_count integer NOT NULL,duplicate_rows integer NOT NULL DEFAULT 0,
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id),UNIQUE(tenant_id,id)
);
CREATE TABLE reconciliation_items (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),run_id uuid NOT NULL,
 provider_event_id text NOT NULL,status text NOT NULL CHECK(status IN('received','missing','rejected')),lead_id uuid,
 FOREIGN KEY(tenant_id,run_id) REFERENCES reconciliation_runs(tenant_id,id),
 FOREIGN KEY(tenant_id,lead_id) REFERENCES leads(tenant_id,id),UNIQUE(tenant_id,run_id,provider_event_id)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['reconciliation_runs','reconciliation_items'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(current_user='leadvolt_worker' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(current_user='leadvolt_worker' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO leadvolt_app,leadvolt_worker',t);
 END LOOP;
END $$;
