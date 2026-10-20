# LeadVolt handover — read first when resuming

Saved 21 October 2026 (Asia/Dubai). The user asked to finalize promptly because credits were exhausted. Stop adding features at this checkpoint. The original target remains a premium CRM suitable for a large company; no validated dollar-per-user valuation or enterprise certification has been established.

## Completed in this upgrade

- Authenticator-app two-factor enrollment with QR/manual key, AES-256-GCM encrypted secrets, RFC 6238 verification, replay protection, one-use recovery codes, replacement/disable controls and second-factor sign-in challenges.
- Individually revocable device sessions, personal password change, administrator session revocation, role-based mandatory MFA with enrollment gating, and a staff security overview.
- Personal/shared saved lead views with ownership enforcement, versioned updates and safe validated query fields.
- Management reports for sources, agents, calls, response times, bookings and current stage ageing, with CSV exports and clear date/cohort definitions.
- Portal receipt reconciliation using pasted IDs or a locally parsed CSV. Only selected ID fields are submitted. Missing/rejected/received results and duplicate export rows are saved as auditable snapshots.
- Stage-entry tracking independent of ordinary notes, with estimated legacy history marked.
- Manually entered Bayut/PropertyFinder/Dubizzle enquiries without a reference are held for admin review rather than general allocation.
- Booking review APIs: commission review, approval → external invoice reference → payment reference, version checks, immutable approved financial details, and cancellation protection for paid bookings. Dedicated booking UI is NOT built yet.
- Existing listing-owner routing, admin exceptions, no-BRN assignment, daily updates and message delivery safeguards remain in place.

## Evidence and exact limits

Read docs/COMPANY_CONTROLS.md and docs/company-validation. Browser tests use fictional data. The local intake exercise accepted 200 distinct enquiries plus 200 retries, saved exactly 200 leads, and delivered 200 notifications to the correct agent. HTTP p95 was 294 ms; agent-notification p95 was 296 ms on this local environment. This does not establish production capacity or an SLA.

The earlier restore exercise verified 22 tables for the previous schema. Repeat recovery against the new schema and encryption-key backups before deployment; do not claim that the old restore test covers the new MFA/reconciliation tables. Local production containers were rebuilt and exercised for the company-controls implementation before the final booking API addition; rerun the container checks after rebuilding the final source.

## Resume priorities

1. Confirm the real Bayut delivery method with the company admin, obtain approved payload/export samples and credentials, implement the actual bridge/connector and reconcile real event IDs. The admin previously said they needed to confirm the method; do not ask them to repeat the whole workflow.
2. Build the booking review UI for the implemented APIs. Confirm the company's approval/commission policy; add separation of duties if required. Invoice/payment references are internal records of external finance activity, not legal invoices or bank transactions.
3. Complete enterprise access/operating requirements: SSO, invitation and forgotten-password flows, approved lost-MFA recovery, shared rate limiting/socket fan-out for multiple replicas, external monitoring and updated recovery rehearsal.
4. Reassess the original blueprint against actual company priorities: advanced filters, bulk data import, documents/KYC storage and access, consent/opt-out, email/telephony, multi-number messaging, attendance/team management, configurable pipeline and accounting integrations. These are not completed merely because the blueprint mentions them.
5. Obtain an authorized visual reference if exact LeadRat interface parity remains required. No authenticated LeadRat UI was available; do not pretend the current design has been compared with it.
6. Run a staged live pilot, representative-volume and migration/recovery exercises, and independent security review before a company-wide rollout. Pricing requires demonstrated customer value and actual service commitments; stop guessing subscription prices from test counts.

## Workspace and verification

Source: /workspace/helloworld/leadvolt on branch codex/leadvolt-business-routing. The final ZIP is in leadvolt-delivery on that branch. Existing uploads and earlier ZIPs are preserved. The untracked leadvolt-delivery/leadvolt-review.html predates this work; leave it alone.

Use Node 24 and PostgreSQL 16. Development services were running on localhost:4000 and localhost:5173, with a local Docker PostgreSQL container named leadvolt-db. Never run integration tests against company data. The runner requires disposable TEST_DATABASE_URL, TEST_MIGRATION_URL and a leadvolt_worker role (TEST_WORKER_DATABASE_URL can be provided). Run npm run build, npm run test:integration, and the three scripts/browser_*.py scripts. scripts/load-intake.mjs is opt-in and creates a new fictional workspace; use only development/staging.

Production now requires AUTH_ENCRYPTION_KEY: a separate persistent base64-encoded 32-byte key. Keep it outside Git and archive it securely with recovery configuration. Migration 006 invalidates old sessions, so staff must sign in again. No real Bayut/Meta credentials, customer data or production hosting were supplied.
