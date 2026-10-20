# LeadVolt

Real estate CRM with listing ownership routing, an administrator exception queue, and daily agent accountability. This version implements the company workflow described during review: a Bayut listing's publisher and its responsible CRM agent are separate identities. An agent does not need a BRN to receive a CRM enquiry assigned to them.

Read the [business workflow and validation report](docs/BUSINESS_UPGRADE.md), [operator runbook](docs/OPERATIONS.md), and [integration contract](docs/INTEGRATIONS.md). The original [engineering blueprint](docs/LeadVolt_Engineering_Blueprint.md) is a roadmap, not a list of delivered capabilities.

## Company controls upgrade

This version adds authenticator-based two-factor sign-in, recovery codes, session revocation, staff MFA policies, personal/shared lead views, management reports and portal receipt reconciliation. Booking review and finance-reference tracking APIs are implemented; their dedicated user interface remains pending. Read [NEXT_SESSION.md](NEXT_SESSION.md) for the exact handover and remaining work.

## What happens to an enquiry

1. Intake verifies the signature and records a stable delivery ID. Provider retries return the original result.
2. A known portal + listing reference routes directly to its responsible agent, even when published under someone else's account.
3. Unknown references, missing references, paused mappings, and unavailable agents stay saved for administrator review in **Operations → Routing exceptions**.
4. The administrator assigns an enquiry once or saves ownership for all waiting and future enquiries for that reference.
5. The agent acknowledges receipt and records meaningful updates through **My day**. Administrators can monitor daily updates and overdue follow-ups.

The same phone number can have separate opportunities for different listings or portals. A genuine repeat enquiry about the same listing retains the existing lead and owner. Mapping changes affect waiting and future leads; previously assigned leads require an explicit reassignment.

## Development

Requires Node.js 24+, npm, PostgreSQL 16. Docker provides the database and development roles:

```bash
cp .env.example server/.env
npm ci
docker compose up -d db
npm run migrate
npm run dev
```

Open **http://localhost:5173**. Use the configured origin exactly; the CSRF checks reject writes from other origins. Create a fictional workspace through development registration. `npm run seed` creates an optional fictional sample workspace and prints its sample login.

For the complete local Docker stack, put configuration in `.env` and run `docker compose up --build`; open **http://localhost:8080**. This Compose file uses development credentials. For deployment use [docker-compose.production.yml](docker-compose.production.yml) and the operator runbook.

## Verification

```bash
npm run build
npm run test:unit
# The integration runner requires a disposable database and recreates its schema.
TEST_DATABASE_URL=postgres://leadvolt_app:leadvolt_app@localhost:5432/leadvolt_test \
TEST_MIGRATION_URL=postgres://leadvolt:leadvolt@localhost:5432/leadvolt_test \
TEST_WORKER_DATABASE_URL=postgres://leadvolt_worker:leadvolt_worker@localhost:5432/leadvolt_test \
npm run test:integration
npm audit --audit-level=moderate
```

Create `leadvolt_test` as the migration owner before running the integration suite; both runtime roles must exist. Never point tests at a company database. `npm test` skips database suites when their URLs are missing; the CI pipeline uses `test:integration` so this cannot silently pass without exercising the database.

Browser checks use a new fictional workspace on each run, against the running development stack:

```bash
python -m pip install -r scripts/requirements-browser.txt
python -m playwright install chromium
python scripts/browser_smoke.py
python scripts/browser_routing.py
python scripts/browser_company.py
```

Set `CHROMIUM_PATH` for a system Chromium or `LEADVOLT_URL` for a different allowed origin. The GitHub Actions workflow checks builds, the database suite, dependency advisories, and the browser scripts.

## Source layout

| Directory | Purpose |
|---|---|
| `server/src/services` | Ownership routing, intake receipts, leads, tasks, inventory, queued messaging |
| `server/src/routes` | Authenticated APIs, administrator operations, signed intake and provider callbacks |
| `server/migrations` | Forward-only, checksummed database changes |
| `server/test` | Business, access control, concurrency, delivery and domain tests |
| `web/src/pages` | Dashboard, Operations/My day, leads, inbox, inventory, follow-ups, team |
| `scripts` | Browser checks, guarded integration runner, backup and restore tools |

## Deployment scope

The app has been tested using fictional data, local PostgreSQL and local production containers. It has not been deployed to your company, connected to your live Bayut feed, or certified as enterprise ready. Bayut's actual delivery method, credentials and payload remain to be confirmed by your admin. Native email ingestion, telephony, SSO, Arabic/RTL and a native mobile app are not implemented. A price target does not establish readiness; the runbook defines the remaining live acceptance work.
