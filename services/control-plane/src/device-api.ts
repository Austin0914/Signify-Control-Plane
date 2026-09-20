import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { ddb, env, nowIso, opaqueToken, tokenHash, unixAfter } from "./aws.js";
import { json, parseJson } from "./http.js";

const PROJECT_ID = "default";

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath;
    if (method === "POST" && path === "/device/v1/pairing/redeem") return redeem(parseJson(event.body));
    if (method === "GET" && path === "/device/v1/config/latest") return latest();
    return json(404, { code: "not_found" });
  } catch (error) {
    console.error("device_api_error", error);
    return json(error instanceof SyntaxError ? 400 : 500, { code: error instanceof SyntaxError ? "invalid_json" : "internal_error" });
  }
};

async function redeem(input: unknown) {
  const pairingCode = String((input as { pairingCode?: unknown })?.pairingCode ?? "");
  if (!pairingCode) return json(400, { code: "pairing_code_required" });
  const pairingHash = await tokenHash(pairingCode);
  const result = await ddb.send(new GetCommand({ TableName: env("IDENTITY_TABLE"), Key: { tokenHash: pairingHash }, ConsistentRead: true }));
  const pairing = result.Item;
  if (!pairing || pairing.entityType !== "pairing" || Number(pairing.expiresAt) <= Math.floor(Date.now() / 1000)) return json(401, { code: "pairing_invalid_or_expired" });
  const credential = opaqueToken();
  const credentialId = randomUUID();
  const expiresAt = unixAfter(30 * 86400);
  try {
    await ddb.send(new UpdateCommand({
      TableName: env("IDENTITY_TABLE"), Key: { tokenHash: pairingHash },
      UpdateExpression: "SET consumedAt = :now, credentialId = :credentialId",
      ConditionExpression: "attribute_not_exists(consumedAt) AND expiresAt > :epoch",
      ExpressionAttributeValues: { ":now": nowIso(), ":credentialId": credentialId, ":epoch": Math.floor(Date.now() / 1000) },
    }));
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return json(409, { code: "pairing_already_consumed" });
    throw error;
  }
  await ddb.send(new PutCommand({ TableName: env("IDENTITY_TABLE"), Item: {
    tokenHash: await tokenHash(credential), entityType: "device_credential", credentialId, projectId: pairing.projectId,
    deviceId: pairing.deviceId, issuedAt: nowIso(), expiresAt, revokedAt: null,
  }, ConditionExpression: "attribute_not_exists(tokenHash)" }));
  const older = await ddb.send(new ScanCommand({
    TableName: env("IDENTITY_TABLE"), FilterExpression: "entityType = :type AND deviceId = :device AND credentialId <> :current",
    ExpressionAttributeValues: { ":type": "device_credential", ":device": pairing.deviceId, ":current": credentialId },
  }));
  for (const item of older.Items ?? []) {
    await ddb.send(new UpdateCommand({ TableName: env("IDENTITY_TABLE"), Key: { tokenHash: item.tokenHash }, UpdateExpression: "SET revokedAt = :now", ExpressionAttributeValues: { ":now": nowIso() } }));
  }
  await ddb.send(new PutCommand({ TableName: env("LIVE_TABLE"), Item: {
    projectId: PROJECT_ID, sortKey: `DEVICE#${pairing.deviceId}`, entityType: "device", deviceId: pairing.deviceId,
    credentialId, ready: false, lastSeenAt: null,
  } }));
  return json(201, { deviceId: pairing.deviceId, credential, expiresAt });
}

async function latest() {
  const result = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "LATEST" } }));
  if (!result.Item) return json(404, { code: "config_not_published" });
  return json(200, result.Item.config, { etag: `\"revision-${result.Item.revision}\"` });
}

export const authorizer = async (event: { headers?: Record<string, string | undefined>; identitySource?: string[] }) => {
  const raw = event.headers?.authorization ?? event.headers?.Authorization ?? event.identitySource?.[0] ?? "";
  const token = raw.replace(/^Bearer\s+/i, "");
  if (!token) return { isAuthorized: false };
  const result = await ddb.send(new GetCommand({ TableName: env("IDENTITY_TABLE"), Key: { tokenHash: await tokenHash(token) }, ConsistentRead: true }));
  const item = result.Item;
  const valid = item?.entityType === "device_credential" && !item.revokedAt && Number(item.expiresAt) > Math.floor(Date.now() / 1000);
  return valid
    ? { isAuthorized: true, context: { projectId: String(item.projectId), deviceId: String(item.deviceId), credentialId: String(item.credentialId) } }
    : { isAuthorized: false };
};

export const websocketAuthorizer = async (event: { headers?: Record<string, string | undefined>; methodArn: string }) => {
  const raw = event.headers?.authorization ?? event.headers?.Authorization ?? "";
  const token = raw.replace(/^Bearer\s+/i, "");
  let item: Record<string, unknown> | undefined;
  if (token) {
    const response = await ddb.send(new GetCommand({ TableName: env("IDENTITY_TABLE"), Key: { tokenHash: await tokenHash(token) }, ConsistentRead: true }));
    item = response.Item;
  }
  const valid = item?.entityType === "device_credential" && !item.revokedAt && Number(item.expiresAt) > Math.floor(Date.now() / 1000);
  return {
    principalId: valid ? String(item?.credentialId) : "unauthorized",
    policyDocument: { Version: "2012-10-17", Statement: [{ Action: "execute-api:Invoke", Effect: valid ? "Allow" : "Deny", Resource: event.methodArn }] },
    context: valid ? { projectId: String(item?.projectId), deviceId: String(item?.deviceId), credentialId: String(item?.credentialId) } : {},
  };
};

// Imported by future rotation/revocation routes; explicit deletion is intentionally not used for auditability.
void DeleteCommand;
