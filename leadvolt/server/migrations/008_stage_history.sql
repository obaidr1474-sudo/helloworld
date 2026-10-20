ALTER TABLE leads ADD COLUMN stage_entered_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE leads ADD COLUMN stage_age_estimated boolean NOT NULL DEFAULT false;
UPDATE leads l SET stage_entered_at=COALESCE((SELECT max(a.at) FROM audit_log a WHERE a.tenant_id=l.tenant_id AND a.entity='lead' AND a.entity_id=l.id AND a.action='disposition' AND a.diff->>'from' IS DISTINCT FROM a.diff->>'to'),l.created_at),stage_age_estimated=(l.stage<>'new');
CREATE FUNCTION track_lead_stage_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.stage IS DISTINCT FROM OLD.stage THEN NEW.stage_entered_at=now();NEW.stage_age_estimated=false;END IF;
 RETURN NEW;END $$;
CREATE TRIGGER lead_stage_entry BEFORE UPDATE OF stage ON leads FOR EACH ROW EXECUTE FUNCTION track_lead_stage_entry();
