# Intake and messaging contract

## Bayut / portal intake

This is a configurable intake endpoint, not a verified native Bayut connector. Your admin needs to confirm whether enquiries arrive by API, webhook, email, or an existing connector. A trusted server-side bridge can normalize that delivery into this contract. Never put the intake secret in a browser, listing page or mobile client.

`POST /api/v1/intake/portal?source=bayut`

```json
{
  "event_id": "provider-stable-enquiry-123",
  "contact": { "name": "Fictional buyer", "phone": "+971501234567" },
  "listing": { "reference": "EXACT-BAYUT-REFERENCE" },
  "message": "Interested in arranging a viewing"
}
```

Headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-LeadVolt-Workspace` | Workspace slug |
| `X-LeadVolt-Timestamp` | Current Unix timestamp, seconds |
| `X-LeadVolt-Signature` | `sha256=` followed by the HMAC-SHA256 hex digest |

The exact bytes signed are **timestamp + `.` + source + `.` + raw JSON body**. The allowed clock difference is five minutes. Re-sign retries with a fresh timestamp while retaining the same event ID and identical body. Keep sender and server clocks synchronized.

Production portal deliveries require the stable event ID **inside the signed JSON payload**. The optional `X-LeadVolt-Event-Id` header is retained for development compatibility; it cannot override a signed payload ID and does not satisfy production's signed ID requirement. Legacy body-only HMACs are disabled by default in production.

A Python sender/bridge signs a request as follows:

```python
import hashlib, hmac, json, os, time, urllib.request
source = 'bayut'
payload = {'event_id': 'stable-provider-id', 'contact': {'name': 'Fictional buyer', 'phone': '+971501234567'}, 'listing': {'reference': 'BAY-100'}}
raw = json.dumps(payload, separators=(',', ':')).encode()
timestamp = str(int(time.time()))
signature = hmac.new(os.environ['INTAKE_SECRET'].encode(), timestamp.encode()+b'.'+source.encode()+b'.'+raw, hashlib.sha256).hexdigest()
request = urllib.request.Request(os.environ['CRM_URL']+'/api/v1/intake/portal?source='+source, data=raw, headers={'Content-Type':'application/json', 'X-LeadVolt-Workspace':os.environ['CRM_WORKSPACE'], 'X-LeadVolt-Timestamp':timestamp, 'X-LeadVolt-Signature':'sha256='+signature})
with urllib.request.urlopen(request) as response:
    print(response.status)
```

Successful responses return `leadId`, `ownerId`, `routingStatus`, `created`, `reenquiry` and `duplicate`. An unknown listing is a successfully saved enquiry with a null owner; it appears in the exception queue. Do not treat it as a delivery failure.

The receipt key is workspace + source + provider event ID. Identical retries return the original result; reusing an ID with different body bytes returns `409`. A genuine new enquiry must use a new ID. Retry transient server/transport failures with bounded backoff. For an ambiguous timeout, resend the same ID and body, never invent a new ID. Correct invalid payloads before retrying rejected requests.

Map contracted field names through `PATCH /settings` → `intake_field_maps.bayut`, with arrays of dotted paths under `name`, `phone`, `email`, `listingRef`, `message`, `channel`, `eventId`. Default IDs include `event_id`, `enquiry_id`, `inquiry_id` and `lead.id`. Listing references are trimmed, exact and case-sensitive, and are scoped to the portal. Missing-reference enquiries are held separately until an administrator identifies the property. No phone-only guessing is used to merge different listings.

Only administrators can reveal or rotate the signing key; both actions are audited. Rotating invalidates old signatures immediately. Coordinate bridge configuration before rotation. Integration activity shows accepted, duplicate and rejected deliveries without including the raw customer payload or signing key. Enquiry history retains raw accepted payloads under tenant access controls; apply your retention and backup policies to that customer data.

## WhatsApp Business Cloud API

Production sending requires `WA_WORKSPACE`, `WA_PHONE_NUMBER_ID`, `WA_ACCESS_TOKEN`, `WA_APP_SECRET`, `WA_VERIFY_TOKEN` and an explicitly selected supported `WA_API_VERSION`. Set the workspace's `settings.wa_phone_number_id` to the same phone ID. This installation binds one provider token/number to one workspace. Configure Meta's signed callback at `/api/v1/webhooks/whatsapp`; subscription verification uses the configured verify token.

`POST /leads/:id/messages` with `mode: "send"` requires a UUID `clientRequestId`. Reusing it prevents a second queued send. Use a fresh ID only for an intentional new message. Free text requires a verified inbound provider message within 24 hours; manually logged replies, portal enquiries and brochure opens do not open that window. Outside it, supply a provider-approved template and language/variables.

Messages are durably queued before the worker contacts Meta. `sent` means provider acknowledgement, not confirmed customer delivery. Signed callbacks advance delivered/read states and retain early receipts; out-of-order callbacks cannot regress them. Definite rejections become failed. Network uncertainty or an interrupted processing job becomes `delivery_unknown` and is never automatically resent. Check Meta's delivery records before creating another send.

Without a provider connection, an agent can open WhatsApp separately and explicitly log a message they actually sent. Clicking the external WhatsApp link alone records no successful message. No live provider send was performed during this review; transport fixtures and signed callback fixtures were used.

## API sessions and concurrent edits

Browser sessions use HttpOnly, SameSite=Lax cookies; production adds Secure. Cookie-authenticated writes require `X-LeadVolt-CSRF: 1` and an allowed origin. Server-side clients may use bearer tokens. Tokens are invalidated on logout, password/role changes or account deactivation; logout ends all sessions for that user.

Send the current numeric version in `If-Match: "N"` for lead details, dispositions, property edits, listing mapping edits and routing resolution. Missing or stale versions are rejected. Refetch and review the latest record before retrying; do not silently overwrite another user's work.
