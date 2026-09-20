import { createHash } from "node:crypto";
import type { ServerCommand } from "./index.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function commandDigest(command: Pick<ServerCommand,
  "protocolVersion" | "sessionId" | "configRevision" | "deviceId" | "commandType" | "payload"
>): string {
  const semantic = {
    protocolVersion: command.protocolVersion,
    sessionId: command.sessionId,
    configRevision: command.configRevision,
    deviceId: command.deviceId,
    commandType: command.commandType,
    payload: command.payload,
  };
  return createHash("sha256").update(canonicalJson(semantic), "utf8").digest("hex");
}
