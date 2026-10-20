# Operator runbook

## Runtime and database roles

Use PostgreSQL 16 and Node.js 24. Run one API replica with background workers enabled. The current Socket.IO fan-out is process-local: multiple replicas require a shared adapter and cross-node acceptance testing before deployment. The durable outbox provides at-least-once realtime notifications, so clients must tolerate repeats; reconnecting clients refresh their state.

Provision three distinct login roles with strong secrets from your secret manager:

| Role | Use | Privileges |
|---|---|---|
| Migration/database owner | One-shot migration job and privileged backup operations | Owns schema and migrations; never exposed to the API |
| `leadvolt_app` | API request transactions | Non-owner, non-superuser, no BYPASSRLS, no membership in the owner or worker roles |
| `leadvolt_worker` | Cross-workspace background/public-link operations | Dedicated non-superuser role; never use its URI for the API pool |

A database administrator can create the two runtime roles with `CREATE ROLE leadvolt_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;` and the corresponding command for `leadvolt_worker`. Set passwords securely using `psql`'s `\password` or your managed database's secret flow. Grant both roles CONNECT on the application database and USAGE on its public schema. The migration owner must own or be able to create tables and the trusted `pgcrypto`/`citext` extensions. Migrations grant runtime table/sequence access, then remove audit mutation and migration-ledger writes.

Do not grant either runtime role membership in the migration owner. The app must also have no membership in `leadvolt_worker`. Production startup refuses an API connection with owner, superuser, RLS bypass or worker access, and refuses a worker connection using another principal. Row-level security uses the tenant set inside each transaction; setting a caller-controlled `app.system` flag grants nothing.

For an existing development Docker volume created before this upgrade, create `leadvolt_worker` in that database before applying migration 004; the init script only runs when a volume is first created. Existing non-listing leads retain their owners during migration. Imported listing references are initially unmapped and require admin review. Duplicate historical bookings are voided without deleting history. Back up and rehearse the upgrade on a restored database first.

## Production configuration and startup

Create an operator-only environment file outside version control. Required values are `DATABASE_URL`, `WORKER_DATABASE_URL`, `MIGRATION_DATABASE_URL`, `JWT_SECRET`, `AUTH_ENCRYPTION_KEY`, `CORS_ORIGIN` and `PUBLIC_BASE_URL`. Generate a unique random JWT secret of at least 32 characters. Generate a separate persistent MFA encryption key with `openssl rand -base64 32` and put it in AUTH_ENCRYPTION_KEY. Keep this key in your secret manager and recovery backups: losing it prevents existing authenticator secrets from being decrypted. Do not rotate it without a credential re-encryption procedure. Database URLs must use the correct roles, strong unique passwords, and your database provider's verified TLS settings. Do not disable certificate checks. The production Compose file passes the owner URI only to its migration job.

Both public URL settings must use your exact HTTPS CRM origin, for example `https://crm.your-company.example`. Public registration is disabled by production Compose. Configure a TLS reverse proxy to the web service's loopback port 8080 and permit websocket upgrades on `/ws`. Keep the API and PostgreSQL on private networks. Configure request logs, database logs and secrets according to your company's retention policy.

Set `TRUST_PROXY` only to the actual trusted proxy IPs/CIDRs. It is disabled by default. Configure proxy/client IP forwarding and test rate limits from your real ingress; the local tests do not establish your public network's proxy trust. API rate limits are process-local; sign-in has a tighter limit. Scaling or advanced abuse controls require a shared store or ingress controls.

```bash
docker compose --env-file /secure/path/leadvolt.env -f docker-compose.production.yml build
docker compose --env-file /secure/path/leadvolt.env -f docker-compose.production.yml up -d
```

If a corporate build proxy uses its own CA, the Dockerfiles accept an optional BuildKit secret `npm_ca` mounted only during dependency installation. Supply your approved CA using a local Compose build-secrets override. The release does not include an environment-specific certificate, proxy IP or disabled TLS verification.

Migrations take a database advisory lock, apply each new file transactionally and record its SHA-256 checksum. Changing an applied migration causes startup to stop; add another migration instead. Existing legacy ledger entries without a checksum are recorded on first upgraded migration run. Keep the previous application image and a verified backup for recovery; schema migrations are forward-only, so rehearse rollback through a restored database rather than guessing reverse SQL.

Bootstrap the first workspace with the operator-only `server/dist/bootstrap.js` CLI. Export `BOOTSTRAP_COMPANY`, `BOOTSTRAP_SLUG`, `BOOTSTRAP_OWNER_NAME`, `BOOTSTRAP_OWNER_EMAIL` and a strong `BOOTSTRAP_OWNER_PASSWORD` in the operator shell, then pass those variable names with `docker compose exec -e NAME` to `server node dist/bootstrap.js`. The command creates the workspace and owner atomically and does not print credentials. Remove the bootstrap password from the shell/secret context afterward. Do not enable public registration merely to create the owner.

The browser uses HttpOnly Secure cookies in production; access the public site over HTTPS. Authenticator MFA, recovery codes, revocable sessions and workspace role policies are implemented under Account security. Company-wide SSO and a forgotten-password recovery UI are not implemented. Administrative password/role changes revoke sessions; use a controlled administrator or external identity workstream to address your company's authentication requirements before a broad rollout.

## Health, monitoring and routine admin work

`/healthz` checks the API process; `/readyz` also checks the database. The API container health check uses readiness. The migration job must complete successfully before the API starts; web startup waits for a healthy API. Production does not expose the API port publicly.

Monitor container restarts, readiness failures, PostgreSQL pool usage/storage, undispatched outbox age, processing/unknown message jobs, intake rejection spikes and backup freshness. Connect these signals to your company's monitoring system; an external paging service is not included. `/readyz` does not establish provider delivery health.

Daily administrator workflow:

1. Open **Operations → Routing exceptions** and resolve saved enquiries with unknown/missing references or unavailable agents.
2. Check **Listing ownership** before new listings go live, separating responsible CRM ownership from the publisher's identity. Do not assume a publisher is responsible for every listing under their account.
3. Review **Daily team updates**, unacknowledged receipts, overdue work, and **Integration activity**.
4. Reconcile the provider's enquiry totals and IDs against CRM receipts. The CRM cannot detect an enquiry the upstream system never delivered without such reconciliation.

Agents use **My day**, acknowledge new leads, record real calls/statuses/notes or complete follow-up tasks, and schedule the next action. The tenant's business timezone defaults to Asia/Dubai. Receipt acknowledgement alone and administrator edits do not satisfy an assigned agent's daily update. Assignment resets acknowledgement/daily-update credit for the new owner. Deactivating an agent, or changing them to a non-receiving role, revokes sessions and returns their open leads for review. Listing mappings remain visible as unavailable until corrected.

Listing ownership is never automatically redistributed because an agent is off shift, over rule capacity, or late against SLA. SLA alerts remain visible. Rule-based non-listing leads retain their separate allocation behavior.

## Backups and recovery

`scripts/backup.sh` makes a custom-format dump and SHA-256 file with restrictive permissions and refuses to overwrite an existing backup. Examples:

```bash
DB_CONTAINER=your-postgres-container DB_OWNER_USER=your-owner DB_NAME=leadvolt \
  scripts/backup.sh backups/leadvolt-scheduled.dump
# Or provide BACKUP_DATABASE_URL to use a local compatible pg_dump client.
```

Move the dump and checksum to encrypted, access-controlled storage outside the application host. Database role credentials, provider credentials, TLS configuration and external files are not in this dump; back up those through their appropriate secure systems. Choose backup frequency, retention, point-in-time recovery, RPO and RTO with your company and database provider. This release does not configure managed PITR, replication or offsite scheduling.

Restore only into a pre-created empty destination, with the roles already provisioned:

```bash
DB_CONTAINER=your-postgres-container DB_OWNER_USER=your-owner \
RESTORE_DATABASE_NAME=leadvolt_restore_test CONFIRM_RESTORE_DATABASE=leadvolt_restore_test \
  scripts/restore.sh backups/leadvolt-scheduled.dump
```

For a managed database, set `RESTORE_DATABASE_URL` instead of `DB_CONTAINER`, plus the same exact-name confirmation. The script verifies the checksum, uses a single restore transaction, stops on errors and reapplies application ACLs. Validate table contents, login, tenant isolation, assignment, audit permissions and outstanding provider sends before changing traffic. Disable workers/provider sending during a recovery rehearsal so restored queues cannot contact real customers. For a quiescent source backed up after stopping writes, `scripts/verify-restore.mjs` compares table lists and streams content digests from both databases using read-only transactions. Supply privileged read connections through `VERIFY_SOURCE_DATABASE_URL` and `VERIFY_RESTORE_DATABASE_URL`. It prints only counts and the match result. Full comparisons require database sorting and temporary disk space; schedule them for recovery rehearsals.

## Company acceptance before live cutover

The report records the tests actually run. A company rollout still requires a staged acceptance exercise using your real provider method and approved sample enquiries: licensed publisher/different responsible agent, no-BRN agent, unmapped reference, missing reference, disabled owner, provider retries, simultaneous admin changes, and daily reporting across midnight. Reconcile upstream and CRM counts, verify data import and representative volume, confirm access with every business role, complete security review and rehearse recovery on your hosting platform.

The implementation and test evidence support review and a staged pilot. They do not establish a per-user price, LeadRat feature parity, independent penetration testing, or an enterprise SLA.


## Company controls release

Migrations 006–009 invalidate old untracked sessions, introduce encrypted MFA credentials and revocable sessions, saved-view versions, reconciliation snapshots, stage-entry tracking and reviewed-booking protection. Staff sign in again after upgrade. Admins can require MFA by role only after enabling their own MFA. Recovery codes are shown once and each is usable once; regenerated codes invalidate prior ones. No administrator bypass for a lost authenticator is included. Retain recovery codes securely. Session activity timestamps update at most every five minutes. Expired challenges are removed after a day and expired sessions after 90 days by an hourly worker.

Booking APIs record approvals and external finance references. They do not issue legal invoices, transfer money, integrate a bank, or reverse paid transactions. The booking UI and company-specific approval policy are pending; do not present this API layer as a completed accounting product.
