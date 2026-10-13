# PCM-103 — Book a visit exactly once, even when requests are retried

Status: approved · Archetype: deterministic failure, concurrency and recovery

## Problem

The API gateway retries a `POST` once when the target service answers
`503` (the `Retry` default filter in the gateway's `application.yml`).
Clients also retry after timeouts. If visits-service stored the visit but the
response was lost, or it answered `503` after storing it, the retry books the
same visit twice. Concurrent retries can book it several times.

## Scope

| Module | Change |
|---|---|
| `spring-petclinic-visits-service` | idempotent visit creation keyed by an `Idempotency-Key` header |
| `spring-petclinic-api-gateway` | give every routed visit `POST` a key, so a gateway retry re-sends the same key |

No other module changes.

## Acceptance criteria

**AC-1 — the key (visits-service).** `POST /owners/{ownerId}/pets/{petId}/visits`
accepts an optional `Idempotency-Key` request header. A valid key is 1 to 64
characters from `A–Z`, `a–z`, `0–9`, `.`, `_` and `-`. Any other value is
answered with `400 Bad Request` and nothing is stored.

**AC-2 — replay (visits-service).** The first request with a given key
stores the visit and answers `201` exactly as today. A later request with
the same key, the same `petId` and the same body (`date` and `description`)
stores nothing and answers `201` with the representation of the visit the
first request stored (same `id`).

**AC-3 — conflicting reuse (visits-service).** A later request with the same
key but a different `petId` or a different body stores nothing and answers
`409 Conflict` with an RFC 9457 problem document
(`Content-Type: application/problem+json`, members `status`, `title`,
`detail`).

**AC-4 — concurrency (visits-service).** When several requests with the same
key, pet and body arrive at the same time, exactly one visit is stored and
every one of them answers `201` with that visit's `id`. This holds across
several service instances sharing one database, so it cannot rely on
in-memory state alone; keys are stored with the visits in both the HSQLDB
and the MySQL schema.

**AC-5 — no key (visits-service).** Requests without the header behave
exactly as today: each one stores a new visit.

**AC-6 — keys at the edge (api-gateway).** For a `POST` routed to
visits-service (paths `/api/visit/**`) that carries no `Idempotency-Key`,
the gateway assigns one (a random UUID) before routing, so that when the
gateway retries the request the retry carries the same key. A key sent by
the client is forwarded unchanged. Requests with other methods and requests
to other routes are forwarded without an added key.

## Engineering expectations

- Implement each criterion in the module that owns it, with tests in that
  module, including a test that proves AC-4 with concurrent requests.
- Existing tests keep passing. Do not change the Maven build, the module
  layout or the service ids.
