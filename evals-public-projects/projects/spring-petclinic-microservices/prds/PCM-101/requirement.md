# PCM-101 — Record which veterinarian handled a visit

Status: approved · Archetype: additive vertical slice

## Problem

The owner page in the UI is backed by the API gateway's aggregate endpoint
`GET /api/gateway/owners/{ownerId}`, which combines the owner from
customers-service with the pets' visits from visits-service. The clinic
cannot record which veterinarian handled a visit, and nobody can see it.

## Scope

| Module | Change |
|---|---|
| `spring-petclinic-visits-service` | store, validate and expose the vet of a visit; list a vet's visits |
| `spring-petclinic-api-gateway` | show the vet's name on every visit in the owner details |
| `spring-petclinic-vets-service` | none — use the existing `GET /vets` |

UI changes are optional. No other module changes.

## Acceptance criteria

**AC-1 — storage (visits-service).** A visit has an optional veterinarian,
`vetId`: a positive integer, or `null` when no vet is recorded. It is stored
in the `visits` table as a nullable `vet_id` integer column, in both the
HSQLDB and the MySQL schema. The existing seed visits have no vet.

**AC-2 — create (visits-service).** `POST /owners/{ownerId}/pets/{petId}/visits`
accepts an optional `vetId` in its JSON body.

- `vetId` absent or `null`: the visit is created exactly as today, with
  `vetId: null`.
- `vetId` ≥ 1: the visit is created with that vet.
- `vetId` ≤ 0: the service answers `400 Bad Request` and stores nothing.

**AC-3 — read (visits-service).** Every visit representation visits-service
returns includes the `vetId` property (an integer or `null`): the `POST`
response, `GET /owners/{ownerId}/pets/{petId}/visits` and
`GET /pets/visits?petId=…`.

**AC-4 — a vet's visits (visits-service).** `GET /vets/{vetId}/visits`
answers `200` with a JSON array of the visits recorded for that vet,
ordered by visit date ascending, then by visit id ascending. It answers `200`
with `[]` when the vet has no visits. (Through the gateway this is
`GET /api/visit/vets/{vetId}/visits`.)

**AC-5 — owner details (api-gateway).** In the response of
`GET /api/gateway/owners/{ownerId}`, every visit of every pet has two more
properties:

- `vetId`: as returned by visits-service;
- `vetName`: `"<firstName> <lastName>"` of the vet with that id as returned
  by vets-service `GET /vets` (service id `vets-service`), or `null` when the
  visit has no vet or vets-service does not list that id.

**AC-6 — resilience (api-gateway).** When vets-service is unavailable or
answers with an error, `GET /api/gateway/owners/{ownerId}` still answers
`200` with the owner, every pet and every visit; `vetId` is kept and
`vetName` is `null`. The existing behaviour when visits-service is
unavailable (the owner is returned with empty visit lists) is unchanged.

**AC-7 — compatibility.** Apart from the new properties, every response
keeps its current shape, status codes and property values. Existing clients
that ignore unknown properties keep working.

## Engineering expectations

- Implement each criterion in the module that owns it, with tests in that
  module.
- Existing tests keep passing. Do not change the Maven build, the module
  layout or the service ids.
