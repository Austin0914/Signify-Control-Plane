# HTTP API contract

All bodies are JSON. Operator routes require a Cognito JWT. Device config retrieval requires an opaque device bearer credential. Error bodies use `{ "code": "stable_machine_code" }`. Unknown properties are rejected by shared protocol/config schemas.

## Operator routes

| Method | Path | Concurrency guard | Result |
|---|---|---|---|
| GET | `/api/v1/me` | — | Cognito subject and `operator` role |
| GET | `/api/v1/projects/default/config/latest` | — | Latest immutable config + ETag |
| GET/PUT | `/api/v1/projects/default/config/draft` | `If-Match: "draft-N"` on PUT | Draft and incremented draft version |
| POST | `/api/v1/projects/default/config/validate` | — | Schema/catalog validation |
| POST | `/api/v1/projects/default/config/publish` | `Idempotency-Key` | New immutable revision |
| GET | `/api/v1/projects/default/config/revisions` | — | Newest 50 revisions |
| POST | `/api/v1/projects/default/config/rollback` | explicit revision | Creates a draft; never silently publishes |
| GET | `/api/v1/projects/default/devices` | — | Registry plus device-reported snapshot |
| POST | `/api/v1/projects/default/pairing-codes` | — | Five-minute, single-use code, shown once |
| POST | `/api/v1/projects/default/devices/{deviceId}/revoke` | explicit device ID | Revokes all credentials and fences the connection |
| POST | `/api/v1/projects/default/commands` | `Idempotency-Key` + `expectedDeviceStateRevision` | Durable queued command; HTTP 202 is not activation |
| GET | `/api/v1/projects/default/commands/{commandId}` | — | Ingress and terminal states |
| POST | `/api/v1/projects/default/research-exports` | format `json` or `csv` | Redacted export and 15-minute download URL; object expires after 7 days |

## Device routes

| Method | Path | Authentication | Result |
|---|---|---|---|
| POST | `/device/v1/pairing/redeem` | possession of unexpired pairing code | Device bearer credential, returned once |
| GET | `/device/v1/config/latest` | `Authorization: Bearer …` | Latest config + revision ETag |

The server never accepts a scene name, Unity enum integer, world pose, Unity object reference, generation override, or arbitrary LearnWord target phase. Exact wire schemas live in `packages/contracts/src/index.ts`.

Course configurations may include `content.gaming.autoStart: true` to confirm Gaming automatically on entry. The field is an optional strict boolean; omission or false preserves manual confirmation. It is saved and published with the course revision, rather than attached to navigation commands. Updated Unity clients are required for configurations containing this field.

## Start a waiting game

Send `commandType: "start_gaming"` with `payload: { "sectionInstanceId": "gaming@g3" }` through the existing commands route. The device must advertise `start_gaming`, report an active Gaming execution and `gaming: { "phase": "rules_gate", "canStart": true }`. The backend binds the request to that execution and rejects stale targets, unsupported devices, transitions and already-started games. The new optional `gaming` snapshot field preserves compatibility with older clients.

Unity confirms the existing start gate, preserving its configured intro. The ACK means the start was requested; `command_result: activated` is emitted only when Gameplay begins. Leaving the section while starting produces `superseded`. Duplicate command IDs replay their original outcome without restarting the countdown.

Deploy the updated backend before running the new Unity client: its `client_hello` adds the new capability, which older backend schemas do not accept.

## Status semantics

`queued → sent → accepted|deferred → activated|superseded|failed`

`rejected` and `expired` are terminal. Manual judgment terminates as `judged_correct` or `judged_wrong` after a matching attempt-scoped `judgment_result`. A duplicate or late ingress ACK cannot replace a terminal value.
