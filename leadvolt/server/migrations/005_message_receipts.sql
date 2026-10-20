-- Keep early provider callbacks until the send acknowledgement is committed.
CREATE TABLE message_receipts (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('sent','failed','delivered','read')),
  provider_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,provider_id)
);
ALTER TABLE message_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_receipts USING
  (current_user='leadvolt_worker' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (current_user='leadvolt_worker' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON message_receipts TO leadvolt_app,leadvolt_worker;
