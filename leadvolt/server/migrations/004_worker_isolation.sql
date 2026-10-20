-- A caller-set app.system flag must not grant cross-workspace access.
-- Background/public-link work uses a separate database principal.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND EXISTS(SELECT 1 FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=pg_tables.tablename AND p.policyname='tenant_isolation')
  LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I',t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING
      (current_user='leadvolt_worker' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (current_user='leadvolt_worker' OR tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$p$,t);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='leadvolt_worker') THEN
    GRANT USAGE ON SCHEMA public TO leadvolt_worker;
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO leadvolt_worker;
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO leadvolt_worker;
    REVOKE UPDATE,DELETE,TRUNCATE ON audit_log FROM leadvolt_worker;
    REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON schema_migrations FROM leadvolt_worker;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='leadvolt_app') THEN
    REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON schema_migrations FROM leadvolt_app;
  END IF;
END $$;
