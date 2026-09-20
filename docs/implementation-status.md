# Implementation status

## Implemented in the first Plan 08 slice

- Shared Zod contracts and conformance tests reconciled to current Unity writers/parsers.
- Strict command allowlist; no scene names, enum integers, world poses, Unity references, generation overrides, or arbitrary LearnWord target phases.
- Cognito operator pool design with public sign-up and federation disabled.
- Single-use five-minute pairing, 30-day hashed device bearer credentials, rotation and revocation.
- Device-authenticated latest-config REST route.
- Config draft validation, ETag concurrency, immutable publish revisions, latest retrieval and rollback-to-draft.
- WebSocket bearer authorizer, gateway/protocol connection fencing, hello, heartbeat, authoritative snapshot readiness and reconnect replay.
- Atomic per-device server sequence plus durable command ledger/outbox creation.
- ACK/NACK ingress separated from terminal command/judgment results; late ingress cannot overwrite terminal state.
- Current snapshot projection remains device truth; desired intent is displayed separately.
- 90-day command/audit, 14-day snapshot history, 7-day connection record and 7-day export TTLs.
- Redacted JSON/CSV research export with a 15-minute signed download.
- React/Vite operator console with Amplify/Cognito login, device polling, config editor, pairing and guarded remote commands.
- CDK stacks for separate `dev` and `demo` resources in `ap-northeast-3`.
- Test-only GitHub Actions workflow. There is no deployment workflow.

## Verification completed locally

- Strict TypeScript typecheck across all workspaces.
- Protocol/config tests and command-state unit tests.
- Production Web build.
- CDK synth with Lambda bundling in `ap-northeast-3`.
- `npm audit`: zero known vulnerabilities after upgrading to Vitest 5.

## Not deployed and not claimed complete

- No AWS account, Amplify app, Cognito user, API, Lambda, table, bucket, secret, alarm, role or pipeline has been created.
- Lambda/API integration tests against DynamoDB/API Gateway are still needed before a dev deployment.
- Browser component/E2E tests, accessibility pass, config diff/revision UI, audit UI, export UI and revoke UI remain later Plan 08 slices.
- Heartbeat/offline threshold is a configurable 45-second implementation default pending load/E2E evidence; retry alarms, DLQ policy, RPO/RTO and on-call notification ownership remain open.
- The Unity latest-config Authorization header and secure token storage patch is not in this repository and remains a Plan 09 integration prerequisite.
- Unity Editor E2E is Plan 09. Vision Pro, XR lifecycle, network soak and release sign-off are Plan 10.

## Next safe sequence

1. Review this source and the synthesized `dev` template.
2. Confirm AWS SSO/profile, Amplify branch mapping, final domain and four operator emails.
3. Add mocked AWS integration tests and missing Web tests.
4. Explicitly approve CDK bootstrap and a `dev`-only deployment.
5. Run HTTP/WebSocket smoke tests without Unity, using golden fixtures.
6. Hand the authenticated endpoints and fixture bundle to Plan 09.
