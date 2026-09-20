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

## Dev deployment completed on 2026-09-20

- `CDKToolkit` was bootstrapped in the selected AWS account, Region `ap-northeast-3`. The default bootstrap CloudFormation execution policy is broad (`AdministratorAccess`) and should be narrowed before routine deployment ownership is transferred.
- CloudFormation stack `SignifyControlPlane-dev` reached `CREATE_COMPLETE` in `ap-northeast-3`.
- Stack outputs:
  - HTTP API: `https://15f5hxwl22.execute-api.ap-northeast-3.amazonaws.com`
  - WebSocket API: `wss://ilzahq1m7a.execute-api.ap-northeast-3.amazonaws.com/dev`
  - Cognito user pool: `ap-northeast-3_3cbodDNKb`
  - Cognito Web client: `6eeg8nb6n74n1mmog60s43uj7h`
- The stack created isolated `signify-control-dev-*` Lambdas, DynamoDB tables, roles, log groups and export bucket plus Cognito, API Gateway, Secrets Manager and CloudWatch resources. It did not modify any `signfy-recordings-*` resource.
- All three DynamoDB tables have point-in-time recovery enabled. The export bucket blocks every public-access mode. Cognito self-sign-up remains disabled and MFA is off per the approved four-account MVP decision.
- External smoke checks passed: unauthenticated operator and device-config calls returned `401`, an invalid pairing code returned `401`, and a WebSocket upgrade without a device bearer token was rejected.
- Four new alarms initially report `INSUFFICIENT_DATA`, which is expected before their first evaluation window; this is not an `ALARM` state.

## Not deployed and not claimed complete

- No Amplify app, Cognito operator user, `demo` stack, custom domain or deployment pipeline has been created.
- Full authenticated Lambda/API integration tests against DynamoDB/API Gateway are still needed before Plan 08 completion or promotion beyond dev.
- Browser component/E2E tests, accessibility pass, config diff/revision UI, audit UI, export UI and revoke UI remain later Plan 08 slices.
- Heartbeat/offline threshold is a configurable 45-second implementation default pending load/E2E evidence; retry alarms, DLQ policy, RPO/RTO and on-call notification ownership remain open.
- The Unity latest-config Authorization header and secure token storage patch is not in this repository and remains a Plan 09 integration prerequisite.
- Unity Editor E2E is Plan 09. Vision Pro, XR lifecycle, network soak and release sign-off are Plan 10.

## Next safe sequence

1. Replace temporary root CLI access with a least-privilege SSO/deployment role and narrow the CDK bootstrap execution policy.
2. Receive the four operator emails, create the Cognito users and verify authenticated operator API flows.
3. Confirm Amplify branch mapping, create the Amplify app, then redeploy the backend with its exact HTTPS origin for CORS.
4. Add mocked AWS integration tests and missing Web tests, then exercise pairing, credential rotation/revocation and complete command lifecycle paths in dev.
5. Decide when to create the isolated `demo` stack; do not reuse the dev data plane.
6. Hand the authenticated endpoints and fixture bundle to Plan 09.
