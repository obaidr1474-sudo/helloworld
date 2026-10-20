ALTER TABLE deals ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE deals ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE deals ADD COLUMN approved_by uuid;
ALTER TABLE deals ADD COLUMN approved_at timestamptz;
ALTER TABLE deals ADD COLUMN external_invoice_ref text;
ALTER TABLE deals ADD COLUMN invoiced_at timestamptz;
ALTER TABLE deals ADD COLUMN payment_ref text;
ALTER TABLE deals ADD COLUMN paid_at timestamptz;
ALTER TABLE deals ADD COLUMN cancellation_reason text;
ALTER TABLE deals ADD CONSTRAINT fk_deal_approver_tenant FOREIGN KEY(tenant_id,approved_by) REFERENCES users(tenant_id,id);
CREATE UNIQUE INDEX ux_deal_invoice_ref ON deals(tenant_id,lower(external_invoice_ref)) WHERE external_invoice_ref IS NOT NULL;
CREATE FUNCTION protect_reviewed_booking() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status<>'pending_approval' AND (NEW.deal_value IS DISTINCT FROM OLD.deal_value OR NEW.commission_pct IS DISTINCT FROM OLD.commission_pct OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.property_id IS DISTINCT FROM OLD.property_id) THEN
  RAISE EXCEPTION 'Reviewed booking financial details are immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;END $$;
CREATE TRIGGER reviewed_booking_immutable BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION protect_reviewed_booking();
