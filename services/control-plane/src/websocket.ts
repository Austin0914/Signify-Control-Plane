import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { deviceInboundMessageSchema, heartbeatAckSchema, serverHelloSchema } from "@signify/contracts";
import { ddb, env, nowIso, unixAfter } from "./aws.js";

const PROJECT_ID = "default";

function apiClient(domainName: string, stage: string) {
  return new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
}

export const connect: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const gatewayConnectionId = event.requestContext.connectionId;
  const context = (event.requestContext as unknown as { authorizer?: Record<string, string> }).authorizer;
  const deviceId = context?.deviceId;
  if (!deviceId) return { statusCode: 401 };
  await ddb.send(new UpdateCommand({
    TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${deviceId}` },
    UpdateExpression: "SET gatewayConnectionId = :gateway, connectedAt = :now, lastSeenAt = :now, ready = :false",
    ExpressionAttributeValues: { ":gateway": gatewayConnectionId, ":now": nowIso(), ":false": false },
  }));
  await ddb.send(new PutCommand({ TableName: env("LIVE_TABLE"), Item: {
    projectId: PROJECT_ID, sortKey: `CONNECTION#${gatewayConnectionId}`, entityType: "connection", deviceId,
    gatewayConnectionId, connectedAt: nowIso(), expiresAtEpoch: unixAfter(7 * 86400),
  } }));
  return { statusCode: 200 };
};

export const disconnect: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const gatewayConnectionId = event.requestContext.connectionId;
  const deviceId = String((event.requestContext as unknown as { authorizer?: Record<string, string> }).authorizer?.deviceId ?? "");
  if (deviceId) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${deviceId}` },
        UpdateExpression: "SET ready = :false, disconnectedAt = :now REMOVE gatewayConnectionId",
        ConditionExpression: "gatewayConnectionId = :gateway",
        ExpressionAttributeValues: { ":false": false, ":now": nowIso(), ":gateway": gatewayConnectionId },
      }));
    } catch (error) {
      if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
    }
  }
  return { statusCode: 200 };
};

export const message: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const parsed = deviceInboundMessageSchema.safeParse(JSON.parse(event.body ?? "{}"));
  if (!parsed.success) return { statusCode: 400, body: JSON.stringify({ code: "invalid_protocol_message" }) };
  const incoming = parsed.data;
  const gatewayConnectionId = event.requestContext.connectionId;
  const device = await ddb.send(new GetCommand({ TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${incoming.deviceId}` }, ConsistentRead: true }));
  if (device.Item?.gatewayConnectionId !== gatewayConnectionId) return { statusCode: 409, body: JSON.stringify({ code: "connection_fenced" }) };
  if (incoming.messageType !== "client_hello" && device.Item?.protocolConnectionId !== incoming.connectionId) return { statusCode: 409, body: JSON.stringify({ code: "protocol_connection_fenced" }) };
  if (incoming.messageType !== "client_hello" && device.Item?.sessionId !== incoming.sessionId) return { statusCode: 409, body: JSON.stringify({ code: "session_fenced" }) };

  if (incoming.messageType === "client_hello") await onHello(event.requestContext.domainName, event.requestContext.stage, gatewayConnectionId, incoming);
  else if (incoming.messageType === "device_snapshot") await onSnapshot(event.requestContext.domainName, event.requestContext.stage, gatewayConnectionId, incoming);
  else if (incoming.messageType === "heartbeat") await onHeartbeat(event.requestContext.domainName, event.requestContext.stage, gatewayConnectionId, incoming);
  else if (incoming.messageType === "command_ack" || incoming.messageType === "command_nack") await onIngress(incoming);
  else if (incoming.messageType === "command_result" || incoming.messageType === "judgment_result") await onTerminal(incoming);
  return { statusCode: 200 };
};

async function onHello(domain: string, stage: string, gatewayConnectionId: string, hello: Extract<ReturnType<typeof deviceInboundMessageSchema.parse>, { messageType: "client_hello" }>) {
  await ddb.send(new UpdateCommand({
    TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${hello.deviceId}` },
    UpdateExpression: "SET protocolConnectionId = :protocol, sessionId = :session, configRevision = :revision, deviceStateRevision = :state, capabilities = :capabilities, ready = :false, lastSeenAt = :now",
    ConditionExpression: "gatewayConnectionId = :gateway",
    ExpressionAttributeValues: { ":protocol": hello.connectionId, ":session": hello.sessionId, ":revision": hello.configRevision, ":state": hello.deviceStateRevision, ":capabilities": hello.capabilities, ":false": false, ":now": nowIso(), ":gateway": gatewayConnectionId },
  }));
  const latest = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "LATEST" } }));
  await post(domain, stage, gatewayConnectionId, serverHelloSchema.parse({
    protocolVersion: 1, messageType: "server_hello", sessionId: hello.sessionId, configRevision: Number(latest.Item?.revision ?? 0),
    deviceId: hello.deviceId, connectionId: hello.connectionId, serverTime: nowIso(),
  }));
}

async function onSnapshot(domain: string, stage: string, gatewayConnectionId: string, snapshot: Extract<ReturnType<typeof deviceInboundMessageSchema.parse>, { messageType: "device_snapshot" }>) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${snapshot.deviceId}` },
      UpdateExpression: "SET snapshot = :snapshot, ready = :true, lastSeenAt = :now, deviceStateRevision = :state",
      ConditionExpression: "protocolConnectionId = :connection AND sessionId = :session AND (attribute_not_exists(deviceStateRevision) OR deviceStateRevision <= :state)",
      ExpressionAttributeValues: { ":snapshot": snapshot, ":true": true, ":now": nowIso(), ":state": snapshot.deviceStateRevision, ":connection": snapshot.connectionId, ":session": snapshot.sessionId },
    }));
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return;
    throw error;
  }
  await replayPending(domain, stage, gatewayConnectionId, snapshot.deviceId, snapshot.connectionId);
  await ddb.send(new PutCommand({ TableName: env("LIVE_TABLE"), Item: {
    projectId: PROJECT_ID, sortKey: `SNAPSHOT#${snapshot.deviceId}#${String(snapshot.deviceEventSequence).padStart(16, "0")}`,
    entityType: "snapshot", deviceId: snapshot.deviceId, snapshot, receivedAt: nowIso(), expiresAtEpoch: unixAfter(14 * 86400),
  } }));
}

async function onHeartbeat(domain: string, stage: string, gatewayConnectionId: string, heartbeat: Extract<ReturnType<typeof deviceInboundMessageSchema.parse>, { messageType: "heartbeat" }>) {
  await ddb.send(new UpdateCommand({
    TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${heartbeat.deviceId}` },
    UpdateExpression: "SET lastSeenAt = :now, telemetry = :telemetry",
    ConditionExpression: "protocolConnectionId = :connection",
    ExpressionAttributeValues: { ":now": nowIso(), ":connection": heartbeat.connectionId, ":telemetry": heartbeat },
  }));
  const latest = await ddb.send(new GetCommand({ TableName: env("CONFIG_TABLE"), Key: { projectId: PROJECT_ID, sortKey: "LATEST" } }));
  await post(domain, stage, gatewayConnectionId, heartbeatAckSchema.parse({ protocolVersion: 1, messageType: "heartbeat_ack", sessionId: heartbeat.sessionId, configRevision: Number(latest.Item?.revision ?? 0), deviceId: heartbeat.deviceId, connectionId: heartbeat.connectionId }));
}

async function onIngress(message: Extract<ReturnType<typeof deviceInboundMessageSchema.parse>, { messageType: "command_ack" | "command_nack" }>) {
  const status = message.messageType === "command_nack" ? "rejected" : message.ingressDisposition;
  const allowed = status === "accepted" ? ["queued", "sent", "deferred", "accepted"] : status === "deferred" ? ["queued", "sent", "deferred"] : ["queued", "sent", "rejected"];
  await updateCommand(message.deviceId, message.serverSequence, "SET #status = :status, ingress = :message, updatedAt = :now", { ":status": status, ":message": message, ":now": nowIso() }, allowed);
}

async function onTerminal(message: Extract<ReturnType<typeof deviceInboundMessageSchema.parse>, { messageType: "command_result" | "judgment_result" }>) {
  const status = message.messageType === "command_result" ? message.result : `judged_${message.outcome}`;
  await updateCommand(message.deviceId, await sequenceForCommand(message.deviceId, message.commandId), "SET #status = :status, terminal = :message, updatedAt = :now", { ":status": status, ":message": message, ":now": nowIso() }, ["queued", "sent", "accepted", "deferred", status]);
}

async function sequenceForCommand(deviceId: string, commandId: string): Promise<number> {
  const result = await ddb.send(new GetCommand({ TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `COMMAND_ID#${commandId}` }, ConsistentRead: true }));
  if (!result.Item || result.Item.deviceId !== deviceId) throw new Error("command_not_found");
  return Number(result.Item.serverSequence);
}

async function updateCommand(deviceId: string, sequence: number, expression: string, values: Record<string, unknown>, allowedCurrent: string[]) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `COMMAND#${deviceId}#${String(sequence).padStart(12, "0")}` },
      UpdateExpression: expression,
      ConditionExpression: "attribute_exists(projectId) AND contains(:allowedCurrent, #status)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ...values, ":allowedCurrent": allowedCurrent },
    }));
  } catch (error) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") throw error;
  }
}

async function replayPending(domain: string, stage: string, gatewayConnectionId: string, deviceId: string, protocolConnectionId: string) {
  const result = await ddb.send(new QueryCommand({
    TableName: env("LIVE_TABLE"), KeyConditionExpression: "projectId = :p AND begins_with(sortKey, :prefix)",
    ExpressionAttributeValues: { ":p": PROJECT_ID, ":prefix": `COMMAND#${deviceId}#` }, ScanIndexForward: true, Limit: 100,
  }));
  for (const item of result.Items ?? []) {
    if (["activated", "superseded", "failed", "rejected", "expired", "judged_correct", "judged_wrong"].includes(String(item.status))) continue;
    if (Date.parse(String(item.command.expiresAt)) <= Date.now()) {
      await updateCommand(deviceId, Number(item.command.serverSequence), "SET #status = :status, updatedAt = :now", { ":status": "expired", ":now": nowIso() }, ["queued", "sent", "expired"]);
      continue;
    }
    await post(domain, stage, gatewayConnectionId, { ...item.command, connectionId: protocolConnectionId });
  }
}

async function post(domain: string, stage: string, connectionId: string, payload: unknown) {
  await apiClient(domain, stage).send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(payload)) }));
}

export const delivery = async (event: { Records: Array<{ eventName?: string; dynamodb?: { NewImage?: Record<string, unknown> } }> }) => {
  for (const record of event.Records) {
    if (record.eventName !== "INSERT" || !record.dynamodb?.NewImage) continue;
    const item = unmarshall(record.dynamodb.NewImage as Parameters<typeof unmarshall>[0]);
    if (item.entityType !== "command") continue;
    const command = item.command as Record<string, unknown>;
    const deviceId = String(command.deviceId);
    const device = await ddb.send(new GetCommand({ TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${deviceId}` }, ConsistentRead: true }));
    if (!device.Item?.ready || !device.Item.gatewayConnectionId || device.Item.protocolConnectionId !== command.connectionId) continue;
    try {
      const endpoint = env("WS_MANAGEMENT_ENDPOINT");
      const client = new ApiGatewayManagementApiClient({ endpoint });
      await client.send(new PostToConnectionCommand({ ConnectionId: device.Item.gatewayConnectionId, Data: Buffer.from(JSON.stringify(command)) }));
      await updateCommand(deviceId, Number(command.serverSequence), "SET #status = :status, sentAt = :now, updatedAt = :now", { ":status": "sent", ":now": nowIso() }, ["queued", "sent"]);
    } catch (error) {
      if (error instanceof GoneException || (error as { name?: string }).name === "GoneException") {
        await ddb.send(new UpdateCommand({
          TableName: env("LIVE_TABLE"), Key: { projectId: PROJECT_ID, sortKey: `DEVICE#${deviceId}` },
          UpdateExpression: "SET ready = :false, disconnectedAt = :now REMOVE gatewayConnectionId",
          ExpressionAttributeValues: { ":false": false, ":now": nowIso() },
        }));
        continue;
      }
      throw error;
    }
  }
};

void PutCommand;
void GoneException;
