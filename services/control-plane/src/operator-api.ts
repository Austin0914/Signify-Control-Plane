import { randomUUID } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { GetCommand, PutCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { serverCommandSchema, sessionConfigSchema, MAX_COMMAND_TTL_SECONDS, PROTOCOL_VERSION } from "@signify/contracts";
import { commandDigest } from "@signify/contracts/digest";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ddb, env, nowIso, opaqueToken, tokenHash, unixAfter } from "./aws.js";
import { actorFromClaims, json, parseJson } from "./http.js";

const PROJECT_ID = "default";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    const auth = (event.requestContext as unknown as { authorizer?: { jwt?: { claims?: Record<string, string> } } }).authorizer;
    const actor = actorFromClaims(auth?.jwt?.claims);

    if (method === "GET" && path === "/api/v1/me") return json(200, { subject: actor, role: "operator" });
    if (method === "GET" && path === `/api/v1/projects/${PROJECT_ID}`) return json(200, { projectId: PROJECT_ID });
    if (method === "GET" && path === `/api/v1/projects/${PROJECT_ID}/config/latest`) return getLatestConfig();
    if (method === "GET" && path === `/api/v1/projects/${PROJECT_ID}/config/draft`) return getDraft();
    if (method === "PUT" && path === `/api/v1/projects/${PROJECT_ID}/config/draft`) return putDraft(event.headers["if-match"], parseJson(event.body), actor);
    if (method === "POST" && path === `/api/v1/projects/${PROJECT_ID}/config/validate`) return validateConfig(parseJson(event.body));
    if (method === "POST" && path === `/api/v1/projects/${PROJECT_ID}/config/publish`) return publishDraft(event.headers["idempotency-key"], actor);
    if (method === "GET" && path === `/api/v1/projects/${PROJECT_ID}/config/revisions`) return listRevisions();
    if (method === "POST" && path === `/api/v1/projects/${PROJECT_ID}/config/rollback`) return rollback(parseJson(event.body), actor);
    if (method === "GET" && path === `/api/v1/projects/${PROJECT_ID}/devices`) return listDevices();
    if (method === "POST" && path === `/api/v1/projects/${PROJECT_ID}/pairing-codes`) return createPairingCode(parseJson(event.body), actor);
    if (method === "POST" && path === `/api/v1/projects/${PROJECT_ID}/commands`) return createCommand(parseJson(event.body), event.headers["idempotency-key"], actor);
    if (method === "POST" && path === `/api/v1/projects/${PROJECT_ID}/research-exports`) return createResearchExport(parseJson(event.body), actor);

    const revokeMatch = path.match(/^\/api\/v1\/projects\/default\/devices\/([^/]+)\/revoke$/);
    if (method === "POST" && revokeMatch) return revokeDevice(decodeURIComponent(revokeMatch[1]!), actor);

    const commandMatch = path.match(/^\/api\/v1\/projects\/default\/commands\/([^/]+)$/);
    if (method === "GET" && commandMatch) return getCommand(decodeURIComponent(commandMatch[1]!));
    return json(404, { code: "not_found" });
  } catch (error) {
    console.error("operator_api_error", error);
    if (error instanceof SyntaxError) return json(400, { code: "invalid_json" });
    return json(500, { code: "internal_error" });
  }
};

async function getLatestConfig() {
  const response = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "LATEST" } }));
  if (!response.Item) return json(404, { code: "config_not_published" });
  return json(200, response.Item.config, { etag: `\"revision-${response.Item.revision}\"` });
}

async function getDraft() {
  const response = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "DRAFT" } }));
  if (!response.Item) return json(404, { code: "draft_not_found" });
  return json(200, { config: response.Item.config, draftVersion: response.Item.draftVersion, basePublishedRevision: response.Item.basePublishedRevision }, { etag: `\"draft-${response.Item.draftVersion}\"` });
}

async function putDraft(ifMatch: string | undefined, input: unknown, actor: string) {
  const parsed = sessionConfigSchema.safeParse(input);
  if (!parsed.success) return json(422, { code: "invalid_config", issues: parsed.error.issues });
  const expected = Number(ifMatch?.replace(/[^0-9]/g, "") || "0");
  const latest = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "LATEST" }, ConsistentRead: true }));
  const basePublishedRevision = Number(latest.Item?.revision ?? 0);
  try {
    const result = await ddb.send(new UpdateCommand({
      TableName: env("CONFIG_TABLE"),
      Key: { projectId: PROJECT_ID, sortKey: "DRAFT" },
      UpdateExpression: "SET #config = :config, draftVersion = if_not_exists(draftVersion, :zero) + :one, basePublishedRevision = if_not_exists(basePublishedRevision, :base), updatedAt = :now, updatedBy = :actor REMOVE publishedDraftVersion",
      ConditionExpression: "attribute_not_exists(draftVersion) OR draftVersion = :expected",
      ExpressionAttributeNames: { "#config": "config" },
      ExpressionAttributeValues: { ":config": parsed.data, ":zero": 0, ":one": 1, ":expected": expected, ":base": basePublishedRevision, ":now": nowIso(), ":actor": actor },
      ReturnValues: "ALL_NEW",
    }));
    await audit("config.draft_saved", actor, "config/draft", { draftVersion: result.Attributes?.draftVersion });
    return json(200, { config: result.Attributes?.config, draftVersion: result.Attributes?.draftVersion, basePublishedRevision: result.Attributes?.basePublishedRevision }, { etag: `\"draft-${result.Attributes?.draftVersion}\"` });
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return json(412, { code: "draft_conflict" });
    throw error;
  }
}

function validateConfig(input: unknown) {
  const parsed = sessionConfigSchema.safeParse(input);
  return parsed.success ? json(200, { valid: true }) : json(422, { valid: false, issues: parsed.error.issues });
}

async function publishDraft(idempotencyKey: string | undefined, actor: string) {
  if (!idempotencyKey) return json(400, { code: "idempotency_key_required" });
  const draft = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "DRAFT" } }));
  const parsed = sessionConfigSchema.safeParse(draft.Item?.config);
  if (!parsed.success) return json(409, { code: "valid_draft_required" });
  const draftVersion = Number(draft.Item?.draftVersion);
  const basePublishedRevision = Number(draft.Item?.basePublishedRevision ?? 0);
  let revision = 0;
  let published = false;
  const timestamp = nowIso();
  for (let attempt = 0; attempt < 5 && !published; attempt += 1) {
    const counter = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "COUNTER" }, ConsistentRead: true }));
    const previous = Number(counter.Item?.nextRevision ?? 0);
    revision = previous + 1;
    const config = { ...parsed.data, configRevision: revision };
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "COUNTER" }, UpdateExpression: "SET nextRevision = :next", ConditionExpression: previous === 0 ? "attribute_not_exists(nextRevision)" : "nextRevision = :previous", ExpressionAttributeValues: previous === 0 ? { ":next": revision } : { ":next": revision, ":previous": previous } } },
        { Put: { TableName: env("CONFIG_TABLE"), Item: { projectId: PROJECT_ID, sortKey: `REV#${String(revision).padStart(12, "0")}`, revision, config, publishedAt: timestamp, publishedBy: actor } } },
        { Put: { TableName: env("CONFIG_TABLE"), Item: { projectId: PROJECT_ID, sortKey: "LATEST", revision, config, publishedAt: timestamp, publishedBy: actor } } },
        { Put: { TableName: env("CONFIG_TABLE"), Item: { projectId: PROJECT_ID, sortKey: `IDEMP#PUBLISH#${idempotencyKey}`, revision, draftVersion, expiresAt: unixAfter(86400) }, ConditionExpression: "attribute_not_exists(projectId)" } },
        { Update: { TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "DRAFT" }, UpdateExpression: "SET basePublishedRevision = :revision, publishedDraftVersion = :draftVersion", ConditionExpression: "draftVersion = :draftVersion AND basePublishedRevision = :base AND (attribute_not_exists(publishedDraftVersion) OR publishedDraftVersion <> :draftVersion)", ExpressionAttributeValues: { ":revision": revision, ":draftVersion": draftVersion, ":base": basePublishedRevision } } },
      ] }));
      published = true;
    } catch (error) {
      if ((error as { name?: string }).name === "TransactionCanceledException") {
        const prior = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `IDEMP#PUBLISH#${idempotencyKey}` }, ConsistentRead: true }));
        if (prior.Item) return Number(prior.Item.draftVersion) === draftVersion
          ? json(200, { revision: prior.Item.revision, replayed: true })
          : json(409, { code: "idempotency_key_reused_with_different_draft" });
        const currentDraft = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "DRAFT" }, ConsistentRead: true }));
        if (Number(currentDraft.Item?.publishedDraftVersion) === Number(currentDraft.Item?.draftVersion)) return json(409, { code: "draft_already_published" });
        if (Number(currentDraft.Item?.draftVersion) !== draftVersion || Number(currentDraft.Item?.basePublishedRevision ?? 0) !== basePublishedRevision) return json(409, { code: "draft_or_base_changed" });
        continue;
      }
      throw error;
    }
  }
  if (!published) return json(409, { code: "publish_concurrency_exhausted" });
  await audit("config.published", actor, `config/revision/${revision}`, { revision });
  return json(201, { revision, replayed: false });
}

async function listRevisions() {
  const result = await ddb.send(new QueryCommand({
    TableName: env("CONFIG_TABLE"), KeyConditionExpression: "projectId = :p AND begins_with(sortKey, :prefix)",
    ExpressionAttributeValues: { ":p": PROJECT_ID, ":prefix": "REV#" }, ScanIndexForward: false, Limit: 50,
  }));
  return json(200, { items: result.Items ?? [] });
}

async function rollback(input: unknown, actor: string) {
  const body = input as { revision?: unknown; expectedDraftVersion?: unknown };
  const revision = Number(body.revision);
  const expectedDraftVersion = Number(body.expectedDraftVersion);
  if (!Number.isInteger(revision) || revision < 1) return json(400, { code: "invalid_revision" });
  if (!Number.isInteger(expectedDraftVersion) || expectedDraftVersion < 0) return json(400, { code: "expected_draft_version_required" });
  const source = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `REV#${String(revision).padStart(12, "0")}` } }));
  if (!source.Item) return json(404, { code: "revision_not_found" });
  const latest = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "LATEST" }, ConsistentRead: true }));
  try {
    await ddb.send(new UpdateCommand({
      TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "DRAFT" },
      UpdateExpression: "SET #config = :config, draftVersion = :next, basePublishedRevision = :base, updatedAt = :now, updatedBy = :actor, rollbackSourceRevision = :revision REMOVE publishedDraftVersion",
      ConditionExpression: "(attribute_not_exists(draftVersion) AND :expected = :zero) OR draftVersion = :expected",
      ExpressionAttributeNames: { "#config": "config" },
      ExpressionAttributeValues: { ":config": source.Item.config, ":next": expectedDraftVersion + 1, ":base": Number(latest.Item?.revision ?? 0), ":now": nowIso(), ":actor": actor, ":revision": revision, ":expected": expectedDraftVersion, ":zero": 0 },
    }));
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return json(412, { code: "draft_conflict" });
    throw error;
  }
  await audit("config.rollback_draft_created", actor, "config/draft", { rollbackSourceRevision: revision });
  return json(200, { draftVersion: expectedDraftVersion + 1, rollbackSourceRevision: revision, note: "Rollback creates a draft; publish is a separate guarded action." });
}

async function listDevices() {
  const result = await ddb.send(new ScanCommand({ TableName: env("LIVE_TABLE"), FilterExpression: "entityType = :type", ExpressionAttributeValues: { ":type": "device" }, Limit: 100 }));
  return json(200, { items: (result.Items ?? []).map((item) => ({ ...item, ready: Boolean(item.ready) && lastSeenIsFresh(item.lastSeenAt), credentialHash: undefined })) });
}

async function createPairingCode(input: unknown, actor: string) {
  const deviceId = String((input as { deviceId?: unknown })?.deviceId ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(deviceId)) return json(400, { code: "invalid_device_id" });
  const code = opaqueToken(12);
  const expiresAt = unixAfter(300);
  await ddb.send(new PutCommand({ TableName: env("IDENTITY_TABLE"), Item: { tokenHash: await tokenHash(code), entityType: "pairing", projectId: PROJECT_ID, deviceId, createdBy: actor, createdAt: nowIso(), expiresAt }, ConditionExpression: "attribute_not_exists(tokenHash)" }));
  await audit("device.pairing_code_created", actor, `device/${deviceId}`, { expiresAt });
  return json(201, { pairingCode: code, deviceId, expiresAt });
}

async function createCommand(input: unknown, idempotencyKey: string | undefined, actor: string) {
  if (!idempotencyKey) return json(400, { code: "idempotency_key_required" });
  const request = input as { deviceId?: unknown; sessionId?: unknown; configRevision?: unknown; commandType?: unknown; payload?: unknown; expectedDeviceStateRevision?: unknown };
  const deviceId = String(request.deviceId ?? "");
  const live = await ddb.send(new GetCommand({ TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${deviceId}` } }));
  if (!live.Item?.ready || !lastSeenIsFresh(live.Item.lastSeenAt) || !live.Item.gatewayConnectionId || !live.Item.protocolConnectionId) return json(409, { code: "device_not_ready" });
  if (Number(request.expectedDeviceStateRevision) !== Number(live.Item.snapshot?.deviceStateRevision)) return json(409, { code: "stale_device_state", snapshot: live.Item.snapshot });
  const commandId = randomUUID();
  const issuedAt = nowIso();
  const expiresAt = new Date(Date.now() + MAX_COMMAND_TTL_SECONDS * 1000).toISOString();
  let authoritativePayload = request.payload;
  if (request.commandType === "force_judgment") {
    const active = live.Item.snapshot?.activeJudgment;
    const outcome = (request.payload as { outcome?: unknown } | undefined)?.outcome;
    if (!active || (outcome !== "correct" && outcome !== "wrong")) return json(409, { code: "active_judgment_required" });
    authoritativePayload = { sectionInstanceId: active.sectionInstanceId, attemptId: active.attemptId, outcome };
  }
  if (request.commandType === "advance_subsection") {
    const learnWord = live.Item.snapshot?.learnWord;
    if (!learnWord || learnWord.phaseTransitioning) return json(409, { code: "stable_learn_word_phase_required" });
    authoritativePayload = { expectedPhase: learnWord.phase, expectedPhaseEpoch: learnWord.phaseEpoch };
  }
  const candidate = {
    protocolVersion: PROTOCOL_VERSION, messageType: "command", sessionId: String(live.Item.snapshot.sessionId), configRevision: Number(live.Item.snapshot.configRevision),
    deviceId, connectionId: live.Item.protocolConnectionId, commandId, serverSequence: 1, issuedAt, expiresAt,
    commandType: request.commandType, payload: authoritativePayload,
  };
  const validation = serverCommandSchema.safeParse(candidate);
  if (!validation.success) return json(422, { code: "invalid_command", issues: validation.error.issues });
  const digest = commandDigest(validation.data);
  let serverSequence = 0;
  let queued = false;
  let commandType = "";
  for (let attempt = 0; attempt < 5 && !queued; attempt += 1) {
    const counter = await ddb.send(new GetCommand({ TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `SEQUENCE#${deviceId}` }, ConsistentRead: true }));
    const previous = Number(counter.Item?.nextServerSequence ?? 0);
    serverSequence = previous + 1;
    const parsed = serverCommandSchema.parse({ ...candidate, serverSequence });
    commandType = parsed.commandType;
    try {
      await ddb.send(new TransactWriteCommand({ TransactItems: [
        { Update: { TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `SEQUENCE#${deviceId}` }, UpdateExpression: "SET nextServerSequence = :next", ConditionExpression: previous === 0 ? "attribute_not_exists(nextServerSequence)" : "nextServerSequence = :previous", ExpressionAttributeValues: previous === 0 ? { ":next": serverSequence } : { ":next": serverSequence, ":previous": previous } } },
        { ConditionCheck: { TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${deviceId}` }, ConditionExpression: "ready = :true AND gatewayConnectionId = :gateway AND protocolConnectionId = :protocol AND deviceStateRevision = :state", ExpressionAttributeValues: { ":true": true, ":gateway": live.Item.gatewayConnectionId, ":protocol": live.Item.protocolConnectionId, ":state": Number(request.expectedDeviceStateRevision) } } },
        { Put: { TableName: env("LIVE_TABLE"), Item: { projectId: PROJECT_ID, sortKey: `COMMAND#${deviceId}#${String(serverSequence).padStart(12, "0")}`, entityType: "command", status: "queued", command: parsed, actor, createdAt: issuedAt, expiresAtEpoch: unixAfter(90 * 86400) } } },
        { Put: { TableName: env("LIVE_TABLE"), Item: { projectId: PROJECT_ID, sortKey: `COMMAND_ID#${commandId}`, entityType: "command_lookup", commandId, deviceId, serverSequence, expiresAtEpoch: unixAfter(90 * 86400) }, ConditionExpression: "attribute_not_exists(projectId)" } },
        { Put: { TableName: env("LIVE_TABLE"), Item: { projectId: PROJECT_ID, sortKey: `IDEMP#COMMAND#${idempotencyKey}`, entityType: "idempotency", commandId, deviceId, serverSequence, digest, expiresAtEpoch: unixAfter(86400) }, ConditionExpression: "attribute_not_exists(projectId)" } },
      ] }));
      queued = true;
    } catch (error) {
      if ((error as { name?: string }).name === "TransactionCanceledException") {
        const prior = await ddb.send(new GetCommand({ TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `IDEMP#COMMAND#${idempotencyKey}` }, ConsistentRead: true }));
        if (prior.Item) return prior.Item.digest === digest
          ? json(202, { commandId: prior.Item.commandId, serverSequence: prior.Item.serverSequence, replayed: true })
          : json(409, { code: "idempotency_key_reused_with_different_command" });
        const current = await ddb.send(new GetCommand({ TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${deviceId}` }, ConsistentRead: true }));
        if (!current.Item?.ready || current.Item.gatewayConnectionId !== live.Item.gatewayConnectionId || Number(current.Item.deviceStateRevision) !== Number(request.expectedDeviceStateRevision)) return json(409, { code: "device_state_changed", snapshot: current.Item?.snapshot });
        continue;
      }
      throw error;
    }
  }
  if (!queued) return json(409, { code: "command_concurrency_exhausted" });
  await audit("command.queued", actor, `device/${deviceId}/command/${commandId}`, { commandType, serverSequence });
  return json(202, { commandId, serverSequence, status: "queued", replayed: false });
}

async function getCommand(commandId: string) {
  const lookup = await ddb.send(new GetCommand({ TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `COMMAND_ID#${commandId}` } }));
  if (!lookup.Item) return json(404, { code: "command_not_found" });
  const result = await ddb.send(new GetCommand({ TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `COMMAND#${lookup.Item.deviceId}#${String(lookup.Item.serverSequence).padStart(12, "0")}` } }));
  const item = result.Item;
  return item ? json(200, item) : json(404, { code: "command_not_found" });
}

async function revokeDevice(deviceId: string, actor: string) {
  const credentials = await ddb.send(new ScanCommand({
    TableName: env("IDENTITY_TABLE"), FilterExpression: "entityType = :type AND deviceId = :device",
    ExpressionAttributeValues: { ":type": "device_credential", ":device": deviceId },
  }));
  const revokedAt = nowIso();
  for (const credential of credentials.Items ?? []) {
    await ddb.send(new UpdateCommand({
      TableName: env("IDENTITY_TABLE"), Key: { tokenHash: credential.tokenHash },
      UpdateExpression: "SET revokedAt = :now", ExpressionAttributeValues: { ":now": revokedAt },
    }));
  }
  await ddb.send(new UpdateCommand({
    TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${deviceId}` },
    UpdateExpression: "SET ready = :false, revokedAt = :now REMOVE gatewayConnectionId, protocolConnectionId",
    ExpressionAttributeValues: { ":false": false, ":now": revokedAt },
  }));
  await audit("device.credentials_revoked", actor, `device/${deviceId}`, { credentialCount: credentials.Count ?? 0 });
  return json(200, { deviceId, revokedAt, credentialCount: credentials.Count ?? 0 });
}

async function createResearchExport(input: unknown, actor: string) {
  const format = (input as { format?: unknown })?.format;
  if (format !== "json" && format !== "csv") return json(400, { code: "format_must_be_json_or_csv" });
  const result = await ddb.send(new ScanCommand({
    TableName: env("LIVE_TABLE"), FilterExpression: "entityType IN (:command, :snapshot)",
    ExpressionAttributeValues: { ":command": "command", ":snapshot": "snapshot" }, Limit: 1000,
  }));
  const rows = (result.Items ?? []).map((item) => item.entityType === "snapshot"
    ? { kind: "snapshot", deviceId: item.deviceId, receivedAt: item.receivedAt, snapshot: item.snapshot }
    : { kind: "command", createdAt: item.createdAt, status: item.status, command: item.command, ingress: item.ingress, terminal: item.terminal });
  const body = format === "json"
    ? JSON.stringify({ schemaVersion: 1, exportedAt: nowIso(), items: rows }, null, 2)
    : ["kind,timestamp,deviceId,status,messageType,commandId", ...rows.map((row) => {
        const command = row.command as Record<string, unknown> | undefined;
        const snapshot = row.snapshot as Record<string, unknown> | undefined;
        return [row.kind, row.createdAt ?? row.receivedAt ?? "", command?.deviceId ?? snapshot?.deviceId ?? "", row.status ?? "", command?.commandType ?? snapshot?.messageType ?? "", command?.commandId ?? ""].map(csvCell).join(",");
      })].join("\n");
  const key = `exports/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${format}`;
  const client = new S3Client({});
  await client.send(new PutObjectCommand({ Bucket: env("EXPORTS_BUCKET"), Key: key, Body: body, ContentType: format === "json" ? "application/json" : "text/csv" }));
  const downloadUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: env("EXPORTS_BUCKET"), Key: key }), { expiresIn: 900 });
  await audit("research_export.created", actor, key, { format, itemCount: rows.length });
  return json(201, { format, itemCount: rows.length, downloadUrl, downloadExpiresInSeconds: 900, storageRetentionDays: 7 });
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function lastSeenIsFresh(value: unknown): boolean {
  const staleSeconds = Number(process.env.HEARTBEAT_STALE_SECONDS ?? "45");
  const timestamp = Date.parse(String(value ?? ""));
  return Number.isFinite(timestamp) && Date.now() - timestamp <= staleSeconds * 1000;
}

async function audit(action: string, actor: string, target: string, detail: Record<string, unknown>) {
  try {
    const at = nowIso();
    await ddb.send(new PutCommand({ TableName: env("LIVE_TABLE"), Item: {
      projectId: PROJECT_ID, sortKey: `AUDIT#${at}#${randomUUID()}`, entityType: "audit", action, actor, target, detail, at,
      expiresAtEpoch: unixAfter(90 * 86400),
    } }));
  } catch (error) {
    console.error("audit_write_failed", { action, actor, target, error });
  }
}
