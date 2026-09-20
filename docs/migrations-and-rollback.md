# Migration and rollback policy

The MVP starts at schema version 1. DynamoDB items carry an `entityType`; wire payloads carry `protocolVersion`, and configs carry `schemaVersion`. Changes follow expand → migrate/backfill → switch readers/writers → contract. A release must not remove a field while the previously deployed Lambda or Unity build still requires it.

CDK diffs are reviewed per environment. `demo` stateful resources use retain-on-delete; `dev` is disposable. DynamoDB point-in-time recovery is enabled. Restores go to a new table and are validated before traffic is switched; never restore destructively over the affected table.

Application rollback redeploys the previous compatible commit. Config rollback copies an immutable prior revision into a guarded draft and publishes a new revision. It never rewrites revision history. Web rollback uses an earlier Amplify build and does not mutate backend data.

Before any destructive schema cleanup, record the migration ID, owner, affected entity types, forward/backward compatibility window, validation query, rollback trigger and restored-table cutover plan. No destructive migration is included in the first slice.
