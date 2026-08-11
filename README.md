# SDO Semantic Observability

This folder is a separate central observability service for SDO use. It is not part of the normal participant-side `tno-security-gateway` runtime.

The service receives sanitized semantic observability events from many TSG systems, stores them centrally, and shows an SDO-level dashboard.

## Why Separate

Participants need TSG and their local semantic observability module. They do not need the central SDO dashboard.

This folder is intended to be shared with or deployed by the SDO:

```text
tno-security-gateway
  participant-side TSG runtime

sdo-semantic-observability
  SDO collector API
  central SDO dashboard
  central observability storage
```

## Current MVP

The current version is intentionally lightweight:

- Node.js API
- JSONL file storage for local direct runs
- Postgres storage for Docker Compose runs
- browser dashboard served from the same service
- Docker Compose deployment
- central report and transaction grouping APIs
- real-time dashboard refresh through server-sent events

The ingestion API shape is the same for both storage modes.

## Storage

The service supports two storage backends.

### JSONL Local Fallback

Direct local runs default to JSONL:

```text
sdo-semantic-observability/data/events.jsonl
sdo-semantic-observability/data/participants.jsonl
```

This is useful for quick local development and small smoke tests.

### Postgres

Set:

```env
STORAGE_TYPE=postgres
DATABASE_URL=postgres://sdo:sdo@localhost:5432/sdo_semantic_observability
```

The schema is initialized automatically from:

```text
migrations/001_init.sql
```

Postgres tables currently used by the collector:

```text
sdo_participant
semantic_observability_event
```

Reports and transaction groups are computed on demand from stored events. The
snapshot and transaction tables in older databases are not used by the current
collector and can be removed during a planned database cleanup.

## Run Locally

```powershell
cd F:\Project\sdo-semantic-observability
node .\src\server.js
```

Open:

```text
http://localhost:4100
```

## Run With Docker

```powershell
cd F:\Project\sdo-semantic-observability
docker compose up --build -d
```

Dashboard:

```text
http://localhost:4100
```

Docker Compose starts both the SDO service and Postgres. The SDO service runs with:

```env
STORAGE_TYPE=postgres
DATABASE_URL=postgres://sdo:sdo@postgres:5432/sdo_semantic_observability
```


Health:

```text
http://localhost:4100/api/health
```

## Ingest Events

Participants first register with the SDO service:

```text
POST /api/participants/register
```

Example:

```powershell
$registration = Invoke-RestMethod `
  -Method POST `
  -Uri http://localhost:4100/api/participants/register `
  -ContentType "application/json" `
  -Body (@{
    displayName = "Local demo participant"
    systemDescription = "TSG semantic observability demo"
  } | ConvertTo-Json)

$registration
```

The response contains a unique `participantId`, one-time `apiKey`, and ingestion `endpoint`.

Events are then pushed by participant systems to:

```text
POST /api/ingest/events
```

The request requires participant-specific headers:

```text
X-SDO-Participant-Id: <participantId>
X-SDO-API-Key: <apiKey>
```

Example:

```powershell
$body = Get-Content .\examples\sample-events.json -Raw
Invoke-RestMethod `
  -Method POST `
  -Uri $registration.endpoint `
  -Headers @{
    "X-SDO-Participant-Id" = $registration.participantId
    "X-SDO-API-Key" = $registration.apiKey
  } `
  -ContentType "application/json" `
  -Body $body
```

Then refresh:

```text
http://localhost:4100
```

## API

```text
GET  /api/health
POST /api/participants/register
GET  /api/participants
GET  /api/participants/me
POST /api/ingest/events
GET  /api/events
GET  /api/events/stream
GET  /api/artefacts
GET  /api/report
GET  /api/transactions
GET  /api/version-validation
GET  /api/field-usage
```

Supported query filters:

```text
from
to
participantId
component
eventType
status
datasetPseudonym
participantPairPseudonym
artefactType
artefactReference
artefactVersion
artefactDeprecated
```

## What Participants Should Send

Only sanitized observability data should be pushed to the SDO:

- event id
- timestamp
- component
- event type
- dimensions
- status
- pseudonymized participant context
- pseudonymized dataset context
- pseudonymized correlation/agreement/transfer ids
- pseudonymized semantic artefact references
- failure category
- aggregate-safe attributes

Do not send:

- raw business payloads
- credentials
- raw semantic artefact contents
- sensitive error messages
- private backend response bodies

The collector reconstructs accepted events from an allowlist, requires
pseudonymized context and artefact references, and drops undeclared fields.

## Governed Versions And Field Usage

Version/error correlation and field usage require explicit public identifiers
in the participant's HTTP Data Plane dataset configuration:

```yaml
semanticObservability:
  fieldUsageMinimumObservations: 5

dataset:
  governedStandardId: "setu:employment-profile"
  governedFieldIds:
    - "setu:employee.startDate"
    - "setu:employee.role"
```

Only configured identifiers are counted. Values, unknown/custom field names,
payloads, transaction identifiers, and dataset identities are not included in
field-usage summaries. Counts remain local until the minimum observation
threshold is reached. The central dashboard suppresses field usage until at
least two participants contribute; configure a higher threshold with
`SDO_FIELD_USAGE_MIN_PARTICIPANTS`.

## Participant-Side Export

`tno-security-gateway` has an optional SDO exporter in the Control Plane and HTTP Data Plane semantic observability modules.

The recommended demo path is the local Alfa/Bravo dashboard demo:

```powershell
cd F:\Project\tno-security-gateway
powershell -ExecutionPolicy Bypass -File .\demo\semantic-observability-sharing\scripts\start-sdo-dashboard-demo.ps1 -Build
powershell -ExecutionPolicy Bypass -File .\demo\semantic-observability-sharing\scripts\run-sharing-flow.ps1
```

That starts this SDO collector, registers Alfa and Bravo, runs the local TSG services, and exports sanitized events into the central dashboard at:

```text
http://localhost:4100
```

For a hosted central SDO dashboard, for example in GCP, each local TSG demo can export outbound events to the hosted URL while keeping local Alfa/Bravo ports private:

```powershell
cd F:\Project\tno-security-gateway
powershell -ExecutionPolicy Bypass -File .\demo\semantic-observability-sharing\scripts\start-sdo-dashboard-demo.ps1 `
  -ExternalSdo `
  -SdoUrl https://sdo.example.com `
  -Build
```

This is the intended multi-system model for the current scope:

```text
System 1 local Alfa/Bravo demo -> outbound HTTPS -> central SDO
System 2 local Alfa/Bravo demo -> outbound HTTPS -> central SDO
System 3 local Alfa/Bravo demo -> outbound HTTPS -> central SDO
```

It does not require participant-to-participant networking across systems.

Recommended participant config:

```yaml
semanticObservability:
  enabled: true
  sdoExport:
    enabled: true
    endpoint: "https://sdo.example.org/api/ingest/events"
    apiKey: "${SDO_API_KEY_FROM_REGISTRATION}"
    participantId: "${PARTICIPANT_ID_FROM_REGISTRATION}"
```

For a local SDO collector started from this folder, use:

```yaml
semanticObservability:
  enabled: true
  sdoExport:
    enabled: true
    endpoint: "http://host.docker.internal:4100/api/ingest/events"
    apiKey: "<apiKey from /api/participants/register>"
    participantId: "<participantId from /api/participants/register>"
```

Use `host.docker.internal` when the participant TSG runs in Docker and the SDO collector runs on the host machine. If both run in the same Docker network, use the SDO service name instead.

When enabled, the participant-side TSG should:

```text
record local sanitized event
  -> persist locally
  -> push sanitized copy to SDO collector
```

The exporter should be disabled by default so normal participant deployments are not affected.
