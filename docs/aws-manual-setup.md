# AWS manual setup runbook

This runbook lists the remaining human actions needed for the MVP. Nothing in this repository deploys automatically. The `dev` backend was deployed manually on 2026-09-20; Amplify, operator users and `demo` remain uncreated.

## Confirmed deployment shape

- AWS Region: `ap-northeast-3` (Osaka).
- Environments: isolated `dev` and `demo` stacks.
- Web hosting: a new Amplify Hosting app connected to `Austin0914/Signify-Control-Plane`.
- Operators: four separate Cognito email/password users. Public sign-up and Google federation stay disabled.
- Backend: API Gateway HTTP + WebSocket APIs, Lambda, DynamoDB, S3, Cognito, Secrets Manager and CloudWatch.
- Recording Tools resources are not shared. Only its deployment patterns were used as reference.

## Verified account inventory on 2026-09-20

- Recording Tools runtime resources do exist in `ap-northeast-3`: one WebSocket API, four Lambda functions, three DynamoDB tables, one S3 bucket and one Amplify app.
- Their actual prefix is `signfy-recordings-*`; Plan 08 does not reuse or rename them.
- The account GitHub OIDC provider exists, but its existing roles trust other repositories/organizations and are not suitable for this repository.
- CDK was subsequently bootstrapped in `ap-northeast-3`; its default CloudFormation execution policy is currently broad and must not be treated as the long-term IAM boundary.
- `SignifyControlPlane-dev` is now active and contains a Cognito user pool plus the isolated backend resources. The prior no-stack/no-pool statement was only the pre-deployment inventory.
- The deployment used a temporary account-root CLI session. It must be logged out after verification and must not become the routine deployment identity.

## 1. Choose how Codex or a maintainer accesses AWS

Preferred: create or use an AWS IAM Identity Center (SSO) permission set, then sign in locally with `aws sso login`. A short-lived role is safer and easier to revoke than an access key.

For the first CDK deployment, the role needs CloudFormation deployment access plus permission to create the resource types listed above and IAM roles used by Lambda. Scope it to this account and, where AWS supports it, resource names prefixed `signify-control-`. CDK bootstrap also creates its own `CDKToolkit` resources.

Do **not** send an AWS password, Cognito user password, access-key secret, or device token in chat or commit it to Git. If temporary CLI access is needed later, provide the AWS profile name after completing SSO locally.

## 2. Verify the local AWS identity

Run these yourself, or grant a short-lived CLI session and ask Codex to run only the read-only checks:

```bash
aws sts get-caller-identity --profile YOUR_PROFILE
aws configure get region --profile YOUR_PROFILE
```

The expected region is `ap-northeast-3`. Record the account ID privately; it does not need to be committed.

## 3. Bootstrap CDK once per account and region (completed for Osaka)

From the repository root, after installing dependencies:

```bash
export AWS_PROFILE=YOUR_PROFILE
export CDK_DEFAULT_REGION=ap-northeast-3
npm run build
npx cdk bootstrap aws://ACCOUNT_ID/ap-northeast-3 --app "node infra/dist/bin/app.js"
```

Bootstrap is an AWS mutation. It was completed for the selected account in `ap-northeast-3` on 2026-09-20. It is shared CDK deployment infrastructure, not a Signify runtime resource. Future work should replace the default broad execution policy with a reviewed least-privilege boundary.

## 4. Review before deploying each environment

```bash
npm run build
npm exec --workspace @signify/infra -- cdk synth --context environment=dev --context frontendOrigin=http://localhost:5173
npx cdk diff SignifyControlPlane-dev --app "node infra/dist/bin/app.js" --context environment=dev --context frontendOrigin=http://localhost:5173
```

For `demo`, replace the environment and use the final Amplify URL as `frontendOrigin`. The `demo` tables, bucket, Cognito pool and secret use retain-on-stack-delete; `dev` is disposable. Never point a `dev` Web app at `demo` APIs.

Deployment, when explicitly approved:

```bash
npx cdk deploy SignifyControlPlane-dev --app "node infra/dist/bin/app.js" --context environment=dev --context frontendOrigin=http://localhost:5173
```

Save the stack outputs: `HttpApiUrl`, `WebSocketUrl`, `UserPoolId`, `UserPoolClientId`, and `ExportsBucketName`.

## 5. Create the four operator accounts

In AWS Console: Cognito → User pools → `signify-control-ENV-operators` → Users → Create user.

- Create one user per person, using each person's email.
- Send an invitation or set a temporary password; never use one shared account.
- Require password change at first login.
- Do not enable self-sign-up or external identity providers.
- Remove or disable an account promptly when it should no longer have access.

CLI equivalent for an administrator:

```bash
aws cognito-idp admin-create-user --user-pool-id USER_POOL_ID --username PERSON_EMAIL --user-attributes Name=email,Value=PERSON_EMAIL Name=email_verified,Value=true
```

Do not put the four email addresses or passwords in this repository.

## 6. Create and connect the Amplify Hosting app

In AWS Console: Amplify → Create new app → Host web app → GitHub → select `Austin0914/Signify-Control-Plane` and the intended branch.

Use the repository's `amplify.yml`. Add these environment variables to the Amplify branch:

```text
VITE_AWS_REGION=ap-northeast-3
VITE_COGNITO_USER_POOL_ID=<stack output>
VITE_COGNITO_USER_POOL_CLIENT_ID=<stack output>
VITE_API_URL=<HttpApiUrl stack output>
```

These identifiers are configuration, not passwords. Do not add the device-token pepper to Amplify. Amplify Hosting only serves the React/Vite build; it does not own or implicitly deploy the backend stack.

After Amplify assigns the branch URL, update the backend CORS origin through a reviewed CDK diff/deploy using that exact HTTPS origin. Keep Amplify's password-protection feature off unless the team deliberately wants a second shared gate; Cognito remains the actual per-person login and audit identity.

## 7. Post-deployment smoke checks

1. Sign in as one of the four users and call `/api/v1/me`.
2. Verify an unauthenticated operator API request returns `401`/`403`.
3. Create a pairing code, redeem it once, then verify a second redemption fails.
4. Verify `/device/v1/config/latest` rejects a missing or revoked device bearer token.
5. Connect one Unity device, wait for hello + authoritative snapshot, then issue `request_snapshot`.
6. Confirm the Web console does not label Accepted or Deferred as Activated.
7. Disconnect/reconnect and confirm only non-terminal, unexpired commands are replayed in sequence.
8. Check CloudWatch alarms and logs contain no bearer token, pairing code, email, or full request headers.

Unity Editor E2E belongs to Plan 09. Vision Pro device, XR lifecycle, soak and release sign-off belong to Plan 10.

## 8. Rollback and recovery

- Web regression: use Amplify's previous successful build, without changing backend state.
- Lambda/API regression: deploy the previously reviewed Git commit through CDK.
- Config regression: select an immutable revision, create a rollback draft, validate it, and publish it as a new revision. Never rewrite an old revision.
- DynamoDB data issue: stop mutations, inspect CloudTrail/CloudWatch, then use point-in-time recovery into a new table. Do not overwrite the affected table in place.
- Compromised device credential: revoke it, fence its active connection, and issue a new single-use pairing code.

## Information still needed before operator access and hosting

- The four operator email addresses, supplied directly in Cognito or a secure channel.
- Which branch maps to `dev` and which branch or release tag maps to `demo`.
- The final Amplify domain after the app is connected, for exact CORS configuration.
- A least-privilege SSO/deployment role to replace account-root access.
- Explicit approval for Amplify setup, user creation and any future `demo` deployment. The completed `dev` backend approval does not imply those actions.
