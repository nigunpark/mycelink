# PCM-102 — Unknown owners and pets answer 404 everywhere

Status: approved · Archetype: backward-compatible behavioural change

## Problem

`GET /owners/{ownerId}` on customers-service answers `200` with the body
`null` when the owner does not exist. The API gateway's owner details
endpoint `GET /api/gateway/owners/{ownerId}` passes that on as `200` with an
empty body, and when customers-service does answer `404` the gateway fails
with `500`. Clients cannot tell an unknown owner from a server failure.

## Scope

| Module | Change |
|---|---|
| `spring-petclinic-customers-service` | unknown owners and pets answer `404` with a problem document |
| `spring-petclinic-api-gateway` | owner details answer `404` for unknown owners and `503` when customers-service fails |

No other module changes.

## Problem documents

Every error response introduced or changed by this requirement is an
RFC 9457 problem document: `Content-Type: application/problem+json`, with at
least the members `status` (the HTTP status as a number), `title` and
`detail`. `detail` contains the id that was not found (for example
`"Owner 999 not found"`).

## Acceptance criteria

**AC-1 — unknown owner (customers-service).** `GET /owners/{ownerId}` for an
owner that does not exist answers `404` with a problem document whose
`detail` contains `ownerId`.

**AC-2 — other unknown resources (customers-service).** These answer `404`
with a problem document whose `detail` contains the unknown id:

- `GET /owners/{ownerId}/pets/{petId}` for a pet that does not exist (the
  id is `petId`);
- `PUT /owners/{ownerId}` for an owner that does not exist;
- `POST /owners/{ownerId}/pets` for an owner that does not exist.

Their status codes are already `404` today; only the body changes.

**AC-3 — unknown owner (api-gateway).** `GET /api/gateway/owners/{ownerId}`
answers `404` with a problem document whose `detail` contains `ownerId` when
customers-service reports that the owner does not exist.

**AC-4 — customers-service failure (api-gateway).** When customers-service
answers with a `5xx` status or cannot be reached,
`GET /api/gateway/owners/{ownerId}` answers `503 Service Unavailable` with a
problem document instead of `500`.

**AC-5 — compatibility.** For owners and pets that exist, every response of
both services is unchanged byte for byte: status, headers that matter to
clients (`Content-Type`) and body. That includes the owner details when
visits-service is unavailable (`200`, with empty visit lists).

## Engineering expectations

- Implement each criterion in the module that owns it, with tests in that
  module.
- Existing tests keep passing. Do not change the Maven build, the module
  layout or the service ids.
