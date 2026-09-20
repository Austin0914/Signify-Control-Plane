# Signify Control Plane

Backend and Web control plane for Signify Cloud Session Control Plan 08.

## MVP decisions

- Web hosting: AWS Amplify Hosting.
- Operator login: four administrator-created Amazon Cognito email/password accounts; public sign-up and Google federation are disabled.
- Authorization: one `operator` capability. Concurrency safety still uses draft versions, device state revisions, idempotency keys, and server sequence numbers.
- Device channel: authenticated HTTPS/WSS, short-lived single-use pairing, opaque device credentials, connection fencing, durable command ledger, ACK/terminal separation, and device-wins snapshot reconciliation.
- Environments: `dev` and `demo`, with isolated resources.

## Workspace

```text
apps/web/                  React + Vite operator console
packages/contracts/        SessionConfig and WebSocket schemas/fixtures
services/control-plane/    Domain services and Lambda handlers
infra/                     AWS CDK stacks
```

## Local verification

```bash
npm ci
npm run check
npm run cdk:synth
```

No deployment runs automatically from this repository. Amplify Hosting builds the Web app from `amplify.yml`; AWS infrastructure deployment remains an explicit, environment-scoped action.

See [AWS manual setup runbook](docs/aws-manual-setup.md) before granting access or creating resources. Prefer IAM Identity Center/SSO and short-lived roles; never share long-lived access keys or passwords.

Current scope and remaining work are tracked in [implementation status](docs/implementation-status.md). HTTP behavior is summarized in [API contract](docs/api.md), and state changes follow the [migration and rollback policy](docs/migrations-and-rollback.md).
