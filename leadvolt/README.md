# LeadVolt

A real-estate CRM for brokerages that work high volumes of portal leads. LeadVolt is built for speed-to-lead: leads arrive from portals, IVR, WhatsApp and web forms, are de-duplicated and scored, and are assigned to an agent automatically. Agents work a paginated lead table with a keyboard-friendly detail drawer.

The full product and engineering specification is in [`docs/LeadVolt_Engineering_Blueprint.md`](docs/LeadVolt_Engineering_Blueprint.md).

## Interface review and improvements

The dashboard and lead workspace have been revised. Read [the review, feature audit, and validation evidence](docs/REVIEW_AND_CHANGES.md), including before-and-after screenshots. This is an improved working foundation; full LeadRat parity has not been established.

## What's in this repo

| Path | What it is |
|---|---|
| `server/` | Fastify + TypeScript API, Socket.IO realtime gateway, background workers |
| `server/migrations/` | PostgreSQL 16 schema (row-level security per tenant) |
| `server/src/domain/` | Pure business rules: pipeline and status validation, lead scoring, property matching, allocation rules |
| `server/src/services/` | Transactional use cases: intake and de-duplication, status updates, tasks, messaging, share links, analytics |
| `server/test/` | Unit tests (domain) and end-to-end API tests against real Postgres |
| `web/` | React + Vite client: dashboard, lead table and preview drawer with hotkeys, status popup, tasks, inventory, inbox, team & rules |
| `docker-compose.yml` | Postgres + API + web (nginx) |

## Quick start (Docker)

```bash
cp .env.example .env              # set JWT_SECRET at minimum
docker compose up --build
# web:  http://localhost:8080   api: http://localhost:4000
docker compose exec server node dist/seed.js   # optional sample workspace "demo"
```

The seed command prints the sample sign-in. Every person and listing it creates is fictional and labelled as a sample.

## Local development

Requirements: Node 20+, PostgreSQL 16.

```bash
npm ci
createdb leadvolt                         # owned by your migration role
psql -d leadvolt -f docker/initdb.sql      # creates the leadvolt_app runtime role (edit the password)
cp .env.example server/.env               # point the URLs at your database
npm run migrate
npm run seed                              # optional
npm run dev                               # API on :4000, web on :5173 (proxies /api and /ws)
```

### Tests

```bash
# unit tests only
npm test
# full end-to-end API suite (drops and recreates the schema in that database)
TEST_DATABASE_URL=postgres://leadvolt_app:...@localhost:5432/leadvolt_test \
TEST_MIGRATION_URL=postgres://leadvolt:...@localhost:5432/leadvolt_test npm test
```

The end-to-end suite covers registration and login, round-robin allocation, duplicate phones becoming re-enquiries, agent visibility rules, status validation and optimistic locking (`If-Match` → `412`), task creation, property matching, tracked share links, HMAC-signed portal intake, database-level tenant isolation, websocket event delivery and the SLA sweep.

## Architecture notes

- **Multi-tenant with RLS.** Every tenant table has a `tenant_isolation` policy keyed on `app.tenant_id`, which the API sets per transaction. The API connects as the non-owner `leadvolt_app` role so policies always apply. Background workers set `app.system = on` for their own transactions only.
- **Transactional outbox.** Domain events are written to `outbox_events` in the same transaction as the change. A trigger fires `pg_notify`, the dispatcher claims rows with `FOR UPDATE SKIP LOCKED`, and Socket.IO fans them out to rooms: `u:{user}`, `mgr:{tenant}`, `pool:{tenant}` (unassigned leads) and `lead:{id}` (joined after an access check). Several API instances can run at once. For cross-node socket fan-out, add the Socket.IO Redis adapter.
- **Every status update creates the next action.** `POST /leads/:id/disposition` validates the transition, closes superseded tasks, creates the follow-up task, writes the timeline entry, records deals, rescores the lead and emits events, all in one transaction.
- **Allocation rules** (`allocation_rules.definition`) support conditions (`eq`, `in`, `gte`, `contains`, …) on lead facts, and four strategies: round robin, least loaded, sticky owner and manual pool. They also support team or user pools, a clocked-in-only option, per-agent capacity and per-rule SLA. A default round-robin rule is created on the first allocation. Use `POST /allocation-rules/simulate` to dry-run a rule.
- **Scoring** is a deterministic rules model in `domain/scoring.ts`, recomputed on every relevant event. The temperature (cold, warm or hot) comes from the score unless an agent overrides it.

## API overview (`/api/v1`)

| Area | Endpoints |
|---|---|
| Auth & team | `POST /auth/register`, `POST /auth/login`, `GET /me`, `GET/POST /users`, `PATCH /users/:id`, `POST /attendance/clock-in`, `POST /attendance/clock-out` |
| Leads | `GET /leads` (scope, queue, filters, creation dates, cursor), `GET /leads/counts`, `POST /leads`, `GET/PATCH/DELETE /leads/:id`, `POST /leads/:id/disposition`, `POST /leads/:id/assign`, `POST /leads/bulk-assign`, `GET /leads/:id/timeline`, `POST /leads/:id/notes`, `POST /leads/:id/calls`, `GET /leads/:id/matches`, `POST /leads/:id/share`, `GET/POST /leads/:id/messages`, `GET /meta/pipeline` |
| Work | `GET/POST /tasks`, `POST /tasks/:id/complete`, `POST /tasks/:id/reopen`, `GET /inbox` |
| Inventory | `GET/POST /properties`, `PUT /properties/:id`, `GET /properties/:id/matching-leads` |
| Insight & config | `GET /analytics/overview`, `GET/POST/PUT/DELETE /allocation-rules`, `POST /allocation-rules/simulate`, `GET/PATCH /settings` |
| Public | `POST /intake/:adapter` (HMAC signed), `GET/POST /webhooks/whatsapp`, `GET /s/:code` (shared properties page) |

### Sending leads in

Sign the raw JSON body with the workspace's intake secret (Team & rules → Intake webhook secret):

```bash
BODY='{"contact":{"name":"Jane Doe","phone":"0501234567"},"listing":{"reference":"LV-2001"},"channel":"whatsapp"}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$INTAKE_SECRET" | cut -d' ' -f2)"
curl -X POST "http://localhost:4000/api/v1/intake/portal?source=bayut" \
  -H "content-type: application/json" -H "x-leadvolt-workspace: demo" -H "x-leadvolt-signature: $SIG" -d "$BODY"
```

There are four adapters: `generic` (LeadVolt's own schema), `portal`, `ivr` and `web_form` (which captures UTM fields). The `portal` adapter reads common field names by default. Each portal's real payload depends on your contract with it, so map the fields once per source in `settings.intake_field_maps` (`PATCH /settings`) instead of changing code.

### WhatsApp

Without WhatsApp configured, agents open a chat with the lead's number pre-filled and LeadVolt logs the message. To send and receive through the WhatsApp Business Platform (Cloud API), set the `WA_*` variables and point Meta's webhook to `/api/v1/webhooks/whatsapp`. Then set `wa_phone_number_id` in the workspace settings so inbound messages reach the right tenant. Inbound messages are verified with `X-Hub-Signature-256`, de-duplicated by message id, and create a lead when the number is unknown. Free-form replies are only allowed inside the 24-hour customer-service window. Outside it, send an approved template.

## Not yet built

These are in the blueprint but not in this first cut: native portal connectors (each needs that portal's API access), click-to-call telephony, email sync, invoicing, saved views UI, Arabic/RTL, the mobile app, ML scoring and AI assistance. The schema and event model are designed so these can be added without migrations to existing tables.
