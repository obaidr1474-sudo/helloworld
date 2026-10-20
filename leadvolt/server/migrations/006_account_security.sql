ALTER TABLE users ADD COLUMN mfa_secret text;
ALTER TABLE users ADD COLUMN mfa_pending_secret text;
ALTER TABLE users ADD COLUMN mfa_pending_expires_at timestamptz;
ALTER TABLE users ADD COLUMN mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN mfa_last_step bigint NOT NULL DEFAULT -1;
ALTER TABLE users ADD COLUMN mfa_recovery_hashes text[] NOT NULL DEFAULT '{}';
ALTER TABLE tenants ADD COLUMN security_policy_version integer NOT NULL DEFAULT 1;
CREATE TABLE auth_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),user_id uuid NOT NULL,
 user_agent text NOT NULL DEFAULT '',ip_address text NOT NULL DEFAULT '',mfa_verified boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),last_seen_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,revoked_at timestamptz,
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX ix_sessions_user ON auth_sessions(tenant_id,user_id,expires_at) WHERE revoked_at IS NULL;
CREATE TABLE auth_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),user_id uuid NOT NULL,
 token_hash text NOT NULL,auth_version integer NOT NULL,attempts integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,consumed_at timestamptz,
 FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id),UNIQUE(tenant_id,token_hash)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['auth_sessions','auth_challenges'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING(current_user='leadvolt_worker' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(current_user='leadvolt_worker' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO leadvolt_app,leadvolt_worker',t);
 END LOOP;
END $$;
-- Upgrade invalidates older untracked sessions. New sessions carry a revocable session ID.
UPDATE users SET auth_version=auth_version+1;
