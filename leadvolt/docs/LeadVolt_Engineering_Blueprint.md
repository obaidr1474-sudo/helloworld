# LeadVolt — Technical Requirements & Engineering Blueprint

**Version:** 1.0 (Draft for engineering review)
**Date:** 20 Oct 2026
**Target market:** UAE / GCC real estate brokerages (off-plan + secondary, AED-first, multi-portal lead intake)
**Status:** Clean-room specification

---

## 0. Clean-Room Statement & Method

This blueprint was produced by observing the *user-visible workflows* of an incumbent real-estate CRM the author's team uses day to day (dashboard, lead list, lead preview, status-change panel, advanced filter). Only functional behavior and information architecture were recorded. **No source code, API traffic, proprietary assets, branding, copy, or customer/lead data were captured or reused.** All schemas, APIs, names, and interaction designs below are original to LeadVolt.

Where the incumbent's behavior is cited it is labelled **[Observed]**. Where LeadVolt goes beyond it, it is labelled **[LeadVolt]**.

### 0.1 Observed baseline (summary)

| Area | Observed pattern | Gap / LeadVolt opportunity |
|---|---|---|
| Navigation | Dark left rail, 14 top-level modules (Dashboard, Global Config, Leads, Data, Invoice, Reports, Projects, Listing, Off Plan, Attendance, Tasks, Team, Org Profile, AI) | Too flat; group into 5 workspaces + command palette |
| Dashboard | Widget grid: lead totals (active/inactive), status KPI tiles with trend chips, revenue tiles (today/7d/30d/quarter), source donut (top 5), 5-stage funnel, top-closer cards, intake split, reminders, agent talk-time table, attendance clock-in card; "Edit Widgets", "Global Filter", team/agent scope switch | Add real-time deltas, SLA breach widget, drill-through on every number |
| Lead list | Paginated table (10/page), scope tabs (All / Mine / Team / Unassigned / Deleted / Duplicate / Re-enquired), queue tabs (Active / New / Pending / Scheduled / Overdue / EOI), search, date filter, column manager, export, ~10 icon actions per row, meeting-done / not-done badges on rows | Icon overload, no keyboard flow, no inline disposition, no virtualised scrolling |
| Lead preview | Right slide-over with prev/next arrows, action toolbar, tabs (Overview / Status / History / Notes / Documents), temperature tags (Cold/Warm/Hot), re-assign, enquiry info | Promote to split-screen; add unified timeline; hotkeys |
| Disposition | Status panel with chips (Callback, Schedule Meeting, Schedule Site Visit, Book, Not Interested, Drop, EOI), assignee, notes, **Save & Close / Save & Next** | Keep "Save & Next" pattern; add 1-key dispositions + mandatory next-action |
| Filtering | Very large modal (~90 fields) grouped: Assign, Status & Source, Project & Property, Location, Budget & Area, Referral, User, UTM, Enquiry, Additional, Call filters | Replace with faceted query builder + saved views |
| Comms | Per-row WhatsApp / call / email actions; WhatsApp sub-status ("WhatsApp sent"); IVR leads auto-created; third-party WhatsApp widget | Native multi-agent WhatsApp inbox |
| Sources | Portals (Bayut, PropertyFinder, Dubizzle), Facebook, IVR, Channel Partner, Direct, Data imports | Source adapters + dedupe + scoring |

---

## 1. Product Principles

1. **Speed-to-lead is the north-star metric.** Every portal lead must reach an agent's screen in < 5 s and be actionable in ≤ 2 clicks.
2. **Keyboard-first, mouse-friendly.** Every primary action has a hotkey; the mouse path is never longer than the incumbent's.
3. **One lead, one timeline.** Calls, WhatsApp, email, notes, status changes, site visits and documents appear in a single chronological stream.
4. **Every disposition creates a next action.** A lead can never be left in an active stage without a scheduled task (prevents "orphan" leads and silent overdue).
5. **Real-time by default.** Lists, counters, and inboxes update over WebSockets; no manual refresh.
6. **Tenant-isolated, audit-everything.** Multi-tenant SaaS with row-level security and an immutable activity log.

### 1.1 Personas

| Persona | Primary jobs | Primary surfaces |
|---|---|---|
| Sales Agent | Work the queue, call/WhatsApp, book site visits, update status | Focus Queue, Lead Workspace, Inbox |
| Team Lead / Sales Manager | Monitor SLAs, reassign, coach, approve bookings | Team Dashboard, Allocation Board, Talk-time |
| Admin / Ops | Configure sources, rules, pipelines, users, integrations | Settings, Rule Builder |
| Owner / Director | Revenue, source ROI, funnel health | Executive Dashboard, Reports |
| Listing / Inventory Manager | Maintain projects, units, off-plan payment plans | Inventory module |

---

## 2. Information Architecture & Navigation

### 2.1 Workspace grouping [LeadVolt]

The incumbent's 14 flat modules are consolidated into five workspaces in a collapsible left rail (icons + labels, collapses to 64 px):

```
┌ Home ──────────── Dashboard, My Day (tasks + reminders), Attendance clock-in
├ Pipeline ──────── Leads, Focus Queue, Allocation Board, Data (cold/imported lists)
├ Conversations ─── Inbox (WhatsApp / Email / SMS), Calls, Templates
├ Inventory ─────── Projects, Units/Listings, Off-Plan (payment plans), Brochures
└ Business ──────── Deals & Invoices, Reports, Team, Settings, AI Assistant
```

### 2.2 Global chrome

- **Top bar:** workspace title · global search (`/`) · command palette (`Ctrl/Cmd+K`) · "+ New" menu (Lead, Task, Site Visit, Deal) · notifications bell (real-time) · clock-in status pill · user menu.
- **Scope switcher** (persisted per user): `Me · My Team · Org` + optional agent multi-select. Applies to every dashboard and list (mirrors the observed "My Team Dashboard / Agents" control, but global).
- **Subscription / licence banner** shown only to admins.

### 2.3 Command palette actions (examples)

`Go to lead…`, `Assign to…`, `Change status…`, `Log call`, `Send WhatsApp template…`, `Schedule site visit`, `Match properties`, `Share brochure`, `Open saved view…`, `Toggle dark mode`.

---

## 3. UI Layouts & Interaction Patterns

### 3.1 Lead List → Split-Screen Workspace [LeadVolt evolution of Observed slide-over]

```
┌──────────────── Left: Lead list (40%) ───────────────┬──────────── Right: Lead Workspace (60%) ────────────┐
│ [Scope: All | Mine | Team | Unassigned | Dup | Re-enq]│ Header: name · temp tag · stage · owner · SLA timer  │
│ [Queue: Active | New | Pending | Scheduled | Overdue ]│ Quick bar: Call  WhatsApp  Email  Task  Visit  Match │
│ [Saved view ▾] [Search…] [Facets ▾] [Columns] [Export]│ Tabs: Timeline | Details | Requirements | Matches   │
│ ─────────────────────────────────────────────────────│       | Deals | Documents                            │
│ ▸ ● Lead A   Bayut/WA   Callback·Follow-up  2h overdue│                                                     │
│   ● Lead B   IVR        New                 3m ago    │ Timeline (unified, newest first)                    │
│   ...  (virtualised, infinite scroll, 50 rows/page)   │ Composer (note / WhatsApp / email) pinned bottom    │
└───────────────────────────────────────────────────────┴─────────────────────────────────────────────────────┘
```

- Selecting a row loads the workspace on the right without navigation; URL updates to `/leads/:id` for deep-linking.
- Below 1280 px width the workspace becomes a slide-over (the observed pattern); below 768 px it is a full-screen sheet.
- Row density modes: Comfortable / Compact. Rows show badges for meeting-done / not-done counts, unread message count, duplicate/re-enquiry flag, SLA timer.
- Row actions collapse the observed ~10 icons into **3 visible actions** (Call, WhatsApp, Disposition) + an overflow menu.

### 3.2 Hotkeys

| Key | Action | Key | Action |
|---|---|---|---|
| `J` / `K` | Next / previous lead | `D` | Open disposition popup |
| `Enter` | Open lead workspace | `1`–`7` | Pick disposition chip (in popup) |
| `C` | Click-to-call (softphone/IVR) | `Shift+Enter` | Save & Next |
| `W` | WhatsApp composer | `N` | Add note |
| `E` | Email composer | `T` | New task (slide-over) |
| `A` | Assign / re-assign | `V` | Schedule site visit |
| `M` | Run property match | `X` | Select row (bulk) |
| `/` | Search | `Ctrl/Cmd+K` | Command palette |
| `Esc` | Close panel | `?` | Hotkey cheat-sheet |

Hotkeys are disabled while focus is in a text input; all are remappable per user.

### 3.3 Quick-Disposition Popup [Observed pattern, LeadVolt rules]

Anchored modal (≤ 480 px), opened with `D` or the row's Disposition button.

```
Current: Callback › Follow-up · due 14 Oct 14:01 (overdue)
──────────────────────────────────────────────
[1 Callback] [2 Meeting] [3 Site Visit] [4 Booked]
[5 EOI]      [6 Not Interested] [7 Drop]
Sub-status:  [Follow-up ▾]  (dependent on chip)
Next action: [📅 Tomorrow 11:00 ▾]   ← required for active stages
Reason:      [▾] (required for Not Interested / Drop)
Assign to:   [Agent ▾]
Note:        [______________________________]
             [Cancel]   [Save & Close]  [Save & Next ⇧↵]
```

Validation rules:
- `Callback`, `Meeting`, `Site Visit` → `next_action_at` required; auto-creates a Task.
- `Site Visit` → requires project/unit and meeting point; sends confirmation template to lead (opt-in).
- `Booked` → opens Deal sub-form (unit, deal value, commission %) and moves to approval.
- `Not Interested` / `Drop` → reason code required; lead moves to inactive pool and is eligible for re-nurture.
- **Save & Next** advances to the next lead in the *current filtered queue* (preserves queue context).

### 3.4 Slide-over Task Panel

Right-edge panel (420 px) for creating/editing tasks without leaving context: type (Call, WhatsApp, Meeting, Site Visit, Document, Custom), due date with natural-language input ("tomorrow 4pm"), linked lead/property, assignee, priority, reminder offsets (−15m, −1h, −1d), recurrence. Stacks above the lead workspace; `Esc` closes.

### 3.5 Dashboard Widgets [Observed set, LeadVolt enhancements]

Configurable 12-column grid (drag/resize, "Edit widgets", per-user and per-role default layouts). Every number is clickable and opens the lead list pre-filtered.

| Widget | Content | Enhancement |
|---|---|---|
| Lead Totals | Total, Active, Inactive; tabs All/Deleted/Duplicate | Sparkline + real-time increment |
| Status KPI tiles | Callback, Overdue, Meeting Done, Site Visit Done, Booked, Invoiced + period-over-period chip | Configurable status list |
| Revenue | Total + Today / 7d / 30d / Quarter, currency-aware (AED default) | Forecast from pipeline weighted value |
| Leads vs Source | Donut of top N sources, contribution %, revenue per source | Cost-per-lead & ROI if spend imported |
| Lead Funnel | Leads → Prospect → Opportunity → Booked → Invoiced with conversion % | Stage-to-stage time, drop-off reasons |
| Top Closers | Agent cards: leads, EOI, booked, meetings, site visits, deal value, brokerage, conversion % | Sort by any metric; leaderboard mode |
| New Lead Intake | Total / Data-converted / Direct | Speed-to-lead median & p90 |
| Reminders | Upcoming tasks/events | Inline complete / snooze |
| Agent Talk-time | Per agent: total/connected calls, in/out counts, answered/missed, durations | Heatmap by hour; max/min outliers |
| Attendance | Clock-in/out card with time & geo | Shift adherence |
| **SLA Monitor** [new] | Leads breaching first-response SLA, by agent | One-click reassign |

### 3.6 Filtering & Saved Views

The observed advanced filter exposes ~90 fields in one modal. LeadVolt replaces it with:

1. **Facet bar** (always visible): Owner, Stage, Sub-status, Source, Temperature, Date (created / modified / next action / last contact), Project.
2. **Query builder** ("+ Add filter") over all lead fields grouped as: Assignment · Status & Source · Requirements (type, beds, baths, budget, area, furnishing, offering type, possession) · Location (community, sub-community, tower, city, radius) · People (created by, booked by, sourcing/closing manager) · Marketing (UTM, campaign, agency, channel partner) · Profile (nationality, profession) · Calls (direction, status, duration, made by).
3. Operators: `is / is not / any of / between / before / after / within last N days / is empty`.
4. **Saved views** (personal or shared), pinned as tabs; queue tabs (New / Pending / Scheduled / Overdue / EOI) are system saved views.
5. Filter state serialised to URL (`?q=` base64 JSON) for sharing.

---

## 4. Core Feature Modules & Workflows

### 4.1 Lead Capture

**Source adapters** (each a stateless worker that normalises payloads into `LeadIntakeEvent`):

| Adapter | Mechanism |
|---|---|
| Portals (Bayut, PropertyFinder, Dubizzle, etc.) | Webhook or email-parse or polling per portal's offering; maps listing reference → `property_id` |
| Meta Lead Ads | Webhook + Graph API fetch |
| Google Ads lead forms | Webhook |
| IVR / virtual numbers | Call-event webhook → lead keyed on caller number; tracks DID → source/sub-source |
| WhatsApp Business (Cloud API) | Inbound message from unknown number → lead |
| Website forms / landing pages | Public JS SDK + signed endpoint, UTM capture |
| Channel partners | Partner portal / API key per partner |
| Bulk import ("Data") | CSV/XLSX with column mapping; imported rows live in a *Data* pool until "converted" to leads |
| Manual | "+ New Lead" form, duplicate check inline |

**Intake pipeline:**

```
Adapter → intake queue → Normalise (E.164 phone, email lower-case, name cleanup)
        → Dedupe (phone OR email within tenant, configurable window)
              ├─ duplicate & active → append enquiry to existing lead, flag "Re-enquired", notify owner
              └─ new → create Lead
        → Enrich (country from phone code, project from listing ref, UTM)
        → Score → Allocate → Notify (push + WebSocket + optional WhatsApp auto-reply)
```

### 4.2 Pipeline & Stages

Configurable per tenant; default model maps the observed statuses into stages:

| Stage (`stage`) | Default sub-statuses | Funnel bucket |
|---|---|---|
| `new` | Untouched | Lead |
| `contacted` | Callback · Follow-up, WhatsApp sent, Not reachable, Busy | Prospect |
| `meeting_scheduled` | Online, Office | Prospect |
| `site_visit_scheduled` | Scheduled, Rescheduled | Opportunity |
| `site_visit_done` / `meeting_done` | — (outcome flags: done / not done) | Opportunity |
| `eoi` | Expression of Interest received | Opportunity |
| `booked` | Pending approval, Approved | Booked |
| `invoiced` | Invoice raised, Paid | Invoiced |
| `closed_lost` | Not interested, Drop (reason code) | — |

Rules: stage transitions are validated by a tenant-configurable state machine (`pipeline_transitions` table); every transition writes an `interaction` of type `status_change`.

### 4.3 Lead Scoring [LeadVolt]

`score ∈ [0,100]`, recomputed on every relevant event; displayed with temperature tag (Cold < 40 ≤ Warm < 70 ≤ Hot; agents may override tag manually — observed Cold/Warm/Hot tags).

```
score = clamp( Σ w_i · f_i , 0, 100 )

f_source_quality      historical conversion rate of source/sub-source (0–1)
f_budget_fit          budget vs. matched inventory median price
f_requirement_complete % of requirement fields filled
f_engagement          replies, call connects, brochure opens (decayed, half-life 7d)
f_recency             1 / (1 + days_since_last_inbound)
f_reenquiry           +1 if re-enquired within 90 days
f_negative            unreachable attempts, opt-out
```

Weights live in `scoring_models` (versioned). v2: gradient-boosted model trained per tenant once ≥ 2 000 closed leads exist; v1 rules remain as fallback.

### 4.4 Allocation Rules

Rule engine evaluated in priority order; first matching rule assigns.

```json
{
  "id": "rule_offplan_bayut",
  "priority": 10,
  "conditions": { "all": [
    { "field": "source", "op": "in", "value": ["bayut", "property_finder"] },
    { "field": "requirements.offering_type", "op": "eq", "value": "off_plan" },
    { "field": "score", "op": "gte", "value": 50 }
  ]},
  "strategy": "round_robin",            // round_robin | weighted | least_loaded | sticky_owner | manual_pool
  "pool": { "team_id": "team_offplan", "only_clocked_in": true, "respect_capacity": true },
  "sla": { "first_response_minutes": 5, "escalate_to": "team_lead", "reassign_after_minutes": 15 },
  "working_hours": { "tz": "Asia/Dubai", "fallback_pool": "team_night" }
}
```

- **Sticky owner:** re-enquiries return to the original owner if active.
- **Capacity:** max open leads per agent; `least_loaded` uses live count.
- **Attendance-aware:** only agents clocked in (Attendance module) receive leads when `only_clocked_in`.
- **SLA timers** run in the scheduler; breach → notification → optional auto-reassign, logged as `assignment` interaction with reason `sla_breach`.
- Full assignment history (from, to, by, reason) — supports the observed filters "Assigned From / Assignment Done By / Original Owner".

### 4.5 Communication & Activity

#### 4.5.1 Multi-agent WhatsApp Inbox [LeadVolt]

```
┌ Channels/filters ─┬──── Conversation list ────┬──────── Thread ─────────────┬─ Lead context ─┐
│ All · Mine · Team │ ● Lead A  "Is unit 1204…" │ bubbles, media, templates   │ stage, owner   │
│ Unassigned        │   2m · Bayut · 🔴 SLA 3m  │ internal notes (yellow)     │ requirements   │
│ Waiting on us     │ ● Lead B  "Thanks"        │ @mentions to teammates      │ top 3 matches  │
│ Snoozed · Closed  │   ...                     │ composer: text / template / │ quick dispose  │
│ Numbers ▾         │                           │ brochure / location / voice │                │
└───────────────────┴───────────────────────────┴─────────────────────────────┴────────────────┘
```

- WhatsApp Business Platform (Cloud API); multiple business numbers per tenant, each mapped to teams.
- **Conversation ownership** follows lead owner; collision lock ("Agent X is typing") via presence channel.
- 24-hour customer-service window enforced: outside it only approved templates can be sent; UI shows countdown.
- Template library with variables (`{{lead.first_name}}`, `{{property.name}}`, `{{visit.time}}`), approval status synced from provider.
- Opt-in / opt-out tracked per contact (`consents` table); STOP keywords auto-handled.
- Inbound media stored in object storage, virus-scanned, linked to lead documents.
- Auto-acknowledgement on new portal lead (configurable, within business rules).

#### 4.5.2 Calls

- Click-to-call via cloud telephony / IVR provider or mobile app dialer bridge.
- Call events (ringing, answered, ended, recording URL) via webhook → `interactions(type='call')`.
- **Post-call disposition** popup opens automatically when the call ends (connected / not answered / busy / wrong number + stage disposition).
- Talk-time analytics as in observed widget: total, connected, in/out, answered/missed, durations per agent.

#### 4.5.3 Notes, Email, Documents

- Notes with @mentions, pinned notes, and **confidential notes** (visible to owner + managers only — observed filter "Confidential Notes").
- Email via connected Google/Microsoft mailbox (OAuth) or tenant SMTP; threads linked by lead email.
- Documents tab: KYC (passport/Emirates ID uploads — encrypted, restricted access), offers, SPA drafts, brochures sent.

#### 4.5.4 Task Queues

- Task types: call, whatsapp, meeting, site_visit, follow_up, document, custom.
- Queues: **Today · Overdue · Upcoming · Completed**; "My Day" view on Home.
- Overdue = `due_at < now() AND status='open'` — drives the observed Overdue KPI and queue tab.
- Reminders via push, in-app, and optional WhatsApp to agent.

### 4.6 Property & Inventory Matching

#### 4.6.1 Inventory model
Projects (developer, community, handover date, payment plans), Units/Listings (type, beds, baths, areas, floor, view, furnishing, price, status available/reserved/sold), Off-plan payment plans (milestone %), media and brochures.

#### 4.6.2 Lead requirement capture
`requirements` JSONB on lead: purpose (buy/rent/invest), offering type (ready/off-plan), property types, beds/baths ranges, budget min/max + currency, area range, communities (array), furnishing, floor preference, possession window, payment-plan preference.

#### 4.6.3 Matching algorithm

1. **Hard filters (SQL):** status = available; price within `[budget_min·0.9, budget_max·1.1]`; property type ∈ wanted; beds within range; offering type match.
2. **Soft scoring (0–100):**

```
match = 35·price_fit + 20·location_fit + 15·beds_baths_fit + 10·area_fit
      + 10·possession_fit + 5·amenity_overlap + 5·freshness

price_fit      = 1 − |price − budget_mid| / budget_mid  (clamped)
location_fit   = 1 if community ∈ wanted; 0.6 if same parent area; else geo-decay by km
possession_fit = 1 if handover within window; linear decay over 12 months
```

3. Return top 20 with explanation chips ("Within budget", "Preferred community", "Handover Q2 2027").
4. **Reverse matching:** when a new unit is added or price drops, find leads with `match ≥ 70` and notify owners ("3 leads match new listing").

Implementation: Postgres with `pg_trgm` + PostGIS for location; candidate set via SQL, scoring in the matching service; optional pgvector embedding of free-text requirements.

#### 4.6.4 Brochure sharing
- Select 1–5 matched units → "Share" → channel (WhatsApp / email / link).
- Generates a tracked short link (`lv.link/abc123`) to a mobile micro-page (unit cards, brochure PDF, payment plan, floor plan, CTA "Book a visit").
- Tracks opens, time on page, PDF downloads → engagement events feed lead score and notify the agent in real time ("Lead opened brochure").

### 4.7 Deals, Booking & Invoicing
Booked → Deal record (unit, deal value, commission %, co-broker split, approvals) → Invoice (to developer/client), payment status → feeds revenue widgets ("Total Revenue", brokerage earned, deal value).

### 4.8 Attendance & Team
Clock-in/out with optional geofence and selfie; shift schedules; drives allocation eligibility. Teams with hierarchy (org → team → sub-team), team leads, capacity settings.

### 4.9 Reports
Standard: Source performance, Agent performance, Funnel conversion, Stage aging, SLA compliance, Call activity, Site-visit report, Revenue. Custom report builder over the analytics warehouse; scheduled email exports (CSV/XLSX/PDF).

### 4.10 AI Assistant [LeadVolt]
- Lead summary ("what happened so far") from timeline.
- Suggested next best action and WhatsApp reply drafts (agent must approve before send).
- Natural-language filters ("hot off-plan leads in Dubai Hills over 3M with no contact in 3 days").
- Call transcription + summary (with consent notice).

---

## 5. Data Schemas (PostgreSQL 16)

Conventions: UUIDv7 primary keys; every table has `tenant_id` with Row-Level Security; `created_at`, `updated_at` timestamptz; soft delete via `deleted_at`; money as `numeric(14,2)` + `currency char(3)`.

### 5.1 Tenancy & Users

```sql
CREATE TABLE tenants (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  slug          text UNIQUE NOT NULL,           -- subdomain
  default_currency char(3) NOT NULL DEFAULT 'AED',
  timezone      text NOT NULL DEFAULT 'Asia/Dubai',
  plan          text NOT NULL,
  plan_expires_at timestamptz,
  settings      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id         uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL,
  parent_id  uuid REFERENCES teams(id),
  lead_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('owner','admin','manager','agent','listing_manager','viewer');

CREATE TABLE users (                                   -- Agents/Users
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  email         citext NOT NULL,
  full_name     text NOT NULL,
  phone_e164    text,
  role          user_role NOT NULL DEFAULT 'agent',
  team_id       uuid REFERENCES teams(id),
  reports_to    uuid REFERENCES users(id),
  rera_brn      text,                                 -- broker registration no.
  capacity_max_open_leads int DEFAULT 200,
  is_active     boolean NOT NULL DEFAULT true,
  is_clocked_in boolean NOT NULL DEFAULT false,       -- denormalised from attendance
  working_hours jsonb,                                -- {"mon":[["09:00","18:00"]],...}
  preferences   jsonb NOT NULL DEFAULT '{}',          -- hotkeys, density, dashboard layout
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  UNIQUE (tenant_id, email)
);
```

### 5.2 Leads

```sql
CREATE TYPE lead_temperature AS ENUM ('cold','warm','hot');

CREATE TABLE contacts (                                -- a person; one contact may have many leads
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  full_name   text,
  phone_e164  text,
  alt_phone_e164 text,
  email       citext,
  nationality char(2),
  profession  text,
  gender      text,
  dob         date,
  attributes  jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_contacts_phone ON contacts(tenant_id, phone_e164) WHERE phone_e164 IS NOT NULL;
CREATE INDEX ix_contacts_email ON contacts(tenant_id, email);

CREATE TABLE leads (
  id               uuid PRIMARY KEY,
  tenant_id        uuid NOT NULL,
  serial_no        bigint NOT NULL,                  -- human-readable, per-tenant sequence
  contact_id       uuid NOT NULL REFERENCES contacts(id),
  owner_id         uuid REFERENCES users(id),        -- NULL = unassigned
  original_owner_id uuid REFERENCES users(id),
  team_id          uuid REFERENCES teams(id),
  sourcing_manager_id uuid REFERENCES users(id),
  closing_manager_id  uuid REFERENCES users(id),

  pipeline_id      uuid NOT NULL,
  stage            text NOT NULL DEFAULT 'new',
  sub_status       text,
  is_active        boolean GENERATED ALWAYS AS (stage NOT IN ('closed_lost','invoiced')) STORED,
  lost_reason      text,

  source           text NOT NULL,                    -- bayut | property_finder | facebook | ivr | ...
  sub_source       text,                             -- e.g. 'whatsapp', 'call', DID number
  channel_partner_id uuid,
  campaign         jsonb,                            -- {utm_source, utm_medium, utm_campaign, ...}
  listing_ref      text,                             -- portal listing reference
  property_id      uuid,                             -- enquired unit, if resolved
  project_id       uuid,

  requirements     jsonb NOT NULL DEFAULT '{}',      -- see 5.2.1
  score            smallint NOT NULL DEFAULT 0 CHECK (score BETWEEN 0 AND 100),
  temperature      lead_temperature,
  temperature_overridden boolean NOT NULL DEFAULT false,
  tags             text[] NOT NULL DEFAULT '{}',

  is_duplicate     boolean NOT NULL DEFAULT false,
  duplicate_of     uuid REFERENCES leads(id),
  reenquiry_count  int NOT NULL DEFAULT 0,
  last_reenquired_at timestamptz,

  meeting_done_count      int NOT NULL DEFAULT 0,
  meeting_not_done_count  int NOT NULL DEFAULT 0,
  site_visit_done_count   int NOT NULL DEFAULT 0,
  site_visit_not_done_count int NOT NULL DEFAULT 0,

  first_response_at timestamptz,
  last_contacted_at timestamptz,
  last_inbound_at   timestamptz,
  next_action_at    timestamptz,                     -- from earliest open task
  sla_due_at        timestamptz,
  communication_count int NOT NULL DEFAULT 0,

  created_by     uuid,
  updated_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  deleted_by     uuid,
  version        int NOT NULL DEFAULT 1,             -- optimistic locking
  UNIQUE (tenant_id, serial_no)
);

CREATE INDEX ix_leads_queue    ON leads(tenant_id, owner_id, stage, next_action_at) WHERE deleted_at IS NULL;
CREATE INDEX ix_leads_unassigned ON leads(tenant_id, created_at) WHERE owner_id IS NULL AND deleted_at IS NULL;
CREATE INDEX ix_leads_source   ON leads(tenant_id, source, sub_source, created_at);
CREATE INDEX ix_leads_req_gin  ON leads USING gin (requirements jsonb_path_ops);
CREATE INDEX ix_leads_tags     ON leads USING gin (tags);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON leads USING (tenant_id = current_setting('app.tenant_id')::uuid);
```

#### 5.2.1 `requirements` JSON Schema

```json
{
  "$id": "https://schemas.leadvolt.io/lead-requirements.json",
  "type": "object",
  "properties": {
    "purpose":        { "enum": ["buy", "rent", "invest"] },
    "offering_type":  { "enum": ["ready", "off_plan", "any"] },
    "property_types": { "type": "array", "items": { "enum": ["apartment","villa","townhouse","penthouse","plot","office","retail"] } },
    "beds":   { "type": "object", "properties": { "min": {"type":"integer"}, "max": {"type":"integer"} } },
    "baths":  { "type": "object", "properties": { "min": {"type":"integer"}, "max": {"type":"integer"} } },
    "budget": { "type": "object", "properties": { "min": {"type":"number"}, "max": {"type":"number"}, "currency": {"type":"string","default":"AED"} } },
    "area_sqft": { "type": "object", "properties": { "min": {"type":"number"}, "max": {"type":"number"} } },
    "communities": { "type": "array", "items": { "type": "string" } },
    "geo": { "type": "object", "properties": { "lat": {"type":"number"}, "lng": {"type":"number"}, "radius_km": {"type":"number"} } },
    "furnishing": { "enum": ["furnished","semi","unfurnished","any"] },
    "preferred_floor": { "enum": ["low","mid","high","any"] },
    "possession_by": { "type": "string", "format": "date" },
    "payment_plan_required": { "type": "boolean" },
    "notes": { "type": "string", "maxLength": 2000 }
  },
  "additionalProperties": false
}
```

#### 5.2.2 Supporting tables

```sql
CREATE TABLE lead_enquiries (          -- every intake event incl. re-enquiries
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, lead_id uuid NOT NULL REFERENCES leads(id),
  source text NOT NULL, sub_source text, listing_ref text, raw_payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lead_assignments (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, lead_id uuid NOT NULL REFERENCES leads(id),
  from_user_id uuid, to_user_id uuid, assigned_by uuid, rule_id uuid,
  reason text CHECK (reason IN ('rule','manual','sla_breach','reenquiry_sticky','bulk','deactivation')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pipelines (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text, is_default boolean);
CREATE TABLE pipeline_stages (
  id uuid PRIMARY KEY, pipeline_id uuid REFERENCES pipelines(id), key text, label text,
  position int, funnel_bucket text, requires_next_action boolean, requires_reason boolean,
  sub_statuses jsonb
);
CREATE TABLE pipeline_transitions (pipeline_id uuid, from_key text, to_key text, PRIMARY KEY (pipeline_id, from_key, to_key));

CREATE TABLE allocation_rules (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text, priority int, is_enabled boolean,
  definition jsonb NOT NULL, version int NOT NULL DEFAULT 1, updated_by uuid, updated_at timestamptz
);
CREATE TABLE scoring_models (id uuid PRIMARY KEY, tenant_id uuid, version int, weights jsonb, is_active boolean);
CREATE TABLE saved_views (id uuid PRIMARY KEY, tenant_id uuid, owner_id uuid, name text, entity text,
  query jsonb, columns jsonb, sort jsonb, is_shared boolean, position int);
```

### 5.3 Properties / Inventory

```sql
CREATE TABLE projects (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  name text NOT NULL, developer text, community text, sub_community text, city text, country char(2),
  location geography(Point,4326),
  status text CHECK (status IN ('pre_launch','launched','under_construction','ready')),
  handover_date date, payment_plans jsonb,       -- [{name, milestones:[{label, pct, due}]}]
  amenities text[], media jsonb, brochure_file_id uuid,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz
);

CREATE TABLE properties (                       -- units / listings
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
  project_id uuid REFERENCES projects(id),
  reference text,                               -- internal ref; portal refs in portal_refs
  portal_refs jsonb NOT NULL DEFAULT '{}',      -- {"bayut":"...","property_finder":"..."}
  offering_type text CHECK (offering_type IN ('ready','off_plan')),
  purpose text CHECK (purpose IN ('sale','rent')),
  property_type text NOT NULL, property_sub_type text,
  unit_number text, tower text, floor int,
  beds smallint, baths smallint,
  area_builtup_sqft numeric(10,2), area_carpet_sqft numeric(10,2), area_plot_sqft numeric(10,2),
  furnishing text, view text, parking smallint,
  price numeric(14,2) NOT NULL, currency char(3) NOT NULL DEFAULT 'AED',
  price_per_sqft numeric(10,2) GENERATED ALWAYS AS (price / NULLIF(area_builtup_sqft,0)) STORED,
  community text, sub_community text, location geography(Point,4326),
  handover_date date,
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','reserved','sold','rented','off_market')),
  permit_number text,                           -- advertising permit
  listing_agent_id uuid REFERENCES users(id),
  amenities text[], media jsonb, brochure_file_id uuid,
  description_embedding vector(768),            -- pgvector, optional
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), deleted_at timestamptz
);
CREATE INDEX ix_props_match ON properties(tenant_id, status, property_type, beds, price);
CREATE INDEX ix_props_geo   ON properties USING gist (location);

CREATE TABLE lead_property_matches (
  lead_id uuid, property_id uuid, tenant_id uuid NOT NULL,
  score smallint, reasons text[], computed_at timestamptz DEFAULT now(),
  status text DEFAULT 'suggested' CHECK (status IN ('suggested','shared','liked','rejected','visited')),
  PRIMARY KEY (lead_id, property_id)
);

CREATE TABLE share_links (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, code text UNIQUE NOT NULL,
  lead_id uuid, created_by uuid, property_ids uuid[], channel text,
  expires_at timestamptz, open_count int DEFAULT 0, last_opened_at timestamptz,
  created_at timestamptz DEFAULT now()
);
```

### 5.4 Interactions (unified timeline)

Append-only, partitioned monthly.

```sql
CREATE TYPE interaction_type AS ENUM (
  'call','whatsapp','email','sms','note','status_change','assignment',
  'meeting','site_visit','brochure_shared','brochure_opened','document','system');

CREATE TABLE interactions (
  id           uuid NOT NULL,
  tenant_id    uuid NOT NULL,
  lead_id      uuid NOT NULL,
  user_id      uuid,                         -- actor (NULL for lead/system)
  type         interaction_type NOT NULL,
  direction    text CHECK (direction IN ('inbound','outbound','internal')),
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  summary      text,                         -- one-line for timeline
  payload      jsonb NOT NULL DEFAULT '{}',  -- type-specific, see below
  is_confidential boolean NOT NULL DEFAULT false,
  external_id  text,                         -- provider message/call id (idempotency)
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);
CREATE INDEX ix_interactions_lead ON interactions(tenant_id, lead_id, occurred_at DESC);
CREATE UNIQUE INDEX ux_interactions_ext ON interactions(tenant_id, type, external_id, occurred_at) WHERE external_id IS NOT NULL;
```

Payload examples:

```json
// call
{ "provider": "ivr_x", "from": "+9715XXXXXXX", "to": "+9714XXXXXXX", "status": "answered",
  "duration_sec": 312, "recording_file_id": "…", "disposition": "callback", "transcript_id": null }

// whatsapp
{ "conversation_id": "…", "wa_message_id": "wamid.…", "kind": "template",
  "template": { "name": "site_visit_confirm", "lang": "en", "vars": ["Ahmed","Sat 11:00"] },
  "delivery": "read", "media": [] }

// status_change
{ "from": { "stage": "contacted", "sub_status": "follow_up" },
  "to":   { "stage": "site_visit_scheduled", "sub_status": "scheduled" },
  "reason": null, "task_id": "…" }

// site_visit
{ "project_id": "…", "property_ids": ["…"], "scheduled_at": "2026-10-24T11:00:00+04:00",
  "outcome": "done", "feedback": "Liked layout; budget stretch" }
```

### 5.5 Tasks

```sql
CREATE TABLE tasks (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  lead_id      uuid REFERENCES leads(id),
  property_id  uuid,
  assignee_id  uuid NOT NULL REFERENCES users(id),
  created_by   uuid,
  type         text NOT NULL CHECK (type IN ('call','whatsapp','meeting','site_visit','follow_up','document','custom')),
  title        text NOT NULL,
  notes        text,
  priority     smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  due_at       timestamptz NOT NULL,
  remind_offsets_min int[] NOT NULL DEFAULT '{15}',
  recurrence   text,                          -- RFC 5545 RRULE
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled','snoozed')),
  completed_at timestamptz,
  outcome      text,
  source_interaction_id uuid,                 -- disposition that spawned it
  created_at   timestamptz DEFAULT now(),
  updated_at   timestamptz DEFAULT now()
);
CREATE INDEX ix_tasks_queue ON tasks(tenant_id, assignee_id, status, due_at);
```

### 5.6 Conversations, Deals, Attendance, Audit (abridged)

```sql
CREATE TABLE wa_numbers (id uuid PRIMARY KEY, tenant_id uuid, phone_e164 text, provider_ref text, team_id uuid, display_name text);
CREATE TABLE conversations (
  id uuid PRIMARY KEY, tenant_id uuid, lead_id uuid, channel text, wa_number_id uuid,
  assignee_id uuid, status text CHECK (status IN ('open','waiting','snoozed','closed')),
  last_inbound_at timestamptz, window_expires_at timestamptz, unread_count int DEFAULT 0
);
CREATE TABLE consents (id uuid PRIMARY KEY, tenant_id uuid, contact_id uuid, channel text, status text, source text, captured_at timestamptz);

CREATE TABLE deals (
  id uuid PRIMARY KEY, tenant_id uuid, lead_id uuid, property_id uuid,
  deal_value numeric(14,2), currency char(3), commission_pct numeric(5,2),
  brokerage_amount numeric(14,2), splits jsonb, status text, approved_by uuid, booked_at timestamptz
);
CREATE TABLE invoices (id uuid PRIMARY KEY, tenant_id uuid, deal_id uuid, number text, amount numeric(14,2), currency char(3), status text, issued_at date, paid_at date);

CREATE TABLE attendance (id uuid PRIMARY KEY, tenant_id uuid, user_id uuid, clock_in_at timestamptz, clock_out_at timestamptz, geo geography(Point,4326), device jsonb);

CREATE TABLE audit_log (id bigserial PRIMARY KEY, tenant_id uuid, actor_id uuid, entity text, entity_id uuid, action text, diff jsonb, ip inet, at timestamptz DEFAULT now());
```

---

## 6. System Architecture

### 6.1 High-level

```
                 ┌──────────── Web (React/Next.js) ── Mobile (React Native) ── Public share pages ───────────┐
                 │                                                                                         │
           HTTPS/GraphQL/REST                               WSS (Socket gateway)                           │
                 ▼                                                ▼                                        │
        ┌─────────────────┐   ┌──────────────────────┐   ┌───────────────────┐                             │
        │ API Gateway     │──▶│ Core API (modular     │──▶│ Realtime Gateway  │◀── Redis Pub/Sub / NATS ◀──┐ │
        │ (auth, rate lim)│   │ monolith, TypeScript/ │   │ (presence, rooms) │                            │ │
        └─────────────────┘   │ NestJS or Go)         │   └───────────────────┘                            │ │
                              └──────────┬───────────┘                                                     │ │
                                         │ outbox events                                                   │ │
                                         ▼                                                                 │ │
     Webhooks ─▶ Intake Service ─▶ Event Bus (Kafka / NATS JetStream) ─▶ Workers: Dedupe · Scoring ·       │ │
   (portals, IVR,                                                       Allocation · SLA Scheduler ·       │ │
    Meta, WA Cloud)                                                     Matching · Notifications · Search ─┘ │
                                         │                                                                   │
            ┌────────────────────────────┼───────────────────────────────┐                                   │
            ▼                            ▼                               ▼                                   │
     PostgreSQL 16 (primary +    OpenSearch (lead/property      Object storage (S3-compatible,              │
     read replicas, PostGIS,     full-text & facets)            media, recordings, documents)               │
     pgvector, RLS)                                                                                         │
            │ CDC (Debezium)                                                                                │
            ▼                                                                                               │
     Analytics warehouse (ClickHouse) ─▶ Dashboards & Reports API ──────────────────────────────────────────┘
```

- **Modular monolith first** (modules: identity, leads, inventory, comms, tasks, deals, analytics); extract Intake, Realtime and Comms as separate services once load requires.
- **Transactional outbox** guarantees every DB write that matters publishes a domain event exactly once to the bus.
- **Region:** UAE data residency (e.g. a cloud region in the UAE) for PII; backups encrypted, cross-AZ.

### 6.2 Domain events

`lead.created`, `lead.updated`, `lead.stage_changed`, `lead.assigned`, `lead.reenquired`, `lead.score_changed`, `interaction.created`, `message.received`, `message.status`, `call.started`, `call.ended`, `task.created`, `task.due_soon`, `task.overdue`, `sla.breached`, `property.created`, `property.price_changed`, `match.found`, `share_link.opened`, `deal.booked`, `invoice.paid`, `attendance.clock_in`.

Envelope:

```json
{ "id": "evt_01J…", "type": "lead.assigned", "tenant_id": "…", "occurred_at": "2026-10-20T16:13:05Z",
  "actor": { "type": "rule", "id": "rule_offplan_bayut" },
  "data": { "lead_id": "…", "from_user_id": null, "to_user_id": "…", "reason": "rule" },
  "version": 1 }
```

---

## 7. API Design

### 7.1 Conventions
- REST under `/api/v1`, JSON, cursor pagination (`?cursor=&limit=50`), `ETag`/`If-Match` (maps to `leads.version`) for optimistic concurrency, `Idempotency-Key` on POST.
- Auth: OAuth 2.1 / OIDC; short-lived JWT (15 min) + refresh; tenant resolved from subdomain + token claim. Fine-grained RBAC scopes (`leads:read:own`, `leads:read:team`, `leads:write`, `leads:export`, `settings:admin`).
- GraphQL `/graphql` for composite read screens (lead workspace, dashboard); mutations stay on REST to keep business rules in one place.
- Rate limits per tenant & user; exports are async jobs.

### 7.2 REST endpoints

| Method & Path | Purpose |
|---|---|
| `POST /intake/{adapter}` | Signed webhook intake (portal, IVR, Meta, web form) |
| `GET /leads` | List; params: `view_id`, `q` (filter JSON), `scope=mine|team|org|unassigned|duplicate|reenquired|deleted`, `queue=new|pending|scheduled|overdue|eoi`, `sort`, `cursor` |
| `POST /leads` | Create (manual) — returns `409` with candidate duplicates unless `force=true` |
| `GET /leads/{id}` | Lead detail |
| `PATCH /leads/{id}` | Update fields / requirements (If-Match required) |
| `POST /leads/{id}/disposition` | Atomic: stage + sub-status + next task + note + optional reassignment |
| `POST /leads/{id}/assign` | Assign / re-assign |
| `POST /leads/bulk` | Bulk assign / stage / tag / delete (async job id) |
| `POST /leads/{id}/merge` | Merge duplicate into target |
| `DELETE /leads/{id}` · `POST /leads/{id}/restore` | Soft delete / restore |
| `GET /leads/{id}/timeline` | Interactions, cursor-paged |
| `POST /leads/{id}/notes` | Add note (`confidential` flag) |
| `POST /leads/{id}/calls` | Initiate click-to-call |
| `GET /leads/{id}/matches` · `POST /leads/{id}/matches/refresh` | Property matching |
| `POST /leads/{id}/share` | Create brochure share link + send via channel |
| `GET /leads/counts` | Badge counts per scope/queue (for tab chips) |
| `POST /exports` · `GET /exports/{id}` | Async CSV/XLSX export |
| `GET/POST /tasks`, `PATCH /tasks/{id}`, `POST /tasks/{id}/complete`, `POST /tasks/{id}/snooze` | Tasks |
| `GET /conversations` · `GET /conversations/{id}/messages` · `POST /conversations/{id}/messages` | Inbox |
| `POST /conversations/{id}/assign` · `POST /conversations/{id}/close` | Inbox ops |
| `GET/POST /templates` | WhatsApp/email templates |
| `POST /webhooks/whatsapp` · `POST /webhooks/telephony` | Provider callbacks |
| `GET/POST /projects`, `GET/POST/PATCH /properties`, `POST /properties/import` | Inventory |
| `GET /properties/{id}/matching-leads` | Reverse match |
| `GET/POST /deals`, `POST /deals/{id}/approve`, `GET/POST /invoices` | Revenue |
| `GET/POST /allocation-rules`, `POST /allocation-rules/simulate` | Rule builder with dry-run |
| `GET/POST /pipelines`, `GET/POST /saved-views` | Config |
| `POST /attendance/clock-in` · `/clock-out` | Attendance |
| `GET /analytics/{widget}?scope=&from=&to=&agent_ids=` | Dashboard widget data |
| `GET /users`, `GET /teams`, `GET /me` | Directory |
| `GET /s/{code}` (public) | Brochure micro-page, tracks open |

### 7.3 Disposition request (canonical example)

```http
POST /api/v1/leads/7f2c…/disposition
If-Match: "12"
Idempotency-Key: 5d1e…

{
  "stage": "site_visit_scheduled",
  "sub_status": "scheduled",
  "next_action": { "type": "site_visit", "due_at": "2026-10-24T11:00:00+04:00",
                   "project_id": "…", "property_ids": ["…"] },
  "note": "Prefers mid floor, 2BR, ready by Q2 2027",
  "assign_to": null,
  "notify_lead": { "channel": "whatsapp", "template": "site_visit_confirm" }
}
```

Response `200` returns updated lead (new `ETag`), created task, created interactions. `412` on version conflict (client shows "Lead was updated by X — review changes").

### 7.4 GraphQL (read model excerpt)

```graphql
type Query {
  lead(id: ID!): Lead
  leads(filter: LeadFilter, scope: Scope, queue: Queue, first: Int, after: String): LeadConnection!
  dashboard(scope: Scope!, range: DateRange!, agentIds: [ID!]): Dashboard!
}

type Lead {
  id: ID!  serialNo: Int!  contact: Contact!  owner: User  stage: String!  subStatus: String
  score: Int!  temperature: Temperature  source: String!  subSource: String
  requirements: JSON  nextActionAt: DateTime  slaDueAt: DateTime
  timeline(first: Int, after: String, types: [InteractionType!]): InteractionConnection!
  openTasks: [Task!]!
  matches(limit: Int = 10): [PropertyMatch!]!
  conversation: Conversation
}

type Subscription {          # served by the Realtime gateway (graphql-ws)
  leadUpdated(id: ID!): Lead!
  queueChanged(scope: Scope!): QueueDelta!
}
```

---

## 8. Real-time (WebSocket) Requirements

### 8.1 Transport
- `wss://rt.leadvolt.io/v1` (Socket.IO-compatible or native WS with JSON frames); JWT on connect; heartbeat 25 s; auto-reconnect with exponential backoff; **resume** from last `seq` per channel (server keeps 5-minute replay buffer in Redis Streams).

### 8.2 Channels (rooms)

| Channel | Subscribers | Events |
|---|---|---|
| `tenant:{t}:user:{u}` | the user | `lead.assigned_to_you`, `task.due_soon`, `sla.warning`, `mention`, `share_link.opened` |
| `tenant:{t}:team:{team}` | team members & managers | `lead.created`, `lead.assigned`, `lead.stage_changed`, `sla.breached` |
| `tenant:{t}:lead:{id}` | anyone viewing the lead | `lead.updated` (field diff), `interaction.created`, `presence` (who's viewing/typing) |
| `tenant:{t}:inbox:{wa_number}` | inbox agents | `message.received`, `message.status`, `conversation.assigned` |
| `tenant:{t}:counts:{scope}` | list/dashboard viewers | `counts.delta` (badge counters, KPI tiles) |

Server authorises every join against RBAC (an agent cannot join another team's room).

### 8.3 Frame format

```json
{ "ch": "tenant:abc:lead:7f2c", "seq": 1042, "type": "lead.updated",
  "data": { "id": "7f2c…", "version": 13, "changes": { "stage": ["contacted","site_visit_scheduled"] } },
  "ts": "2026-10-20T16:13:05.412Z" }
```

### 8.4 Client behavior
- Lists apply patches to the normalised cache (TanStack Query / Apollo); rows that no longer match the active filter fade out after 3 s rather than disappearing mid-click.
- "New leads (3)" pill at top of list instead of auto-inserting while the user is scrolling.
- Presence avatars on the lead header; soft-lock warning if another user opens the disposition popup on the same lead.

### 8.5 Targets
- Webhook → agent notification p95 < 3 s; p99 < 5 s.
- 50 k concurrent sockets per gateway node; horizontal scale via Redis/NATS fan-out.

---

## 9. Non-Functional Requirements

| Category | Requirement |
|---|---|
| Performance | Lead list first page p95 < 300 ms (100 k leads/tenant); lead workspace p95 < 400 ms; filter on 1 M leads p95 < 800 ms (OpenSearch) |
| Availability | 99.9 % monthly; intake endpoints 99.95 % with durable queue (no lost leads during API outage) |
| Scalability | 1 000 tenants, 50 M leads, 1 B interactions (monthly partitions, cold archive after 24 months) |
| Security | TLS 1.3, AES-256 at rest, field-level encryption for passport/ID docs, RLS, SSO (SAML/OIDC) for enterprise, 2FA, IP allow-lists, signed webhooks (HMAC) |
| Privacy & compliance | UAE PDPL alignment, consent records for WhatsApp/marketing, data-subject export/delete, retention policies, recording disclosure; portal advertising-permit field on listings |
| Auditability | Every mutation in `audit_log`; exports logged with row count and filter; export permission gated |
| Accessibility | WCAG 2.2 AA; all hotkeys have visible equivalents; focus management in slide-overs |
| Localisation | English + Arabic (RTL), multi-currency display, Asia/Dubai default TZ, E.164 phones |
| Mobile | React Native app: queue, lead workspace, click-to-call with call-log sync, push notifications, offline read cache |
| Observability | OpenTelemetry traces, RED metrics per endpoint, intake lag dashboards, SLA-breach alerting |

---

## 10. Delivery Plan

| Phase | Weeks | Scope |
|---|---|---|
| **P0 Foundations** | 1–4 | Tenancy, auth/RBAC, users/teams, Postgres schema, outbox + bus, CI/CD, design system |
| **P1 Lead core** | 5–10 | Intake (3 portals, Meta, IVR, web form), dedupe, pipeline, list + split-screen workspace, disposition popup, tasks, hotkeys, saved views, realtime list/counts |
| **P2 Distribution & comms** | 11–16 | Allocation rule engine + simulator, SLA scheduler, attendance, WhatsApp inbox, click-to-call + post-call disposition, templates |
| **P3 Inventory & matching** | 17–21 | Projects/units/off-plan, matching + reverse matching, brochure share links + tracking |
| **P4 Revenue & insight** | 22–26 | Deals, invoices, dashboard widgets, reports, ClickHouse pipeline, exports |
| **P5 Intelligence** | 27+ | ML scoring, AI summaries/drafts, NL filters, transcription |

### 10.1 Acceptance criteria (samples)
- A portal lead posted to `/intake/bayut` appears in the assigned agent's list and triggers a notification within 5 s, with source/sub-source populated.
- Choosing *Site Visit* without a date blocks save with an inline error; with a date it creates exactly one task and one `status_change` interaction.
- `Save & Next` loads the next lead in the active filtered queue in < 300 ms.
- A re-enquiry from an existing phone number increments `reenquiry_count`, does not create a new lead, and notifies the current owner.
- An agent cannot open, export, or subscribe to a lead outside their scope (verified by API and WS tests).

---

## 11. Open Questions

1. Which portal integrations are contractually available (webhook vs. email-parse) for each portal the business uses?
2. Telephony provider choice (existing IVR vendor vs. new cloud PBX) — affects call-event schema mapping.
3. WhatsApp: single BSP vs. direct Cloud API; number-per-team or shared numbers?
4. Is commission split logic (co-broker, team lead override) required in P2 or P4?
5. Migration: volume and format of data to import from the current CRM (leads, history, notes) — export via the incumbent's CSV export where permitted by its terms.
